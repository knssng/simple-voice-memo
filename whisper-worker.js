// 端末内で Whisper による文字起こしを行う Web Worker（transformers.js / ONNX Runtime Web）
import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;  // モデルは Hugging Face から取得し、ブラウザ内にキャッシュする
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./lib/', import.meta.url).href;
// GitHub Pages では SharedArrayBuffer が使えないためシングルスレッドで動かす
env.backends.onnx.wasm.numThreads = 1;

let asr = null;
let loadedModel = null;
let loading = null;

async function load(model) {
  if (asr && loadedModel === model) return asr;
  if (loading && loading.model === model) return loading.promise;
  if (asr) { try { await asr.dispose(); } catch { /* ignore */ } asr = null; loadedModel = null; }

  const promise = pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p) => {
      if (p.status === 'progress') {
        self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      }
    },
  }).then((pipe) => {
    asr = pipe;
    loadedModel = model;
    loading = null;
    self.postMessage({ type: 'ready', model });
    return pipe;
  }).catch((err) => {
    loading = null;
    throw err;
  });
  loading = { model, promise };
  return promise;
}

// 1件ずつ順番に処理する
let chain = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'load') {
        await load(msg.model);
      } else if (msg.type === 'transcribe') {
        const pipe = await load(msg.model);
        const t0 = performance.now();
        const out = await pipe(msg.audio, {
          language: 'japanese',
          task: 'transcribe',
          chunk_length_s: 30,
          stride_length_s: 5,
        });
        const text = (Array.isArray(out) ? out.map((o) => o.text).join('') : out.text) || '';
        self.postMessage({ type: 'result', id: msg.id, text: text.trim(), ms: Math.round(performance.now() - t0) });
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  });
};
