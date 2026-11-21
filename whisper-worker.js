// 端末内で Whisper による文字起こしを行う Web Worker（transformers.js / ONNX Runtime Web・CPU）
import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;  // モデルは Hugging Face（またはミラー）から取得し、ブラウザ内にキャッシュする
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./lib/', import.meta.url).href;
// クロスオリジン分離されていれば（sw.js がヘッダーを付与）複数スレッドで並列計算する
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4)) : 1;
env.backends.onnx.wasm.numThreads = THREADS;
const LABEL = `CPU ${THREADS}スレッド`;

let asr = null;
let loadedModel = null;

async function load(model) {
  if (asr && loadedModel === model) return false;
  if (asr) { try { await asr.dispose(); } catch { /* ignore */ } asr = null; loadedModel = null; }
  asr = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p) => {
      if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  loadedModel = model;
  return true;
}

// 1件ずつ順番に処理する
let chain = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    if (msg.host) env.remoteHost = `${msg.host.replace(/\/$/, '')}/`; // 配布元（中国国内ではミラー）
    // モデルの読み込み（失敗は loadError として音声の失敗と区別する）
    try {
      const loadedNow = await load(msg.model);
      if (loadedNow || msg.type === 'load') self.postMessage({ type: 'ready', model: msg.model, label: LABEL });
    } catch (err) {
      self.postMessage({ type: 'loadError', id: msg.id, message: String((err && err.message) || err) });
      return;
    }
    if (msg.type !== 'transcribe') return;
    try {
      const t0 = performance.now();
      const out = await asr(msg.audio, {
        language: msg.lang === 'zh' ? 'chinese' : 'japanese',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = (Array.isArray(out) ? out.map((o) => o.text).join('') : out.text) || '';
      self.postMessage({ type: 'result', id: msg.id, text: text.trim(), ms: Math.round(performance.now() - t0), label: LABEL });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  });
};
