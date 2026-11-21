// 端末内で SenseVoice-Small（FunASR / FunAudioLLM）による文字起こしを行う Web Worker
// モデル: sherpa-onnx が ONNX 化した SenseVoiceSmall（int8・約240MB、中国語/日本語/英語/広東語/韓国語）
// 前処理（Kaldi 互換 fbank → LFR → CMVN）と CTC 貪欲デコードをここで実装する。
import * as ort from './lib/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = new URL('./lib/', import.meta.url).href;
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4)) : 1;
ort.env.wasm.numThreads = THREADS;

const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const FILES = { model: 'model.int8.onnx', tokens: 'tokens.txt' };
const CACHE_NAME = 'sensevoice-cache';
// キャッシュのキーは配布元によらず Hugging Face の URL に統一（配布元を切り替えても再ダウンロード不要）
const canonicalUrl = (file) => `https://huggingface.co/${REPO}/resolve/main/${file}`;
const sourceUrl = (host, file) => `${host.replace(/\/$/, '')}/${REPO}/resolve/main/${file}`;

/* ---------- モデル取得（キャッシュ優先・進捗通知） ---------- */
async function fetchCached(host, file) {
  const cache = await caches.open(CACHE_NAME);
  const key = canonicalUrl(file);
  const hit = await cache.match(key);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(sourceUrl(host, file));
  if (!res.ok) throw new Error(`モデルの取得に失敗しました（${res.status} ${file}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    self.postMessage({ type: 'progress', file, loaded, total });
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  await cache.put(key, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
  return buf;
}

/* ---------- Kaldi 互換 fbank（80次元・25ms/10ms・hamming・snip_edges） ---------- */
const SR = 16000, FRAME = 400, SHIFT = 160, NFFT = 512, NMEL = 80;
const HAMMING = Float32Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const MEL = (() => {
  const mel = (f) => 1127 * Math.log(1 + f / 700);
  const lo = mel(20), hi = mel(SR / 2), delta = (hi - lo) / (NMEL + 1);
  const binW = SR / NFFT;
  const banks = [];
  for (let b = 0; b < NMEL; b++) {
    const left = lo + b * delta, center = left + delta, right = center + delta;
    const w = new Float32Array(NFFT / 2);
    for (let i = 0; i < NFFT / 2; i++) {
      const m = mel(binW * i);
      if (m > left && m < right) w[i] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center);
    }
    banks.push(w);
  }
  return banks;
})();
// 512点 FFT 用のビット反転・回転因子
const REV = (() => { const r = new Uint16Array(NFFT); const bits = Math.log2(NFFT); for (let i = 0; i < NFFT; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
const COS = Float64Array.from({ length: NFFT / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / NFFT));
const SIN = Float64Array.from({ length: NFFT / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / NFFT));

function powerSpectrum(frame, re, im, out) {
  re.fill(0); im.fill(0);
  for (let i = 0; i < FRAME; i++) re[REV[i]] = frame[i];
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let s = 0; s < NFFT; s += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], d = SIN[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * d, ti = re[b] * d + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let k = 0; k < NFFT / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
}

function fbank(samples) {
  const n = samples.length < FRAME ? 0 : 1 + Math.floor((samples.length - FRAME) / SHIFT);
  const feats = new Float32Array(n * NMEL);
  const frame = new Float64Array(FRAME), re = new Float64Array(NFFT), im = new Float64Array(NFFT), pw = new Float64Array(NFFT / 2);
  for (let t = 0; t < n; t++) {
    let mean = 0;
    for (let i = 0; i < FRAME; i++) { frame[i] = samples[t * SHIFT + i] * 32768; mean += frame[i]; }
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) frame[i] -= mean;
    for (let i = FRAME - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
    frame[0] -= 0.97 * frame[0];
    for (let i = 0; i < FRAME; i++) frame[i] *= HAMMING[i];
    powerSpectrum(frame, re, im, pw);
    for (let b = 0; b < NMEL; b++) {
      const w = MEL[b];
      let e = 0;
      for (let k = 0; k < NFFT / 2; k++) if (w[k]) e += w[k] * pw[k];
      feats[t * NMEL + b] = Math.log(Math.max(e, 1.1920928955078125e-7));
    }
  }
  return { feats, frames: n };
}

/* ---------- LFR（7フレーム結合・6フレーム間隔）+ CMVN ---------- */
function lfrCmvn({ feats, frames }, m, n, negMean, invStd) {
  const pad = (m - 1) >> 1;
  const T = Math.ceil(frames / n);
  const D = NMEL * m;
  const out = new Float32Array(T * D);
  const row = (idx) => Math.min(Math.max(idx - pad, 0), frames - 1); // 先頭は最初のフレーム、末尾は最後のフレームで埋める
  for (let i = 0; i < T; i++) {
    for (let j = 0; j < m; j++) {
      const src = row(i * n + j) * NMEL;
      const dst = i * D + j * NMEL;
      for (let k = 0; k < NMEL; k++) {
        const d = j * NMEL + k;
        out[dst + k] = (feats[src + k] + negMean[d]) * invStd[d];
      }
    }
  }
  return { x: out, T, D };
}

/* ---------- モデル ---------- */
let session = null, meta = null, tokens = null;

async function load(host) {
  if (session) return;
  const [modelBytes, tokBytes] = await Promise.all([fetchCached(host, FILES.model), fetchCached(host, FILES.tokens)]);
  tokens = [];
  for (const line of new TextDecoder().decode(tokBytes).split('\n')) {
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    tokens[Number(line.slice(sp + 1))] = line.slice(0, sp);
  }
  const md = await readMetadata(modelBytes);
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  meta = {
    lfrM: Number(md.lfr_window_size || 7),
    lfrN: Number(md.lfr_window_shift || 6),
    negMean: Float32Array.from(md.neg_mean.split(',').map(Number)),
    invStd: Float32Array.from(md.inv_stddev.split(',').map(Number)),
    lang: { ja: Number(md.lang_ja), zh: Number(md.lang_zh), en: Number(md.lang_en), auto: Number(md.lang_auto || 0) },
    withItn: Number(md.with_itn || 14),
  };
}

/*
 * ONNX のメタデータ（metadata_props）を protobuf から直接読む。
 * onnxruntime-web からは取得できないため、ModelProto のフィールド14（metadata_props）だけを走査する。
 */
async function readMetadata(bytes) {
  const out = {};
  let p = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const dec = new TextDecoder();
  while (p < bytes.length) {
    const key = varint(); const field = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) varint();
    else if (wt === 1) p += 8;
    else if (wt === 5) p += 4;
    else if (wt === 2) {
      const len = varint(); const end = p + len;
      if (field === 14) {
        let k = '', v = '';
        while (p < end) {
          const kk = varint(); const l = varint();
          const s = dec.decode(bytes.subarray(p, p + l)); p += l;
          if ((kk >> 3) === 1) k = s; else if ((kk >> 3) === 2) v = s;
        }
        out[k] = v;
      }
      p = end;
    } else break;
  }
  return out;
}

async function recognize(samples, lang) {
  // 長い音声は 30 秒ごとに分けて処理
  const CHUNK = SR * 30;
  let text = '';
  for (let s = 0; s < samples.length; s += CHUNK) {
    const part = samples.subarray(s, Math.min(samples.length, s + CHUNK));
    if (part.length < FRAME) continue;
    const { x, T, D } = lfrCmvn(fbank(part), meta.lfrM, meta.lfrN, meta.negMean, meta.invStd);
    const feeds = {
      x: new ort.Tensor('float32', x, [1, T, D]),
      x_length: new ort.Tensor('int32', Int32Array.of(T), [1]),
      language: new ort.Tensor('int32', Int32Array.of(meta.lang[lang] ?? meta.lang.auto), [1]),
      text_norm: new ort.Tensor('int32', Int32Array.of(meta.withItn), [1]),
    };
    const { logits } = await session.run(feeds);
    const [, steps, vocab] = logits.dims;
    const data = logits.data;
    let prev = -1;
    for (let t = 0; t < steps; t++) {
      let best = 0, bestV = -Infinity;
      const base = t * vocab;
      for (let v = 0; v < vocab; v++) { const val = data[base + v]; if (val > bestV) { bestV = val; best = v; } }
      // 先頭4ステップは 言語/感情/イベント/ITN のタグ。0 は blank
      if (t >= 4 && best !== 0 && best !== prev) text += tokens[best] || '';
      prev = best;
    }
  }
  // 単語区切り記号（▁）を空白に戻し、日本語・中国語の文字同士の間の空白は除く
  const CJK = '\u3000-\u30ff\u3400-\u9fff\uff00-\uffef';
  return text.replace(/▁/g, ' ').replace(/<\|[^|]*\|>/g, '')
    .replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1')
    .replace(/\s+/g, ' ').trim();
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'load') {
        await load(msg.host);
        self.postMessage({ type: 'ready', model: msg.model, mode: msg.mode, label: `CPU ${THREADS}スレッド` });
      } else if (msg.type === 'transcribe') {
        const wasLoaded = !!session;
        await load(msg.host);
        if (!wasLoaded) self.postMessage({ type: 'ready', model: msg.model, mode: msg.mode, label: `CPU ${THREADS}スレッド` });
        const t0 = performance.now();
        const text = await recognize(msg.audio, msg.lang);
        self.postMessage({ type: 'result', id: msg.id, text, ms: Math.round(performance.now() - t0), label: `CPU ${THREADS}スレッド` });
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  });
};

// テスト用に内部関数を公開
self.__sv = { fbank, lfrCmvn, readMetadata };
