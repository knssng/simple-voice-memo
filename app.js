'use strict';

/*
 * 走行評価メモ
 * 種類を選ぶ → 録音ボタンを押している間だけ録音 → 離すと保存し、端末内の Whisper で文字起こし
 * （音声認識に Safari の Web Speech API は使わない。録音と同時に使うと iPhone で失敗するため）
 */

const APP_VERSION = 'v18';

/* =========================================================
 * 設定
 * ======================================================= */
const SETTINGS_KEY = 'voicememo.settings.v1';
const MODELS = {
  'sensevoice-small': { engine: 'sensevoice', sizeMB: 240, get label() { return t('modelSv'); }, get note() { return t('modelSvNote'); } },
  'onnx-community/whisper-small': { engine: 'whisper', sizeMB: 250, get label() { return t('modelWs'); }, get note() { return t('modelWsNote'); } },
  'onnx-community/whisper-base': { engine: 'whisper', sizeMB: 77, get label() { return t('modelWb'); }, get note() { return t('modelWbNote'); } },
};
const DEFAULT_MODEL = 'sensevoice-small';
// モデルの配布元（中国国内では huggingface.co に接続できないためミラーを選ぶ）
const HOSTS = {
  hf: { label: 'Hugging Face', get note() { return t('hostHfNote'); }, url: 'https://huggingface.co' },
  mirror: { label: 'hf-mirror.com', get note() { return t('hostMirrorNote'); }, url: 'https://hf-mirror.com' },
};
// 録音（文字起こし）の言語。表示言語（uiLang）とは別
const LANGS = { ja: { label: '日本語', get csv() { return t('csvLangJa'); } }, zh: { label: '中文', get csv() { return t('csvLangZh'); } } };
const engineOf = (model) => (MODELS[model] || MODELS[DEFAULT_MODEL]).engine;
const DEFAULT_SETTINGS = {
  vehicleId: '',
  evaluator: '',
  // 初回起動時の表示言語に合わせた初期値（日本語端末なら日本語、中国語端末なら中国語）
  categories: [...I18N[/^zh/i.test(navigator.language || '') ? 'zh' : 'ja'].defaultCats],
  model: DEFAULT_MODEL,
  host: 'hf',
  lang: 'ja',   // 録音時の言語（録音ボタン横でワンタップ切替）
  uiLang: /^zh/i.test(navigator.language || '') ? 'zh' : 'ja', // 表示言語
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
    if (!UI_LANGS[merged.uiLang]) merged.uiLang = DEFAULT_SETTINGS.uiLang;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

let settings = loadSettings();
uiLang = settings.uiLang;
const tr = (key, params) => t(key, params); // 変数名 t と衝突する箇所で使う別名
/** ワーカーが返す「CPU 4スレッド」等を表示言語に合わせる */
const threadLabel = (label) => { const n = /(\d+)/.exec(label || ''); return n ? t('threads', { n: n[1] }) : (label || ''); };

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
/*
 * 記録の番号：評価日（録音開始日）＋セッション番号＋セッション内の通し番号（No）
 * - 評価日が変わると、セッション番号・No とも 1 に戻る
 * - 同じ日に「全記録を削除」するとセッション番号 +1、No は 1 から
 * - 個別削除の欠番は詰めない
 * - 内部の管理キー（IndexedDB の id）は別にあり、再利用されない
 */
const SESSION_KEY = 'voicememo.session.v1';
const session = {
  /** { date: 'YYYYMMDD', no: セッション番号, nextNo: 次の No } */
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (s && s.no >= 1 && s.nextNo >= 1) return s;
    } catch { /* ignore */ }
    return { date: '', no: 1, nextNo: 1 };
  },
  save(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } },
  /** 指定日の状態（日付が変わっていればセッション1・No.1 から） */
  stateFor(date) {
    const s = this.load();
    return s.date === date ? s : { date, no: 1, nextNo: 1 };
  },
  /** 次に録音したときのセッション番号（今日の日付で判定） */
  current() { return this.stateFor(ymd(new Date())).no; },
  /** 新しい記録の番号を払い出す（評価日＝録音開始日） */
  take(start) {
    const s = this.stateFor(ymd(start));
    const no = s.nextNo;
    s.nextNo = no + 1;
    this.save(s);
    return { sessionNo: s.no, no };
  },
  /** 全記録削除時：同じ日なら次のセッションへ（別の日ならその日のセッション1） */
  /** 全記録削除後に始まるセッション番号 */
  afterClear() {
    const today = ymd(new Date());
    const s = this.load();
    return s.date === today ? s.no + 1 : 1;
  },
  next() {
    this.save({ date: ymd(new Date()), no: this.afterClear(), nextNo: 1 });
  },
  /** 番号のない旧データに番号を振り、カウンタを既存の最大値より後ろに合わせる */
  async migrate() {
    const memos = (await db.allMemos()).sort((a, b) => a.id - b.id);
    const s0 = this.load();
    if (!s0.date) {
      // v15 以前の状態には日付がない：最新の記録の日付で引き継ぐ（記録がなければ今日）
      const last = memos[memos.length - 1];
      s0.date = ymd(last ? last.start : new Date());
      this.save(s0);
    }
    for (const m of memos) {
      if (m.no) continue;
      Object.assign(m, this.take(m.start));
      await db.updateMemo(m);
    }
    const s = this.load();
    const maxNo = Math.max(0, ...memos.filter((m) => ymd(m.start) === s.date && m.sessionNo === s.no).map((m) => m.no));
    if (s.nextNo <= maxNo) { s.nextNo = maxNo + 1; this.save(s); }
  },
};
const memoNo = (m) => m.no ?? m.id;
function ymd(iso, sep = '') {
  const d = new Date(iso);
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join(sep);
}

function audioFileName(m) {
  if (!m.hasAudio) return '';
  return `${ymd(m.start)}_S${pad(m.sessionNo || 1, 2)}_${pad(memoNo(m), 3)}_${sanitize(m.category)}.${audioExt(m.audioType)}`;
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
        if (err.name === 'NotAllowedError') toast(t('tMicDenied'), 4000);
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
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast(t('tNoRecorder')); return; }
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
    if (durMs < MIN_RECORD_MS) { toast(t('tHold')); return; }
    const blob = s.chunks.length ? new Blob(s.chunks, { type: s.mr.mimeType || s.chunks[0].type }) : null;
    if (!blob) { toast(t('tRecFail'), 3000); }

    const memo = {
      vehicleId: settings.vehicleId,
      evaluator: settings.evaluator,
      ...session.take(s.start),
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
      toast(t('tSaveFail', { m: err && err.message }), 4000);
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
    this.worker.onerror = (e) => this.fail(e.message || t('errWorker'));
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
    if (!navigator.onLine) this.lastError = t('errOffline');
    else if (/fetch|network|load failed|取得/i.test(m)) {
      this.lastError = t('errDownload', { host: HOSTS[settings.host].label })
        + (settings.host === 'hf' ? t('errHintMirror') : t('errHintRetry'));
    } else this.lastError = t('errLoad', { m });
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
      if (!blob) throw new Error(t('tAudioMissing'));
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
    if (settings.vehicleId) parts.push(t('metaVehicle', { v: settings.vehicleId }));
    if (settings.evaluator) parts.push(settings.evaluator);
    $('#metaInfo').textContent = parts.join(' / ') || t('metaNone');
  },

  renderAsrStatus() {
    const t = transcriber;
    const waiting = t.queue.length + (t.current !== null ? 1 : 0);
    const name = (MODELS[settings.model] || {}).label || '';
    let txt;
    let cls;
    let detail;
    if (t.state === 'loading') {
      txt = tr(t.fromCache ? 'stLoadCache' : 'stDownload', { p: t.loadPercent() });
      cls = 'busy';
      detail = tr(t.fromCache ? 'stDetailCache' : 'stDetailDownload', { p: t.loadPercent() });
    } else if (t.state === 'error') {
      txt = waiting ? tr('stFailWait', { n: waiting }) : tr('stFail');
      cls = 'err';
      detail = `${t.lastError}`;
    } else if (t.isReady()) {
      txt = waiting ? tr('stBusy', { n: waiting }) : tr('stReady');
      cls = waiting ? 'busy' : 'ok';
      detail = tr('stDetailReady', { name, label: threadLabel(t.loadedLabel) });
    } else {
      txt = waiting ? tr('stMissingWait', { n: waiting }) : tr('stMissing');
      cls = 'warn';
      detail = tr('stDetailMissing', { name });
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
      btn.textContent = tr(t.state === 'error' ? 'btnRetry' : t.isReady() ? 'btnLoaded' : 'btnLoad');
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
      b.lastChild.textContent = name || t('catUnset', { n: i + 1 });
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
      $('#recLabel').textContent = t('recSelect');
    } else {
      btn.disabled = false;
      $('#recLabel').textContent = t('recHold');
    }
  },

  recordingStarted() {
    $('#recBtn').classList.add('recording');
    $('#recLabel').textContent = t('recRecording');
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
      el.textContent = t('recentEmpty');
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
      body.textContent = statusText(m) || m.text || t('noText');
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
  if (m.status === 'pending') return transcriber.state === 'error' || (!transcriber.isReady() && transcriber.state !== 'loading') ? t('pendingNoModel') : t('pending');
  if (m.status === 'transcribing') return t('transcribing');
  if (m.status === 'error') return t('failed');
  return '';
}

/* 言語切替（ワンタップ） */
function renderLang() {
  const b = $('#langBtn');
  b.textContent = LANGS[settings.lang].label;
  b.className = `lang-btn lang-${settings.lang}`;
  b.setAttribute('aria-label', t('langAria', { l: LANGS[settings.lang].label }));
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
    // 録音開始時刻の新しい順
    const memos = (await db.allMemos()).sort((a, b) => b.start.localeCompare(a.start) || b.id - a.id);
    for (const m of memos) {
      if (!m.hasAudio) continue;
      const blob = await db.getAudio(m.id);
      if (blob) this.urls.set(m.id, URL.createObjectURL(blob));
    }
    const body = $('#memoBody');
    body.innerHTML = '';
    $('#emptyMsg').style.display = memos.length ? 'none' : 'block';
    $('#count').textContent = t('count', { s: session.current(), n: memos.length });
    // 出力できるデータがあるボタンだけ強調表示（ないときはトーンダウンして押せない）
    const setExport = (sel, ok) => {
      const b = $(sel);
      b.disabled = !ok;
      b.classList.toggle('primary', ok);
    };
    setExport('#exportCsv', memos.length > 0);
    setExport('#exportZip', memos.some((m) => m.hasAudio));
    // 日付が複数あるときは、日付の変わり目に区切り行を入れる（No は日付ごとに振り直すため）
    const multiDay = new Set(memos.map((m) => ymd(m.start))).size > 1;
    let prevDay = null;
    for (const m of memos) {
      const day = ymd(m.start, '/');
      if (multiDay && day !== prevDay) {
        const tr = document.createElement('tr');
        tr.className = 'day-row';
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = day;
        tr.appendChild(td);
        body.appendChild(tr);
        prevDay = day;
      }
      body.appendChild(this.buildRow(m));
    }
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
    td('nowrap', memoNo(m));
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
    tm.children[2].textContent = t('sec', { s: m.durationSec.toFixed(1) });
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
      const pb = mkBtn(t('play'), '', () => this.play(m.id, pb));
      mkBtn(t('redo'), 'redo', async () => {
        const cur = await db.getMemo(m.id);
        if (!cur) return;
        if (cur.edited && !confirm(t('confirmRedo'))) return;
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
      a.textContent = t('map');
      oc.appendChild(a);
    }
    mkBtn(t('del'), 'del', async () => {
      if (!confirm(t('confirmDel', { no: memoNo(m), cat: m.category, time: fmtTime(m.start) }))) return;
      await db.deleteMemo(m.id);
      this.render();
    });

    this.rows.set(m.id, { tr, ta, statusEl, fit });
    this.applyState(m);
    return tr;
  },

  applyState(m) {
    const r = this.rows.get(m.id);
    if (!r) return;
    const busy = m.status === 'pending' || m.status === 'transcribing';
    if (document.activeElement !== r.ta) r.ta.value = m.text || '';
    r.ta.placeholder = busy ? '' : t('textPh');
    r.statusEl.textContent = m.status === 'error' ? t('failedMsg', { m: m.asrError || '' }) : statusText(m);
    r.statusEl.hidden = !r.statusEl.textContent;
    r.statusEl.classList.toggle('err', m.status === 'error');
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
      a.addEventListener('error', () => { toast(t('tCantPlay')); this.stopPlayback(); });
      document.body.appendChild(a);
      this.player = a;
    }
    return this.player;
  },

  stopPlayback() {
    if (this.player) this.player.pause();
    if (this.playingBtn) this.playingBtn.textContent = t('play');
    this.playingBtn = null;
  },

  // awaitを挟まずに再生開始する（iOSのユーザー操作要件）
  play(id, btn) {
    if (this.playingBtn === btn) { this.stopPlayback(); return; }
    this.stopPlayback();
    const url = this.urls.get(id);
    if (!url) { toast(t('tAudioMissing')); return; }
    const a = this.getPlayer();
    a.src = url;
    this.playingBtn = btn;
    btn.textContent = t('stop');
    a.play().catch((e) => { toast(t('tPlayErr', { m: e.name })); this.stopPlayback(); });
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
  const header = t('csvHeader');
  const rows = memos.map((m) => [
    ymd(m.start, '/'), m.sessionNo || 1, memoNo(m), m.vehicleId, m.evaluator, m.category, (LANGS[m.lang] || LANGS.ja).csv,
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
  // 評価日 → セッション → No の順
  const memos = (await db.allMemos()).sort((a, b) => ymd(a.start).localeCompare(ymd(b.start)) || (a.sessionNo || 1) - (b.sessionNo || 1) || memoNo(a) - memoNo(b));
  if (!memos.length) { toast(t('tNoRecords')); return null; }
  const busy = memos.filter((m) => m.status === 'pending' || m.status === 'transcribing').length;
  if (busy && !confirm(t('confirmExportBusy', { n: busy }))) return null;
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
  toast(t('tZip'));
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
      l.textContent = t('catLabel', { n: i + 1 });
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
        tagEl.textContent = t('cached');
        span.appendChild(tagEl);
        if (id !== settings.model) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'icon-btn del small';
          del.textContent = t('delModel');
          del.addEventListener('click', async (ev) => {
            ev.preventDefault();
            if (!confirm(t('confirmDelModel', { name: info.label }))) return;
            await modelCache.remove(id);
            toast(t('tModelDeleted'));
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
    $('#storageInfo').textContent = t('storage', {
      s: session.current(), n: memos.length, a: fmt(audioMB), m: modelMB, v: APP_VERSION,
      models: cachedModels.length ? `（${cachedModels.map((i) => i.label.replace(/（.*$/, '')).join('・')}）` : '',
    });

    // 保存データが消されにくい状態かを表示
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let persisted = false;
    try { persisted = !!(navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()); } catch { /* ignore */ }
    const el = $('#persistInfo');
    el.textContent = standalone
      ? t('persistHome', { p: persisted ? t('persisted') : '' })
      : t('persistTab');
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
    uiLang: settings.uiLang,
    useGps: f.useGps.checked,
    keepAwake: f.keepAwake.checked,
  };
  saveSettings(settings);
  if (settings.useGps) gps.start(); else gps.stop();
  ui.renderMeta();
  ui.renderCategories();
  ui.renderAsrStatus();
  const changed = settings.model !== prevModel;
  toast(changed ? t('tSavedReload') : t('tSaved'));
  if (changed) transcriber.preload();
});

$('#resetCats').addEventListener('click', () => {
  t('defaultCats').forEach((c, i) => { $('#settingsForm')[`cat${i}`].value = c; });
  toast(t('tResetCats'), 3000);
});

$('#loadModel').addEventListener('click', async () => {
  const cached = await modelCache.isCached(settings.model);
  toast(cached ? t('tLoadCache') : t('tLoadDownload'), 3000);
  transcriber.preload();
});

$('#clearAll').addEventListener('click', async () => {
  const nextNo = session.afterClear();
  if (!confirm(t('confirmClear', { date: ymd(new Date(), '/'), s: nextNo }))) return;
  transcriber.queue.length = 0; // 文字起こし待ちも破棄
  await db.clear();
  session.next();
  toast(t('tCleared', { s: session.current() }), 3000);
  settingsView.storageInfo();
  ui.renderRecent();
});

document.querySelectorAll('.tabbar button').forEach((b) => {
  b.addEventListener('click', () => ui.showView(b.dataset.view));
});

/* 表示言語の切替（即時反映） */
function renderUiLangSeg() {
  document.querySelectorAll('#uiLangSeg button').forEach((b) => b.classList.toggle('active', b.dataset.uiLang === uiLang));
}
function setUiLang(lang) {
  if (!UI_LANGS[lang] || lang === uiLang) return;
  uiLang = lang;
  settings.uiLang = lang;
  saveSettings(settings);
  applyI18n();
  renderUiLangSeg();
  ui.renderMeta();
  ui.renderCategories();
  renderLang();
  ui.renderRecent();
  ui.renderAsrStatus();
  if ($('#view-list').classList.contains('active')) list.render();
  if (settingsView.visible()) settingsView.render();
}
document.querySelectorAll('#uiLangSeg button').forEach((b) => b.addEventListener('click', () => setUiLang(b.dataset.uiLang)));

/* =========================================================
 * 起動
 * ======================================================= */
applyI18n();
renderUiLangSeg();
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
session.migrate().then(() => transcriber.resumePending()); // 旧データに番号を振ってから、前回終わらなかった文字起こしを再開
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
