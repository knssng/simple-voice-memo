'use strict';

/*
 * 走行評価メモ
 * 種類を選ぶ → 録音ボタンを押している間だけ録音 → 離すと保存し、端末内の Whisper で文字起こし
 * （音声認識に Safari の Web Speech API は使わない。録音と同時に使うと iPhone で失敗するため）
 */

const APP_VERSION = 'v8';

/* =========================================================
 * 設定
 * ======================================================= */
const SETTINGS_KEY = 'voicememo.settings.v1';
const MODELS = {
  'onnx-community/whisper-small': { label: '標準（small・約250MB）', note: '日本語の精度が高い。1件あたり十数秒' },
  'onnx-community/whisper-base': { label: '軽量（base・約80MB）', note: '速いが誤変換が多い' },
};
const DEFAULT_MODEL = 'onnx-community/whisper-small';
const DEFAULT_SETTINGS = {
  vehicleId: '',
  evaluator: '',
  categories: ['異音', '振動', '操縦安定性', '乗り心地', '警告灯・表示', 'その他'],
  model: DEFAULT_MODEL,
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
    const s = { category, start: new Date(), end: null, gps: gps.current(), chunks: [], mr: null, done: null, stopRequested: false };
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
      toast(`保存：${s.category}（${memo.durationSec}秒）${blob ? ' → 文字起こし待ち' : ''}`);
      if (blob) transcriber.enqueue(id);
      ui.renderRecent();
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
  queue: [],       // 待ちの memo id
  current: null,   // 処理中の memo id
  state: 'idle',   // idle | loading | ready | error
  progress: {},    // file -> {loaded,total}
  loadedModel: null,
  callbacks: new Map(),

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker('whisper-worker.js?v=8', { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      this.state = 'error';
      this.lastError = e.message || 'ワーカーの起動に失敗しました';
      ui.renderAsrStatus();
    };
  },

  onMessage(msg) {
    if (msg.type === 'progress') {
      this.state = 'loading';
      this.progress[msg.file] = { loaded: msg.loaded, total: msg.total };
      ui.renderAsrStatus();
    } else if (msg.type === 'ready') {
      this.state = 'ready';
      this.loadedModel = msg.model;
      try { localStorage.setItem(`voicememo.modelReady.${msg.model}`, '1'); } catch { /* ignore */ }
      this.progress = {};
      ui.renderAsrStatus();
    } else if (msg.type === 'result' || msg.type === 'error') {
      const cb = this.callbacks.get(msg.id);
      this.callbacks.delete(msg.id);
      if (msg.type === 'error' && msg.id === undefined) {
        this.state = 'error';
        this.lastError = msg.message;
        ui.renderAsrStatus();
      }
      if (cb) cb(msg);
    }
  },

  loadPercent() {
    const files = Object.values(this.progress);
    const total = files.reduce((a, f) => a + (f.total || 0), 0);
    const loaded = files.reduce((a, f) => a + (f.loaded || 0), 0);
    return total ? Math.floor((loaded / total) * 100) : 0;
  },

  preload() {
    this.ensureWorker();
    if (this.loadedModel === settings.model) return;
    this.state = 'loading';
    ui.renderAsrStatus();
    this.worker.postMessage({ type: 'load', model: settings.model });
  },

  enqueue(id) {
    if (this.current === id || this.queue.includes(id)) return;
    this.queue.push(id);
    ui.renderAsrStatus();
    this.pump();
  },

  async pump() {
    if (this.current !== null || !this.queue.length) return;
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
      if (this.loadedModel !== settings.model) { this.state = 'loading'; ui.renderAsrStatus(); }
      const res = await new Promise((resolve) => {
        this.callbacks.set(id, resolve);
        this.worker.postMessage({ type: 'transcribe', id, model: settings.model, audio }, [audio.buffer]);
      });
      const latest = await db.getMemo(id);
      if (!latest) return; // 処理中に削除された
      if (res.type === 'result') {
        // 手で修正済みなら上書きしない
        if (!latest.edited) latest.text = cleanTranscript(res.text);
        latest.status = 'done';
        latest.asrModel = settings.model;
        latest.asrMs = res.ms;
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
    const n = t.queue.length + (t.current !== null ? 1 : 0);
    let txt;
    if (t.state === 'loading') txt = `モデル読込中 ${t.loadPercent()}%`;
    else if (t.state === 'error') txt = '文字起こしエラー';
    else if (n) txt = `文字起こし中（残り${n}件）`;
    else if (t.loadedModel === settings.model) txt = '文字起こし準備OK';
    else txt = 'モデル未取得（設定でダウンロード）';
    $('#asrStatus').textContent = txt;
    $('#asrStatus').hidden = !txt;
    const ms = $('#modelStatus');
    if (ms) {
      ms.textContent = t.state === 'loading' ? `ダウンロード／読込中… ${t.loadPercent()}%`
        : t.state === 'error' ? `エラー: ${t.lastError || ''}`
          : t.loadedModel === settings.model ? '読込済み（オフラインでも使えます）' : '未読込';
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
    document.querySelectorAll('.cat-btn, .tabbar button').forEach((b) => { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
  },

  recordingStopped() {
    clearInterval(this.timerId);
    $('#recTimer').textContent = '';
    $('#recBtn').classList.remove('recording');
    document.querySelectorAll('.cat-btn, .tabbar button').forEach((b) => { b.disabled = b.dataset.wasDisabled === 'true'; });
    this.updateRecBtn();
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
  if (m.status === 'pending') return '文字起こし待ち…';
  if (m.status === 'transcribing') return '文字起こし中…';
  if (m.status === 'error') return '文字起こし失敗';
  return '';
}

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
    td('').appendChild(tag);

    const tm = td('nowrap time');
    tm.innerHTML = '<div></div><div></div><div class="dur"></div>';
    tm.children[0].textContent = fmtTime(m.start);
    tm.children[1].textContent = fmtTime(m.end);
    tm.children[2].textContent = `${m.durationSec.toFixed(1)}秒`;
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

    this.rows.set(m.id, { tr, ta, statusEl, fit });
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
  const header = ['No', '車両ID', '評価者', '種類', '録音開始', '録音終了', '録音時間(秒)', '緯度', '経度', 'テキスト', '音声ファイル'];
  const rows = memos.map((m) => [
    m.id, m.vehicleId, m.evaluator, m.category,
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
    });
    ui.renderAsrStatus();
    this.storageInfo();
  },
  async storageInfo() {
    const memos = await db.allMemos();
    let txt = `記録 ${memos.length} 件`;
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      txt += ` / 使用量 約${Math.round(e.usage / 1024 / 1024)}MB（モデル含む）`;
    }
    $('#storageInfo').textContent = `${txt}。削除前に必ずCSV/ZIPを出力してください。（アプリ版 ${APP_VERSION}）`;
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
    useGps: f.useGps.checked,
    keepAwake: f.keepAwake.checked,
  };
  saveSettings(settings);
  if (settings.useGps) gps.start(); else gps.stop();
  ui.renderMeta();
  ui.renderCategories();
  ui.renderAsrStatus();
  toast(settings.model !== prevModel ? '設定を保存しました。モデルを読み込み直します' : '設定を保存しました');
  if (settings.model !== prevModel) transcriber.preload();
});

$('#loadModel').addEventListener('click', () => {
  transcriber.preload();
  toast('モデルを準備しています（初回はWi-Fi推奨）', 3000);
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
ui.renderRecent();
ui.renderAsrStatus();
gps.start();
requestWakeLock();
// 一度ダウンロード済みのモデルなら裏で読み込んでおく（キャッシュから読むので通信は発生しない）
try { if (localStorage.getItem(`voicememo.modelReady.${settings.model}`)) transcriber.preload(); } catch { /* ignore */ }
transcriber.resumePending(); // 前回終わらなかった文字起こしを再開
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
$('#asrStatus').addEventListener('click', () => { if (!recorder.active) ui.showView('settings'); });
