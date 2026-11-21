// 端末内で Whisper による文字起こしを行う Web Worker（transformers.js / ONNX Runtime Web）
import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;  // モデルは Hugging Face から取得し、ブラウザ内にキャッシュする
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./lib/', import.meta.url).href;
// クロスオリジン分離されていれば（sw.js がヘッダーを付与）複数スレッドで並列計算する
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4)) : 1;
env.backends.onnx.wasm.numThreads = THREADS;

// 処理方式ごとのモデル精度（ファイル）
// cpu   : int8 量子化（約250MB / small）
// webgpu: エンコーダ fp16（GPUが半精度対応時）または q4、デコーダ q4（約300〜410MB / small）
async function config(mode) {
  if (mode === 'webgpu') {
    if (!navigator.gpu) throw new Error('この端末・ブラウザはWebGPUに対応していません');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('GPUを取得できませんでした');
    const f16 = adapter.features.has('shader-f16');
    return { device: 'webgpu', dtype: { encoder_model: f16 ? 'fp16' : 'q4', decoder_model_merged: 'q4' }, label: `GPU${f16 ? '' : '(q4)'}` };
  }
  return { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, label: `CPU ${THREADS}スレッド` };
}

let asr = null;
let loadedKey = null;
let gpuFailed = false; // 一度GPUで失敗したら、このセッション中はCPUで処理する
let loadedLabel = '';

async function loadExact(model, mode) {
  const key = `${model}|${mode}`;
  if (asr && loadedKey === key) return;
  if (asr) { try { await asr.dispose(); } catch { /* ignore */ } asr = null; loadedKey = null; }
  const cfg = await config(mode);
  asr = await pipeline('automatic-speech-recognition', model, {
    device: cfg.device,
    dtype: cfg.dtype,
    progress_callback: (p) => {
      if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  loadedKey = key;
  loadedLabel = cfg.label;
}

/** GPU指定で失敗したら CPU に切り替えて読み込む */
async function load(model, mode) {
  const requested = mode;
  if (mode === 'webgpu' && gpuFailed) mode = 'cpu';
  if (asr && loadedKey === `${model}|${mode}`) return;
  if (mode !== requested) {
    await loadExact(model, mode);
    self.postMessage({ type: 'ready', model, mode, requested, label: loadedLabel });
    return;
  }
  try {
    await loadExact(model, mode);
    self.postMessage({ type: 'ready', model, mode, label: loadedLabel });
  } catch (err) {
    if (mode !== 'webgpu') throw err;
    gpuFailed = true;
    self.postMessage({ type: 'fallback', message: String((err && err.message) || err) });
    await loadExact(model, 'cpu');
    self.postMessage({ type: 'ready', model, mode: 'cpu', requested: 'webgpu', label: loadedLabel });
  }
}

// 1件ずつ順番に処理する
let chain = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.host) env.remoteHost = `${msg.host.replace(/\/$/, '')}/`; // 配布元（中国国内ではミラー）
      if (msg.type === 'load') {
        await load(msg.model, msg.mode);
      } else if (msg.type === 'transcribe') {
        await load(msg.model, msg.mode);
        const opts = { language: msg.lang === 'zh' ? 'chinese' : 'japanese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
        let t0 = performance.now();
        let out;
        try {
          out = await asr(msg.audio, opts);
        } catch (err) {
          // GPUで文字起こし中に失敗した場合は CPU に切り替えてやり直す
          if (!loadedKey || !loadedKey.endsWith('|webgpu')) throw err;
          gpuFailed = true;
          self.postMessage({ type: 'fallback', message: String((err && err.message) || err) });
          await loadExact(msg.model, 'cpu');
          self.postMessage({ type: 'ready', model: msg.model, mode: 'cpu', requested: 'webgpu', label: loadedLabel });
          t0 = performance.now();
          out = await asr(msg.audio, opts);
        }
        const text = (Array.isArray(out) ? out.map((o) => o.text).join('') : out.text) || '';
        self.postMessage({ type: 'result', id: msg.id, text: text.trim(), ms: Math.round(performance.now() - t0), label: loadedLabel });
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  });
};
