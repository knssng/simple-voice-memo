'use strict';

/*
 * 走行評価メモ
 * 種類を選ぶ → 録音ボタンを押している間だけ録音 → 離すと保存し、端末内の Whisper で文字起こし
 * （音声認識に Safari の Web Speech API は使わない。録音と同時に使うと iPhone で失敗するため）
 */

const APP_VERSION = 'v14';

/* =========================================================
 * 設定
 * ======================================================= */
const SETTINGS_KEY = 'voicememo.settings.v1';
const MODELS = {
  'sensevoice-small': { engine: 'sensevoice', sizeMB: 240, label: 'SenseVoice（FunASR・約240MB）', note: '推奨。中国語・日本語とも高精度で高速（数秒の音声を1秒前後）。CPUで処理' },
  'onnx-community/whisper-small': { engine: 'whisper', sizeMB: 250, label: 'Whisper small（OpenAI・約250MB）', note: '高精度。1件あたり数秒〜十数秒' },
  'onnx-community/whisper-base': { engine: 'whisper', sizeMB: 77, label: 'Whisper base（OpenAI・約80MB）', note: '軽量だが誤変換が多い' },
};
const DEFAULT_MODEL = 'sensevoice-small';
// モデルの配布元（中国国内では huggingface.co に接続できないためミラーを選ぶ）
const HOSTS = {
  hf: { label: 'Hugging Face', note: '日本など', url: 'https://huggingface.co' },
  mirror: { label: 'hf-mirror.com', note: '中国国内向けミラー', url: 'https://hf-mirror.com' },
};
const LANGS = { ja: { label: '日本語', short: '日', csv: '日本語' }, zh: { label: '中文', short: '中', csv: '中国語' } };
const engineOf = (model) => (MODELS[model] || MODELS[DEFAULT_MODEL]).engine;
const DEFAULT_SETTINGS = {
  vehicleId: '',
  evaluator: '',
  categories: ['Take Over', 'ナビルート無視', '交通ルール無視', '車両挙動', '乗り心地', 'その他'],
  model: DEFAULT_MODEL,
  host: 'hf',
  lang: 'ja',   // 録音時の言語（録音ボタン横でワンタップ切替）
  useGps: true,
  keepAwake: true,
};
const MIN_RECORD_MS = 400; // これより短い押下は誤タップとして破棄

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const merged = { ...DEFAULT_SETTINGS, ...s };
    const cats = Array.isArray(s.categories) ? s.categories : DEFAULT_SETTINGS.categories;
    merged.categories = Array.from({ length: 6 }, (_, i) => (cats[i] ?? '').toString());
    if (!MODELS[merged.model]) merged.model = DEFAULT_MODEL;
    delete merged.accel; // 旧版の CPU/GPU 設定（廃止）
    if (!HOSTS[merged.host]) merged.host = 'hf';
    if (!LANGS[merged.lang]) merged.lang = 'ja';
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

let settings = loadSettings();

/* =========================================================
 * IndexedDB（記録 + 音声Blob）
 * ======================================================= */
const db = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('voicememo', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('memos', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  return {
    // awaitを挟まず、同一トランザクション内のコールバックで音声も保存する
    addMemo(memo, audioBlob) {
      return tx(['memos', 'audio'], 'readwrite', (t) => new Promise((resolve) => {
        const req = t.objectStore('memos').add(memo);
        req.onsuccess = () => {
          if (audioBlob) t.objectStore('audio').put({ id: req.result, blob: audioBlob });
          resolve(req.result);
        };
      }));
    },
    updateMemo(memo) {
      return tx(['memos'], 'readwrite', (t) => { t.objectStore('memos').put(memo); });
    },
    getMemo(id) {
      return tx(['memos'], 'readonly', (t) => reqP(t.objectStore('memos').get(id)));
    },
    deleteMemo(id) {
      return tx(['memos', 'audio'], 'readwrite', (t) => {
        t.objectStore('memos').delete(id);
        t.objectStore('audio').delete(id);
      });
    },
    allMemos() {
      return tx(['memos'], 'readonly', (t) => reqP(t.objectStore('memos').getAll()));
    },
    async getAudio(id) {
      const r = await tx(['audio'], 'readonly', (t) => reqP(t.objectStore('audio').get(id)));
      return r ? r.blob : null;
    },
    clear() {
      return tx(['memos', 'audio'], 'readwrite', (t) => {
        t.objectStore('memos').clear();
        t.objectStore('audio').clear();
      });
    },
  };
})();

/* =========================================================
 * ユーティリティ
 * ======================================================= */
const $ = (sel) => document.querySelector(sel);
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function sanitize(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
function audioExt(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}
function audioFileName(m) {
  if (!m.hasAudio) return '';
  return `memo_${pad(m.id, 4)}_${fmtStamp(new Date(m.start))}_${sanitize(m.category)}.${audioExt(m.audioType)}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* =========================================================
 * GPS
 * ======================================================= */
const gps = {
  last: null,
  watchId: null,
  start() {
    if (!settings.useGps || !('geolocation' in navigator) || this.watchId !== null) return;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => { this.last = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() }; },
      () => { /* 拒否・取得失敗は無視（空欄で記録） */ },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  },
  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.last = null;
  },
  /** 直近60秒以内の測位があれば返す */
  current() {
    return this.last && Date.now() - this.last.t < 60000 ? { lat: this.last.lat, lng: this.last.lng } : null;
  },
};

/* =========================================================
 * 画面消灯防止
 * ======================================================= */
let wakeLock = null;
async function requestWakeLock() {
  if (!settings.keepAwake || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 非対応・拒否は無視 */ }
}

/* =========================================================
 * マイク：録音ごとに取得・解放を繰り返すとiOSで不安定になるため、記録画面にいる間は使い回す
 * ======================================================= */
const mic = {
  stream: null,
  pending: null,
  live() {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  },
  get() {
    if (this.live()) return Promise.resolve(this.stream);
    if (this.pending) return this.pending;
    this.pending = navigator.mediaDevices.getUserMedia({ audio: true })
      .then((st) => { this.stream = st; return st; })
      .catch((err) => {
        if (err.name === 'NotAllowedError') toast('マイクの使用が許可されていません（設定 > アプリ > Safari > マイク）', 4000);
        throw err;
      })
      .finally(() => { this.pending = null; });
    return this.pending;
  },
  release() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  },
};

/* =========================================================
 * 録音（押している間だけ）
 * ======================================================= */
const recorder = {
  active: null,

  start(category) {
    if (this.active) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('このブラウザは録音に対応していません'); return; }
    const s = { category, lang: settings.lang, start: new Date(), end: null, gps: gps.current(), chunks: [], mr: null, done: null, stopRequested: false };
    this.active = s;
    ui.recordingStarted();

    if (settings.useGps && !s.gps && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (p) => { if (!s.gps) s.gps = { lat: p.coords.latitude, lng: p.coords.longitude }; },
        () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
      );
    }
    // マイク準備済みなら即開始、未準備なら取得後に開始（指を離すのを待たせない）
    if (mic.live()) this.begin(s, mic.stream);
    else mic.get().then((st) => { if (!s.stopRequested) this.begin(s, st); }).catch(() => {});
  },

  begin(s, stream) {
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      .find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) s.chunks.push(e.data); };
    s.done = new Promise((res) => { mr.onstop = res; });
    // timesliceを指定しない：iOS Safariでは分割データを結合すると再生できないファイルになることがある
    mr.start();
    s.mr = mr;
  },

  async stop() {
    const s = this.active;
    if (!s || s.stopRequested) return;
    s.stopRequested = true;
    s.end = new Date();
    this.active = null;
    ui.recordingStopped();

    if (s.mr && s.mr.state !== 'inactive') s.mr.stop();
    if (s.done) await Promise.race([s.done, sleep(2500)]);

    const durMs = s.end - s.start;
    if (durMs < MIN_RECORD_MS) { toast('録音ボタンは押し続けてください'); return; }
    const blob = s.chunks.length ? new Blob(s.chunks, { type: s.mr.mimeType || s.chunks[0].type }) : null;
    if (!blob) { toast('録音できませんでした。もう一度お試しください', 3000); }

    const memo = {
      vehicleId: settings.vehicleId,
      evaluator: settings.evaluator,
      category: s.category,
      lang: s.lang,
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      durationSec: Math.round(durMs / 100) / 10,
      lat: s.gps ? s.gps.lat : null,
      lng: s.gps ? s.gps.lng : null,
      text: '',
      status: blob ? 'pending' : 'noaudio',
      hasAudio: !!blob,
      audioType: blob ? blob.type : '',
      audioSize: blob ? blob.size : 0,
    };
    try {
      const id = await db.addMemo(memo, blob);
      memo.id = id;
      // 連続録音の妨げにならないよう、保存時はポップアップを出さず「直前の記録」欄を光らせるだけにする
      if (blob) transcriber.enqueue(id);
      await ui.renderRecent();
      ui.flashRecent();
      list.refreshRow(memo);
    } catch (err) {
      toast('保存に失敗しました: ' + (err && err.message), 4000);
    }
  },
};

/* =========================================================
 * 文字起こし（端末内 Whisper / Web Worker）
 * ======================================================= */
const transcriber = {
  worker: null,
  workerEngine: null,
  queue: [],        // 待ちの memo id
  current: null,    // 処理中の memo id
  state: 'idle',    // idle（未読込）| loading（読込中）| ready（準備OK）| error（モデル取得失敗）
  progress: {},     // file -> {loaded,total}
  loadedKey: null,  // 読み込み済みのモデル
  fromCache: false, // 端末から読み込み中か（false ならダウンロード中）
  lastError: '',
  callbacks: new Map(),

  ensureWorker() {
    const engine = engineOf(settings.model);
    if (this.worker && this.workerEngine === engine) return;
    if (this.worker) {
      // 別エンジンに切り替える：メモリ節約のため前のワーカーは終了
      this.worker.terminate();
      this.loadedKey = null;
      this.state = 'idle';
    }
    this.workerEngine = engine;
    this.worker = new Worker(engine === 'sensevoice' ? 'sensevoice-worker.js?v=12' : 'whisper-worker.js?v=12', { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'ワーカーの起動に失敗しました');
  },

  onMessage(msg) {
    if (msg.type === 'progress') {
      this.state = 'loading';
      this.progress[msg.file] = { loaded: msg.loaded, total: msg.total };
      ui.renderAsrStatus();
    } else if (msg.type === 'ready') {
      this.state = 'ready';
      this.loadedKey = msg.model;
      this.loadedLabel = msg.label;
      this.lastError = '';
      this.progress = {};
      ui.renderAsrStatus();
      if (settingsView.visible()) settingsView.render();
      this.pump(); // モデル待ちだった記録を処理
    } else if (msg.type === 'loadError') {
      this.fail(msg.message);
      const cb = this.callbacks.get(msg.id);
      this.callbacks.delete(msg.id);
      if (cb) cb(msg);
    } else if (msg.type === 'result' || msg.type === 'error') {
      const cb = this.callbacks.get(msg.id);
      this.callbacks.delete(msg.id);
      if (cb) cb(msg);
    }
  },

  /** モデルの取得・読込に失敗 */
  fail(message) {
    this.state = 'error';
    this.progress = {};
    const m = String(message || '');
    if (!navigator.onLine) this.lastError = 'オフラインのためモデルをダウンロードできません。電波のある場所で再試行してください';
    else if (/fetch|network|load failed|取得/i.test(m)) {
      this.lastError = `モデルをダウンロードできませんでした（${HOSTS[settings.host].label}）。`
        + (settings.host === 'hf' ? '中国国内では「モデルの配布元」を hf-mirror.com にしてください' : '通信状況を確認して再試行してください');
    } else this.lastError = `モデルを読み込めませんでした：${m}`;
    ui.renderAsrStatus();
    if (settingsView.visible()) settingsView.render();
  },

  loadPercent() {
    const files = Object.values(this.progress);
    const total = files.reduce((a, f) => a + (f.total || 0), 0);
    const loaded = files.reduce((a, f) => a + (f.loaded || 0), 0);
    return total ? Math.floor((loaded / total) * 100) : 0;
  },

  isReady() { return this.state === 'ready' && this.loadedKey === settings.model; },

  async preload() {
    if (this.current !== null) return; // 処理中は次の処理の開始時に読み込む
    this.ensureWorker();
    if (this.isReady() || this.state === 'loading') return;
    this.fromCache = await modelCache.isCached(settings.model);
    this.state = 'loading';
    this.progress = {};
    ui.renderAsrStatus();
    this.worker.postMessage({ type: 'load', model: settings.model, host: HOSTS[settings.host].url });
  },

  enqueue(id) {
    if (this.current === id || this.queue.includes(id)) return;
    this.queue.push(id);
    ui.renderAsrStatus();
    this.pump();
  },

  async pump() {
    // モデル取得に失敗している間は待つ（再試行で読み込めたら ready から再開）
    if (this.current !== null || !this.queue.length || this.state === 'error') return;
    const id = this.queue.shift();
    this.current = id;
    ui.renderAsrStatus();
    try {
      const memo = await db.getMemo(id);
      if (!memo) return;
      memo.status = 'transcribing';
      await db.updateMemo(memo);
      list.refreshRow(memo);

      const blob = await db.getAudio(id);
      if (!blob) throw new Error('音声が見つかりません');
      const audio = await decodeTo16k(blob);
      this.ensureWorker();
      if (!this.isReady() && this.state !== 'loading') {
        this.fromCache = await modelCache.isCached(settings.model);
        this.state = 'loading';
        this.progress = {};
        ui.renderAsrStatus();
      }
      const res = await new Promise((resolve) => {
        this.callbacks.set(id, resolve);
        this.worker.postMessage({
          type: 'transcribe', id, model: settings.model,
          host: HOSTS[settings.host].url, lang: memo.lang || 'ja', audio,
        }, [audio.buffer]);
      });
      const latest = await db.getMemo(id);
      if (!latest) return; // 処理中に削除された
      if (res.type === 'result') {
        // 手で修正済みなら上書きしない
        if (!latest.edited) latest.text = cleanTranscript(res.text);
        latest.status = 'done';
        latest.asrModel = settings.model;
        latest.asrMs = res.ms;
        latest.asrLabel = res.label;
        delete latest.asrError;
      } else if (res.type === 'loadError') {
        // 音声ではなくモデルの問題：記録は「待ち」に戻し、モデルが準備できたら処理する
        latest.status = 'pending';
        this.queue.unshift(id);
      } else {
        latest.status = 'error';
        latest.asrError = res.message;
      }
      await db.updateMemo(latest);
      list.refreshRow(latest);
      ui.renderRecent();
    } catch (err) {
      const m = await db.getMemo(id);
      if (m) { m.status = 'error'; m.asrError = String(err && err.message); await db.updateMemo(m); list.refreshRow(m); }
    } finally {
      this.current = null;
      ui.renderAsrStatus();
      this.pump();
    }
  },

  async resumePending() {
    const memos = (await db.allMemos()).sort((a, b) => a.id - b.id);
    memos.filter((m) => m.hasAudio && (m.status === 'pending' || m.status === 'transcribing')).forEach((m) => this.enqueue(m.id));
  },
};

/* モデルのキャッシュ（Whisper: 'transformers-cache' / SenseVoice: 'sensevoice-cache'） */
const modelCache = {
  async sensevoiceCached() {
    if (!('caches' in window)) return false;
    try {
      const c = await caches.open('sensevoice-cache');
      return (await c.keys()).some((r) => r.url.endsWith('model.int8.onnx'));
    } catch { return false; }
  },
  async files(model) {
    if (!('caches' in window)) return [];
    try {
      const c = await caches.open('transformers-cache');
      return (await c.keys()).filter((r) => r.url.includes(`/${model}/`));
    } catch { return []; }
  },
  async isCached(model) {
    if (engineOf(model) === 'sensevoice') return this.sensevoiceCached();
    const urls = (await this.files(model)).map((r) => r.url);
    return urls.some((u) => /encoder_model_quantized\.onnx/.test(u)) && urls.some((u) => /decoder_model_merged_quantized\.onnx/.test(u));
  },
  async remove(model) {
    if (engineOf(model) === 'sensevoice') { await caches.delete('sensevoice-cache'); return; }
    const c = await caches.open('transformers-cache');
    for (const r of await this.files(model)) await c.delete(r);
  },
  /** 旧版の GPU 用モデルファイル（fp16/q4）を削除して容量を空ける */
  async removeGpuFiles() {
    if (!('caches' in window)) return;
    try {
      const c = await caches.open('transformers-cache');
      for (const r of await c.keys()) if (/_(fp16|q4|q4f16)\.onnx$/.test(r.url)) await c.delete(r);
    } catch { /* ignore */ }
  },
};

/** 録音Blob → 16kHz モノラル Float32Array（Whisperの入力形式） */
async function decodeTo16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    ac.close().catch(() => {});
  }
}

/** Whisperが同じ語句を延々と繰り返す現象を除去 */
function cleanTranscript(t) {
  let s = (t || '').trim();
  s = s.replace(/(.{2,40}?)\1{2,}/g, '$1');
  return s;
}

/* =========================================================
 * 画面
 * ======================================================= */
const ui = {
  selected: null,
  timerId: null,

  renderMeta() {
    const parts = [];
    if (settings.vehicleId) parts.push(`車両 ${settings.vehicleId}`);
    if (settings.evaluator) parts.push(settings.evaluator);
    $('#metaInfo').textContent = parts.join(' / ') || '車両ID未設定';
  },

  renderAsrStatus() {
    const t = transcriber;
    const waiting = t.queue.length + (t.current !== null ? 1 : 0);
    const name = (MODELS[settings.model] || {}).label || '';
    let txt;
    let cls;
    let detail;
    if (t.state === 'loading') {
      txt = t.fromCache ? `モデル読込中 ${t.loadPercent()}%` : `モデルをダウンロード中 ${t.loadPercent()}%`;
      cls = 'busy';
      detail = t.fromCache ? `端末から読込中…（通信なし） ${t.loadPercent()}%` : `ダウンロード中… ${t.loadPercent()}%（Wi-Fi推奨）`;
    } else if (t.state === 'error') {
      txt = waiting ? `モデル取得失敗・${waiting}件待ち` : 'モデル取得失敗';
      cls = 'err';
      detail = `${t.lastError}`;
    } else if (t.isReady()) {
      txt = waiting ? `文字起こし中（残り${waiting}件）` : '文字起こし準備OK';
      cls = waiting ? 'busy' : 'ok';
      detail = `読込済み：${name}（${t.loadedLabel}・オフラインでも使えます）`;
    } else {
      txt = waiting ? `モデル未ダウンロード・${waiting}件待ち` : 'モデル未ダウンロード';
      cls = 'warn';
      detail = `未ダウンロード：${name}`;
    }
    const pill = $('#asrStatus');
    pill.textContent = txt;
    pill.className = `asr-pill ${cls}`;
    pill.title = detail;
    pill.hidden = false;
    const ms = $('#modelStatus');
    if (ms) {
      ms.textContent = detail;
      ms.className = `hint model-status ${cls}`;
    }
    const btn = $('#loadModel');
    if (btn) {
      btn.disabled = t.state === 'loading' || t.isReady();
      btn.textContent = t.state === 'error' ? 'モデルのダウンロードを再試行' : t.isReady() ? 'モデル読込済み' : 'モデルをダウンロード／読込';
    }
  },

  renderCategories() {
    const grid = $('#catGrid');
    grid.innerHTML = '';
    settings.categories.forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'cat-btn' + (this.selected === i ? ' selected' : '');
      b.innerHTML = '<span class="num"></span><span class="name"></span>';
      b.firstChild.textContent = i + 1;
      b.lastChild.textContent = name || `(未設定${i + 1})`;
      b.disabled = !name;
      b.addEventListener('click', () => {
        if (recorder.active) return;
        this.selected = i;
        mic.get().catch(() => {}); // 許可ダイアログを録音前に出す
        this.renderCategories();
      });
      grid.appendChild(b);
    });
    if (this.selected !== null && !settings.categories[this.selected]) this.selected = null;
    this.updateRecBtn();
  },

  updateRecBtn() {
    if (recorder.active) return;
    const btn = $('#recBtn');
    if (this.selected === null) {
      btn.disabled = true;
      $('#recLabel').textContent = '種類を選択してください';
    } else {
      btn.disabled = false;
      $('#recLabel').textContent = '押している間 録音';
    }
  },

  recordingStarted() {
    $('#recBtn').classList.add('recording');
    $('#recLabel').textContent = '録音中… 離すと停止';
    const t0 = Date.now();
    $('#recTimer').textContent = '0:00';
    this.timerId = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      $('#recTimer').textContent = `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
    }, 250);
    document.querySelectorAll('.cat-btn, .tabbar button, #langBtn').forEach((b) => { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
  },

  recordingStopped() {
    clearInterval(this.timerId);
    $('#recTimer').textContent = '';
    $('#recBtn').classList.remove('recording');
    document.querySelectorAll('.cat-btn, .tabbar button, #langBtn').forEach((b) => { b.disabled = b.dataset.wasDisabled === 'true'; });
    this.updateRecBtn();
  },

  flashRecent() {
    const el = $('#recent');
    el.classList.remove('flash');
    void el.offsetWidth; // アニメーションを再始動
    el.classList.add('flash');
  },

  async renderRecent() {
    const memos = (await db.allMemos()).sort((a, b) => b.id - a.id).slice(0, 3);
    const el = $('#recent');
    el.textContent = '';
    if (!memos.length) {
      el.textContent = '種類を選び、赤いボタンを押している間に話してください。離すと保存し、自動で文字起こしします。';
      return;
    }
    for (const m of memos) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      const head = document.createElement('span');
      head.className = 'recent-head';
      head.textContent = `${fmtTime(m.start)} ${m.category}`;
      const body = document.createElement('span');
      body.className = 'recent-text';
      body.textContent = statusText(m) || m.text || '(テキストなし)';
      row.append(head, body);
      el.appendChild(row);
    }
  },

  showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name !== 'record') mic.release(); // 再生音がスピーカーから出るように
    if (name === 'record') this.renderRecent();
    if (name === 'list') list.render(); else list.stopPlayback();
    if (name === 'settings') settingsView.render();
  },
};

function statusText(m) {
  if (m.status === 'pending') return transcriber.state === 'error' || (!transcriber.isReady() && transcriber.state !== 'loading') ? '文字起こし待ち（モデル未準備）' : '文字起こし待ち…';
  if (m.status === 'transcribing') return '文字起こし中…';
  if (m.status === 'error') return '文字起こし失敗';
  return '';
}

/* 言語切替（ワンタップ） */
function renderLang() {
  const b = $('#langBtn');
  b.textContent = LANGS[settings.lang].label;
  b.className = `lang-btn lang-${settings.lang}`;
  b.setAttribute('aria-label', `録音言語: ${LANGS[settings.lang].label}（タップで切替）`);
}
$('#langBtn').addEventListener('click', () => {
  if (recorder.active) return;
  settings.lang = settings.lang === 'ja' ? 'zh' : 'ja';
  saveSettings(settings);
  renderLang();
});

/* 録音ボタン：押下中のみ録音 */
(function bindRecButton() {
  const btn = $('#recBtn');
  btn.addEventListener('pointerdown', (e) => {
    if (btn.disabled || ui.selected === null) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    requestWakeLock();
    recorder.start(settings.categories[ui.selected]);
  });
  const end = (e) => {
    if (!recorder.active) return;
    if (e && e.cancelable) e.preventDefault();
    recorder.stop();
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('lostpointercapture', end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { end(); mic.release(); } else requestWakeLock();
  });
})();

/* =========================================================
 * 一覧
 * ======================================================= */
const list = {
  rows: new Map(),  // id -> { tr, ta, statusEl }
  urls: new Map(),  // id -> objectURL（iOSはタップ直後に再生しないとブロックされるため事前に用意）
  player: null,
  playingBtn: null,

  async render() {
    this.stopPlayback();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
    this.rows.clear();
    const memos = (await db.allMemos()).sort((a, b) => b.id - a.id);
    for (const m of memos) {
      if (!m.hasAudio) continue;
      const blob = await db.getAudio(m.id);
      if (blob) this.urls.set(m.id, URL.createObjectURL(blob));
    }
    const body = $('#memoBody');
    body.innerHTML = '';
    $('#emptyMsg').style.display = memos.length ? 'none' : 'block';
    $('#count').textContent = `${memos.length} 件`;
    for (const m of memos) body.appendChild(this.buildRow(m));
  },

  buildRow(m) {
    const tr = document.createElement('tr');
    const td = (cls, text) => {
      const c = document.createElement('td');
      if (cls) c.className = cls;
      if (text !== undefined) c.textContent = text;
      tr.appendChild(c);
      return c;
    };
    td('nowrap', m.id);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.category;
    const catCell = td('');
    catCell.appendChild(tag);
    const lg = document.createElement('div');
    lg.className = `lang-tag lang-${m.lang || 'ja'}`;
    lg.textContent = (LANGS[m.lang] || LANGS.ja).label;
    catCell.appendChild(lg);

    const tm = td('nowrap time');
    tm.innerHTML = '<div></div><div></div><div class="dur"></div>';
    tm.children[0].textContent = fmtTime(m.start);
    tm.children[1].textContent = fmtTime(m.end);
    tm.children[2].textContent = `${m.durationSec.toFixed(1)}秒`;
    const asrEl = document.createElement('div');
    asrEl.className = 'dur asr-time';
    tm.appendChild(asrEl);
    tm.title = `${fmtDateTime(m.start)} 〜 ${fmtDateTime(m.end)}`;

    const textCell = td('col-text');
    const statusEl = document.createElement('div');
    statusEl.className = 'asr-state';
    const ta = document.createElement('textarea');
    ta.addEventListener('change', async () => {
      const cur = await db.getMemo(m.id);
      if (!cur) return;
      cur.text = ta.value;
      cur.edited = true;
      await db.updateMemo(cur);
      ta.classList.add('saved');
      setTimeout(() => ta.classList.remove('saved'), 1200);
    });
    const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
    ta.addEventListener('input', fit);
    textCell.append(statusEl, ta);

    const oc = td('ops');
    const mkBtn = (label, cls, onClick) => {
      const b = document.createElement('button');
      b.className = 'icon-btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      oc.appendChild(b);
      return b;
    };
    if (m.hasAudio) {
      const pb = mkBtn('▶ 再生', '', () => this.play(m.id, pb));
      mkBtn('再変換', 'redo', async () => {
        const cur = await db.getMemo(m.id);
        if (!cur) return;
        if (cur.edited && !confirm('手で修正したテキストを文字起こし結果で上書きします。よろしいですか？')) return;
        cur.edited = false;
        cur.status = 'pending';
        await db.updateMemo(cur);
        this.refreshRow(cur);
        transcriber.enqueue(cur.id);
      });
    }
    if (m.lat != null) {
      const a = document.createElement('a');
      a.className = 'icon-btn';
      a.href = `https://maps.apple.com/?ll=${m.lat},${m.lng}&q=${encodeURIComponent(m.category)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '地図';
      oc.appendChild(a);
    }
    mkBtn('削除', 'del', async () => {
      if (!confirm(`No.${m.id}（${m.category} ${fmtTime(m.start)}）を削除しますか？`)) return;
      await db.deleteMemo(m.id);
      this.render();
    });

    this.rows.set(m.id, { tr, ta, statusEl, fit, asrEl });
    this.applyState(m);
    return tr;
  },

  applyState(m) {
    const r = this.rows.get(m.id);
    if (!r) return;
    const busy = m.status === 'pending' || m.status === 'transcribing';
    if (document.activeElement !== r.ta) r.ta.value = m.text || '';
    r.ta.placeholder = busy ? '' : '(テキストなし) タップして入力';
    r.statusEl.textContent = m.status === 'error' ? `文字起こし失敗：${m.asrError || ''}` : statusText(m);
    r.statusEl.hidden = !r.statusEl.textContent;
    r.statusEl.classList.toggle('err', m.status === 'error');
    r.asrEl.textContent = m.status === 'done' && m.asrMs ? `変換${(m.asrMs / 1000).toFixed(1)}秒` : '';
    r.asrEl.title = m.asrLabel || '';
    if (m.status === 'done' && m.asrLabel) r.asrEl.textContent += ` ${m.asrLabel.startsWith('GPU') ? 'GPU' : 'CPU'}`;
    requestAnimationFrame(r.fit);
  },

  /** 一覧表示中なら該当行だけ更新（新規なら一覧を作り直す） */
  refreshRow(m) {
    if (!$('#view-list').classList.contains('active')) return;
    if (this.rows.has(m.id)) this.applyState(m);
    else this.render();
  },

  getPlayer() {
    if (!this.player) {
      const a = document.createElement('audio');
      a.setAttribute('playsinline', '');
      a.preload = 'auto';
      a.addEventListener('ended', () => this.stopPlayback());
      a.addEventListener('error', () => { toast('この音声は再生できません'); this.stopPlayback(); });
      document.body.appendChild(a);
      this.player = a;
    }
    return this.player;
  },

  stopPlayback() {
    if (this.player) this.player.pause();
    if (this.playingBtn) this.playingBtn.textContent = '▶ 再生';
    this.playingBtn = null;
  },

  // awaitを挟まずに再生開始する（iOSのユーザー操作要件）
  play(id, btn) {
    if (this.playingBtn === btn) { this.stopPlayback(); return; }
    this.stopPlayback();
    const url = this.urls.get(id);
    if (!url) { toast('音声が見つかりません'); return; }
    const a = this.getPlayer();
    a.src = url;
    this.playingBtn = btn;
    btn.textContent = '■ 停止';
    a.play().catch((e) => { toast(`再生できません: ${e.name}`); this.stopPlayback(); });
  },
};

/* =========================================================
 * エクスポート
 * ======================================================= */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(memos) {
  const header = ['No', '車両ID', '評価者', '種類', '言語', '録音開始', '録音終了', '録音時間(秒)', '緯度', '経度', 'テキスト', '音声ファイル'];
  const rows = memos.map((m) => [
    m.id, m.vehicleId, m.evaluator, m.category, (LANGS[m.lang] || LANGS.ja).csv,
    fmtDateTime(m.start), fmtDateTime(m.end), m.durationSec.toFixed(1),
    m.lat != null ? m.lat.toFixed(6) : '', m.lng != null ? m.lng.toFixed(6) : '',
    m.text || '', audioFileName(m),
  ]);
  // Excelで文字化けしないようBOM付きUTF-8
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function deliverFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  // iPhoneでは共有シート（「ファイルに保存」/ AirDrop / メール等）を優先
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportBaseName() {
  return `voicememo_${sanitize(settings.vehicleId) || 'vehicle'}_${fmtStamp()}`;
}

async function memosForExport() {
  const memos = (await db.allMemos()).sort((a, b) => a.id - b.id);
  if (!memos.length) { toast('記録がありません'); return null; }
  const busy = memos.filter((m) => m.status === 'pending' || m.status === 'transcribing').length;
  if (busy && !confirm(`文字起こしが終わっていない記録が${busy}件あります。このまま出力しますか？`)) return null;
  return memos;
}

$('#exportCsv').addEventListener('click', async () => {
  const memos = await memosForExport();
  if (!memos) return;
  await deliverFile(new Blob([buildCsv(memos)], { type: 'text/csv' }), `${exportBaseName()}.csv`);
});

$('#exportZip').addEventListener('click', async () => {
  const memos = await memosForExport();
  if (!memos) return;
  toast('ZIPを作成中…');
  const enc = new TextEncoder();
  const files = [{ name: 'memo.csv', data: enc.encode(buildCsv(memos)), date: new Date() }];
  for (const m of memos) {
    if (!m.hasAudio) continue;
    const blob = await db.getAudio(m.id);
    if (blob) files.push({ name: audioFileName(m), data: new Uint8Array(await blob.arrayBuffer()), date: new Date(m.start) });
  }
  await deliverFile(window.MiniZip.createZip(files), `${exportBaseName()}.zip`);
});

/* =========================================================
 * 設定画面
 * ======================================================= */
const settingsView = {
  render() {
    const f = $('#settingsForm');
    f.vehicleId.value = settings.vehicleId;
    f.evaluator.value = settings.evaluator;
    f.useGps.checked = settings.useGps;
    f.keepAwake.checked = settings.keepAwake;
    const box = $('#catInputs');
    box.innerHTML = '';
    settings.categories.forEach((c, i) => {
      const l = document.createElement('label');
      l.textContent = `種類 ${i + 1}`;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.name = `cat${i}`;
      inp.maxLength = 20;
      inp.value = c;
      l.appendChild(inp);
      box.appendChild(l);
    });
    const mb = $('#modelInputs');
    mb.innerHTML = '';
    Object.entries(MODELS).forEach(([id, info]) => {
      const l = document.createElement('label');
      l.className = 'check';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'model';
      r.value = id;
      r.checked = settings.model === id;
      const span = document.createElement('span');
      span.innerHTML = '<b></b><small></small>';
      span.firstChild.textContent = info.label;
      span.lastChild.textContent = info.note;
      l.append(r, span);
      mb.appendChild(l);
      modelCache.isCached(id).then((cached) => {
        if (!cached) return;
        const tagEl = document.createElement('small');
        tagEl.className = 'cached';
        tagEl.textContent = '✓ ダウンロード済み（端末に保存）';
        span.appendChild(tagEl);
        if (id !== settings.model) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'icon-btn del small';
          del.textContent = 'このモデルを削除';
          del.addEventListener('click', async (ev) => {
            ev.preventDefault();
            if (!confirm(`${info.label} を端末から削除しますか？`)) return;
            await modelCache.remove(id);
            toast('モデルを削除しました');
            this.render();
          });
          span.appendChild(del);
        }
      });
    });
    const hb = $('#hostInputs');
    hb.innerHTML = '';
    Object.entries(HOSTS).forEach(([id, info]) => {
      const l = document.createElement('label');
      l.className = 'check';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'host';
      r.value = id;
      r.checked = settings.host === id;
      const span = document.createElement('span');
      span.innerHTML = '<b></b><small></small>';
      span.firstChild.textContent = info.label;
      span.lastChild.textContent = info.note;
      l.append(r, span);
      hb.appendChild(l);
    });
    ui.renderAsrStatus();
    this.storageInfo();
  },
  visible() { return $('#view-settings').classList.contains('active'); },
  async storageInfo() {
    // ブラウザの使用量（storage.estimate）は Safari では削除後すぐに減らないため、アプリ側で集計する
    const memos = await db.allMemos();
    const audioMB = memos.reduce((a, m) => a + (m.audioSize || 0), 0) / 1024 / 1024;
    const cachedModels = [];
    for (const [id, info] of Object.entries(MODELS)) if (await modelCache.isCached(id)) cachedModels.push(info);
    const modelMB = cachedModels.reduce((a, i) => a + i.sizeMB, 0);
    const fmt = (mb) => (mb < 10 ? mb.toFixed(1) : Math.round(mb));
    $('#storageInfo').textContent = `記録 ${memos.length} 件（音声 約${fmt(audioMB)}MB）／ モデル 約${modelMB}MB`
      + `${cachedModels.length ? `（${cachedModels.map((i) => i.label.replace(/（.*$/, '')).join('・')}）` : ''}`
      + `。削除前に必ずCSV/ZIPを出力してください。（アプリ版 ${APP_VERSION}）`;

    // 保存データが消されにくい状態かを表示
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let persisted = false;
    try { persisted = !!(navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()); } catch { /* ignore */ }
    const el = $('#persistInfo');
    el.textContent = standalone
      ? `ホーム画面から起動中：モデル・記録は端末に保持されます${persisted ? '（永続化済み）' : ''}`
      : '⚠ Safariのタブで使用中：7日間開かないとモデル・記録が自動削除されることがあります。共有ボタン→「ホーム画面に追加」から起動してください。';
    el.classList.toggle('warn', !standalone);
  },
};

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const prevModel = settings.model;
  settings = {
    vehicleId: f.vehicleId.value.trim(),
    evaluator: f.evaluator.value.trim(),
    categories: Array.from({ length: 6 }, (_, i) => f[`cat${i}`].value.trim()),
    model: f.model.value || DEFAULT_MODEL,
    host: HOSTS[f.host.value] ? f.host.value : 'hf',
    lang: settings.lang,
    useGps: f.useGps.checked,
    keepAwake: f.keepAwake.checked,
  };
  saveSettings(settings);
  if (settings.useGps) gps.start(); else gps.stop();
  ui.renderMeta();
  ui.renderCategories();
  ui.renderAsrStatus();
  const changed = settings.model !== prevModel;
  toast(changed ? '設定を保存しました。モデルを読み込み直します' : '設定を保存しました');
  if (changed) transcriber.preload();
});

$('#resetCats').addEventListener('click', () => {
  DEFAULT_SETTINGS.categories.forEach((c, i) => { $('#settingsForm')[`cat${i}`].value = c; });
  toast('初期値を入力しました。「保存」を押すと反映されます', 3000);
});

$('#loadModel').addEventListener('click', async () => {
  const cached = await modelCache.isCached(settings.model);
  toast(cached ? 'モデルを端末から読み込みます' : 'モデルをダウンロードします（Wi-Fi推奨）', 3000);
  transcriber.preload();
});

$('#clearAll').addEventListener('click', async () => {
  if (!confirm('全ての記録と音声を削除します。元に戻せません。よろしいですか？')) return;
  await db.clear();
  toast('全記録を削除しました');
  settingsView.storageInfo();
});

document.querySelectorAll('.tabbar button').forEach((b) => {
  b.addEventListener('click', () => ui.showView(b.dataset.view));
});

/* =========================================================
 * 起動
 * ======================================================= */
ui.renderMeta();
ui.renderCategories();
renderLang();
ui.renderRecent();
ui.renderAsrStatus();
gps.start();
requestWakeLock();
// 一度ダウンロード済みのモデルなら裏で読み込んでおく（キャッシュから読むので通信は発生しない）
modelCache.removeGpuFiles(); // 旧版の GPU 用ファイルを掃除
modelCache.isCached(settings.model).then((cached) => { if (cached) transcriber.preload(); });
transcriber.resumePending(); // 前回終わらなかった文字起こしを再開
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // 並列計算に必要なヘッダーは Service Worker が付与する。SW 適用前に開いた場合は開き直す（1セッション最大2回）
  if (!window.crossOriginIsolated) {
    const reloadOnce = () => {
      let n = 0;
      try { n = Number(sessionStorage.getItem('voicememo.coiReload') || 0); sessionStorage.setItem('voicememo.coiReload', String(n + 1)); } catch { n = 99; }
      if (n < 2 && !recorder.active) location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
    navigator.serviceWorker.ready.then(() => { if (navigator.serviceWorker.controller) reloadOnce(); });
  }
}
$('#asrStatus').addEventListener('click', () => { if (!recorder.active) ui.showView('settings'); });
