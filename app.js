'use strict';

/* =========================================================
 * 設定
 * ======================================================= */
const SETTINGS_KEY = 'voicememo.settings.v1';
const DEFAULT_SETTINGS = {
  vehicleId: '',
  evaluator: '',
  categories: ['異音', '振動', '操縦安定性', '乗り心地', '警告灯・表示', 'その他'],
  saveAudio: false, // iPhoneでは音声認識と同時に使うと両方失敗することがあるため初期OFF
  useGps: true,
  keepAwake: true,
};
const APP_VERSION = 'v6';
const MIN_RECORD_MS = 400; // これより短い押下は誤タップとして破棄

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const merged = { ...DEFAULT_SETTINGS, ...s };
    const cats = Array.isArray(s.categories) ? s.categories : DEFAULT_SETTINGS.categories;
    merged.categories = Array.from({ length: 6 }, (_, i) => (cats[i] ?? '').toString());
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
    async addMemo(memo, audioBlob) {
      return tx(['memos', 'audio'], 'readwrite', (t) => new Promise((resolve) => {
        const req = t.objectStore('memos').add(memo);
        req.onsuccess = () => {
          if (audioBlob) t.objectStore('audio').put({ id: req.result, blob: audioBlob });
          resolve(req.result);
        };
      }));
    },
    async updateMemo(memo) {
      return tx(['memos'], 'readwrite', (t) => { t.objectStore('memos').put(memo); });
    },
    async deleteMemo(id) {
      return tx(['memos', 'audio'], 'readwrite', (t) => {
        t.objectStore('memos').delete(id);
        t.objectStore('audio').delete(id);
      });
    },
    async allMemos() {
      return tx(['memos'], 'readonly', (t) => reqP(t.objectStore('memos').getAll()));
    },
    async getAudio(id) {
      const r = await tx(['audio'], 'readonly', (t) => reqP(t.objectStore('audio').get(id)));
      return r ? r.blob : null;
    },
    async clear() {
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
/* 診断ログ（設定画面に表示。不具合調査用） */
const diag = {
  KEY: 'voicememo.diag.v1',
  items: [],
  load() { try { this.items = JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { this.items = []; } },
  log(msg) {
    const d = new Date();
    this.items.unshift(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${msg}`);
    this.items = this.items.slice(0, 40);
    try { localStorage.setItem(this.KEY, JSON.stringify(this.items)); } catch { /* ignore */ }
  },
};
diag.load();
window.addEventListener('error', (e) => diag.log(`JSエラー: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => diag.log(`JSエラー: ${e.reason && (e.reason.message || e.reason)}`));

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
      (p) => { this.last = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; },
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
    return this.last && Date.now() - this.last.t < 60000 ? this.last : null;
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

/* =========================================================
 * 録音 + 音声認識
 * ======================================================= */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* マイク：録音ごとに取得・解放を繰り返すとiOSで不安定になるため、記録画面にいる間は使い回す */
const mic = {
  stream: null,
  pending: null,
  live() {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  },
  get() {
    if (this.live()) return Promise.resolve(this.stream);
    if (this.pending) return this.pending;
    const t0 = Date.now();
    this.pending = navigator.mediaDevices.getUserMedia({ audio: true })
      .then((st) => {
        this.stream = st;
        st.getAudioTracks().forEach((t) => {
          t.addEventListener('ended', () => diag.log('マイク: 切断'));
          t.addEventListener('mute', () => diag.log('マイク: ミュート'));
          t.addEventListener('unmute', () => diag.log('マイク: ミュート解除'));
        });
        diag.log(`マイク取得 ${Date.now() - t0}ms`);
        return st;
      })
      .catch((err) => {
        diag.log(`マイク取得失敗: ${err.name} ${err.message}`);
        if (err.name === 'NotAllowedError') toast('マイクの使用が許可されていません');
        throw err;
      })
      .finally(() => { this.pending = null; });
    return this.pending;
  },
  release() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    diag.log('マイク解放');
  },
};
const audioWanted = () => settings.saveAudio && !!navigator.mediaDevices && !!window.MediaRecorder;

/* 音声認識：iOS Safariでは録音ごとに新しく作ると2回目以降に失敗しやすいため、1つを使い回す */
const speech = {
  rec: null,
  running: false,
  session: null,     // 結果を渡す録音セッション
  restartOnEnd: false,
  results: 0,

  init() {
    if (this.rec || !SpeechRecognition) return;
    const rec = new SpeechRecognition();
    rec.lang = 'ja-JP';
    // iOSでは continuous=true だと結果が返らないことがあるため、単発認識＋押下中は自動再開
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const tag = () => (this.session ? `#${this.session.no} ` : '');
    rec.onstart = () => { this.running = true; diag.log(`${tag()}認識: 開始`); };
    rec.onaudiostart = () => diag.log(`${tag()}認識: 音声入力あり`);
    rec.onsoundstart = () => diag.log(`${tag()}認識: 音を検出`);
    rec.onspeechstart = () => diag.log(`${tag()}認識: 発話検出`);
    rec.onnomatch = () => diag.log(`${tag()}認識: 一致なし`);
    rec.onresult = (e) => {
      const s = this.session;
      if (!s) return;
      if (this.results++ === 0) diag.log(`#${s.no} 認識: 結果受信`);
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      s.current = text;
      ui.liveText(s.committed + s.current);
    };
    rec.onerror = (e) => {
      diag.log(`${tag()}認識エラー: ${e.error}`);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('音声認識が許可されていません（設定 > アプリ > Safari > マイク、設定 > 一般 > キーボード > 音声入力 を確認）', 5000);
      }
    };
    rec.onend = () => {
      this.running = false;
      const s = this.session;
      diag.log(`${tag()}認識: 終了`);
      if (s) {
        s.committed += s.current;
        s.current = '';
        // 押下中に無音などで切れた場合、または前回の終了待ちだった場合は開始
        if (recorder.active === s && !s.stopRequested) {
          this.restartOnEnd = false;
          this.begin();
          return;
        }
        this.session = null;
        if (s.resolveRecognition) s.resolveRecognition();
      }
    };
    this.rec = rec;
  },

  begin() {
    this.results = 0;
    try { this.rec.start(); } catch (err) { diag.log(`認識開始失敗: ${err.name}`); }
  },

  start(s) {
    if (!SpeechRecognition) return;
    this.init();
    s.recognitionEnded = new Promise((r) => { s.resolveRecognition = r; });
    const prev = this.session;
    this.session = s;
    if (prev && prev.resolveRecognition) prev.resolveRecognition();
    if (this.running) {
      // 前回の認識がまだ終わっていない：止めて、終了後に開始
      diag.log(`#${s.no} 認識: 前回の終了待ち`);
      try { this.rec.abort(); } catch { /* ignore */ }
      // 1秒待っても終わらなければ作り直す
      setTimeout(() => {
        if (this.running && this.session === s && recorder.active === s) {
          diag.log(`#${s.no} 認識: 応答なし→作り直し`);
          this.rec.onend = null;
          this.rec = null;
          this.running = false;
          this.init();
          this.begin();
        }
      }, 1000);
    } else {
      this.begin();
    }
  },

  stop() {
    if (this.rec && this.running) { try { this.rec.stop(); } catch { /* ignore */ } }
    else if (this.session) { const s = this.session; this.session = null; if (s.resolveRecognition) s.resolveRecognition(); }
  },

  abort() {
    if (this.rec) { try { this.rec.abort(); } catch { /* ignore */ } }
  },
};

const recorder = {
  active: null, // 現在の録音セッション
  busy: false,  // 保存処理中
  seq: 0,

  start(category) {
    if (this.active || this.busy) return;
    const s = {
      no: ++this.seq,
      category,
      start: new Date(),
      end: null,
      gps: gps.current(),
      committed: '',   // 認識が途中で切れた場合の確定済みテキスト
      current: '',     // 現在の認識セッションのテキスト
      stopRequested: false,
      recognitionEnded: null,
      mediaRecorder: null,
      chunks: [],
      audioDone: null,
    };
    this.active = s;
    ui.recordingStarted();
    diag.log(`#${s.no} 押下 ${category}`);

    // GPSが古ければ、録音中に取得を試みる
    if (settings.useGps && !s.gps && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (p) => { if (!s.gps) s.gps = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; },
        () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
      );
    }

    // 録音：マイクが準備済みなら即開始。未準備なら取得後に開始（待たずに先へ進む）
    if (audioWanted()) {
      if (mic.live()) this.beginAudio(s, mic.stream);
      else mic.get().then((st) => { if (!s.stopRequested) this.beginAudio(s, st); }).catch(() => {});
    }

    // 音声認識はユーザー操作の中で同期的に開始する（iOSの要件）
    speech.start(s);
  },

  beginAudio(s, stream) {
    try {
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
        .find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) s.chunks.push(e.data); };
      mr.onerror = (e) => diag.log(`#${s.no} 録音エラー: ${e.error ? e.error.name : 'unknown'}`);
      s.audioDone = new Promise((res) => { mr.onstop = res; });
      // timesliceを指定しない：iOS Safariでは分割データを結合すると再生できないファイルになることがある
      mr.start();
      s.mediaRecorder = mr;
      diag.log(`#${s.no} 録音開始 +${Date.now() - s.start}ms ${mr.mimeType || mime || ''}`);
    } catch (err) {
      diag.log(`#${s.no} 録音開始失敗: ${err.name} ${err.message}`);
    }
  },

  stop(reason) {
    const s = this.active;
    if (!s || s.stopRequested) return;
    s.stopRequested = true;
    s.end = new Date();
    diag.log(`#${s.no} 停止(${reason}) ${s.end - s.start}ms`);
    this.finish(s);
  },

  async finish(s) {
    this.busy = true;
    ui.recordingStopping();

    if (s.mediaRecorder && s.mediaRecorder.state !== 'inactive') {
      try { s.mediaRecorder.stop(); } catch (err) { diag.log(`#${s.no} 録音停止失敗: ${err.name}`); }
    }
    speech.stop();

    const [audioOk, recOk] = await Promise.all([
      s.audioDone ? Promise.race([s.audioDone.then(() => true), sleep(2500).then(() => false)]) : true,
      s.recognitionEnded ? Promise.race([s.recognitionEnded.then(() => true), sleep(3000).then(() => false)]) : true,
    ]);
    if (!audioOk) diag.log(`#${s.no} 録音停止がタイムアウト`);
    if (!recOk) {
      // 終了しない認識は強制終了（次の録音とぶつからないように）
      diag.log(`#${s.no} 音声認識の終了がタイムアウト→強制終了`);
      speech.abort();
    }

    this.active = null;
    const durMs = s.end - s.start;

    try {
      if (durMs < MIN_RECORD_MS) {
        toast('録音ボタンは押し続けてください');
      } else {
        const text = (s.committed + s.current).trim();
        const blob = s.chunks.length ? new Blob(s.chunks, { type: (s.mediaRecorder && s.mediaRecorder.mimeType) || s.chunks[0].type }) : null;
        if (audioWanted()) diag.log(blob ? `#${s.no} 音声 ${(blob.size / 1024).toFixed(1)}KB` : `#${s.no} 音声データなし`);
        const memo = {
          vehicleId: settings.vehicleId,
          evaluator: settings.evaluator,
          category: s.category,
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          durationSec: Math.round(durMs / 100) / 10,
          lat: s.gps ? s.gps.lat : null,
          lng: s.gps ? s.gps.lng : null,
          text,
          hasAudio: !!blob,
          audioType: blob ? blob.type : '',
          audioSize: blob ? blob.size : 0,
        };
        const id = await db.addMemo(memo, blob);
        diag.log(`#${s.no} 保存 No.${id} 文字数${text.length}`);
        toast(text ? `保存：${s.category}「${text.slice(0, 20)}${text.length > 20 ? '…' : ''}」` : `保存：${s.category}（テキストなし）`, 3000);
        list.dirty = true;
      }
    } catch (err) {
      console.error(err);
      diag.log(`#${s.no} 保存失敗: ${err && err.name} ${err && err.message}`);
      toast('保存に失敗しました: ' + (err && err.message), 4000);
    } finally {
      this.busy = false;
      ui.recordingFinished();
    }
  },
};

/* =========================================================
 * 画面
 * ======================================================= */
const ui = {
  selected: null, // 選択中の種類（インデックス）
  timerId: null,

  renderMeta() {
    const parts = [];
    if (settings.vehicleId) parts.push(`車両 ${settings.vehicleId}`);
    if (settings.evaluator) parts.push(settings.evaluator);
    $('#metaInfo').textContent = parts.join(' / ') || '車両ID未設定';
  },

  renderCategories() {
    const grid = $('#catGrid');
    grid.innerHTML = '';
    settings.categories.forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'cat-btn' + (this.selected === i ? ' selected' : '');
      b.innerHTML = `<span class="num">${i + 1}</span><span></span>`;
      b.lastChild.textContent = name || `(未設定${i + 1})`;
      b.disabled = !name;
      b.addEventListener('click', () => {
        if (recorder.active) return;
        this.selected = i;
        if (audioWanted()) mic.get().catch(() => {});
        this.renderCategories();
        this.updateRecBtn();
      });
      grid.appendChild(b);
    });
    if (this.selected !== null && !settings.categories[this.selected]) this.selected = null;
    this.updateRecBtn();
  },

  updateRecBtn() {
    const btn = $('#recBtn');
    const label = $('#recLabel');
    if (recorder.active) return;
    if (this.selected === null) {
      btn.disabled = true;
      label.textContent = '種類を選択してください';
    } else {
      btn.disabled = recorder.busy;
      label.textContent = recorder.busy ? '保存中…' : `押している間 録音（${settings.categories[this.selected]}）`;
    }
  },

  recordingStarted() {
    const btn = $('#recBtn');
    btn.classList.add('recording');
    $('#recLabel').textContent = '録音中… 離すと停止';
    $('#liveStatus').textContent = `● ${settings.categories[this.selected]}`;
    $('#liveText').textContent = '';
    const t0 = Date.now();
    this.timerId = setInterval(() => {
      const sec = (Date.now() - t0) / 1000;
      $('#liveTimer').textContent = `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
    }, 200);
    document.querySelectorAll('.cat-btn, .tabbar button').forEach((b) => { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
  },
  recordingStopping() {
    clearInterval(this.timerId);
    const btn = $('#recBtn');
    btn.classList.remove('recording');
    btn.classList.add('busy');
    $('#recLabel').textContent = 'テキスト化中…';
  },
  recordingFinished() {
    $('#recBtn').classList.remove('busy');
    $('#liveTimer').textContent = '';
    $('#liveStatus').textContent = '種類を選んでから、録音ボタンを押し続けて話してください';
    document.querySelectorAll('.cat-btn, .tabbar button').forEach((b) => { b.disabled = b.dataset.wasDisabled === 'true'; });
    this.updateRecBtn();
  },
  liveText(t) { $('#liveText').textContent = t; },

  showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name !== 'record') mic.release();
    if (name === 'list') list.render(); else list.stop();
    if (name === 'settings') settingsView.render();
  },
};

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
    recorder.stop(e ? e.type : '');
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('lostpointercapture', end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // 画面が裏に回ったら停止し、マイクを解放
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { end({ type: 'hidden' }); mic.release(); }
  });
})();

/* =========================================================
 * 一覧
 * ======================================================= */
const list = {
  dirty: true,
  memos: [],
  playing: null, // 再生中のボタン
  urls: new Map(), // id -> objectURL（iOSはタップ直後に再生開始しないとブロックされるため事前に用意）
  player: null,

  async render() {
    this.stop();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
    this.memos = (await db.allMemos()).sort((a, b) => b.id - a.id);
    for (const m of this.memos) {
      if (!m.hasAudio) continue;
      const blob = await db.getAudio(m.id);
      if (blob) this.urls.set(m.id, URL.createObjectURL(blob));
    }
    const body = $('#memoBody');
    body.innerHTML = '';
    $('#emptyMsg').style.display = this.memos.length ? 'none' : 'block';
    $('#count').textContent = `${this.memos.length} 件`;

    for (const m of this.memos) {
      const tr = document.createElement('tr');
      const td = (cls, text) => {
        const c = document.createElement('td');
        if (cls) c.className = cls;
        if (text !== undefined) c.textContent = text;
        tr.appendChild(c);
        return c;
      };
      td('nowrap', m.id);
      const tc = td('');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = m.category;
      tc.appendChild(tag);
      const tm = td('nowrap time');
      tm.innerHTML = '<div></div><div></div><div class="dur"></div>';
      tm.children[0].textContent = fmtTime(m.start);
      tm.children[1].textContent = fmtTime(m.end);
      tm.children[2].textContent = `${m.durationSec.toFixed(1)}秒` + (m.audioSize ? ` / ${Math.max(1, Math.round(m.audioSize / 1024))}KB` : '');
      tm.title = `${fmtDateTime(m.start)} 〜 ${fmtDateTime(m.end)}`;

      const textCell = td('col-text');
      const ta = document.createElement('textarea');
      ta.value = m.text;
      ta.placeholder = '(認識なし) タップして入力';
      ta.addEventListener('change', async () => {
        m.text = ta.value;
        m.edited = true;
        await db.updateMemo(m);
        ta.classList.add('saved');
        setTimeout(() => ta.classList.remove('saved'), 1200);
      });
      textCell.appendChild(ta);
      const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
      ta.addEventListener('input', fit);
      requestAnimationFrame(fit);

      const oc = td('ops');
      const mkBtn = (label, cls, onClick) => {
        const bt = document.createElement('button');
        bt.className = 'icon-btn ' + cls;
        bt.textContent = label;
        bt.addEventListener('click', onClick);
        oc.appendChild(bt);
        return bt;
      };
      if (m.hasAudio) {
        const pb = mkBtn('▶ 再生', '', () => this.play(m, pb));
      } else {
        const na = document.createElement('div');
        na.className = 'no-audio';
        na.textContent = '音声なし';
        oc.appendChild(na);
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

      body.appendChild(tr);
    }
    this.dirty = false;
  },

  getPlayer() {
    if (!this.player) {
      const a = document.createElement('audio');
      a.setAttribute('playsinline', '');
      a.preload = 'auto';
      a.addEventListener('ended', () => this.stop());
      a.addEventListener('error', () => {
        const code = a.error ? a.error.code : '?';
        diag.log(`再生エラー code=${code}`);
        toast(`この音声は再生できません（エラー${code}）`);
        this.stop();
      });
      document.body.appendChild(a);
      this.player = a;
    }
    return this.player;
  },

  stop() {
    if (this.player) this.player.pause();
    if (this.playing) this.playing.textContent = '▶ 再生';
    this.playing = null;
  },

  // awaitを挟まずに再生開始する（iOSのユーザー操作要件）
  play(m, btn) {
    if (this.playing === btn) { this.stop(); return; }
    this.stop();
    const url = this.urls.get(m.id);
    if (!url) { toast('音声が見つかりません'); return; }
    const a = this.getPlayer();
    a.src = url;
    this.playing = btn;
    btn.textContent = '■ 停止';
    a.play().catch((e) => {
      diag.log(`再生失敗: ${e.name} ${e.message}`);
      toast(`再生できません: ${e.name}`);
      this.stop();
    });
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
    m.text, audioFileName(m),
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
      if (e.name === 'AbortError') return; // ユーザーがキャンセル
      // NotAllowedError 等はダウンロードにフォールバック
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

$('#exportCsv').addEventListener('click', async () => {
  const memos = (await db.allMemos()).sort((a, b) => a.id - b.id);
  if (!memos.length) { toast('記録がありません'); return; }
  const blob = new Blob([buildCsv(memos)], { type: 'text/csv' });
  await deliverFile(blob, `${exportBaseName()}.csv`);
});

$('#exportZip').addEventListener('click', async () => {
  const memos = (await db.allMemos()).sort((a, b) => a.id - b.id);
  if (!memos.length) { toast('記録がありません'); return; }
  toast('ZIPを作成中…');
  const enc = new TextEncoder();
  const files = [{ name: 'memo.csv', data: enc.encode(buildCsv(memos)), date: new Date() }];
  for (const m of memos) {
    if (!m.hasAudio) continue;
    const blob = await db.getAudio(m.id);
    if (blob) files.push({ name: audioFileName(m), data: new Uint8Array(await blob.arrayBuffer()), date: new Date(m.start) });
  }
  const zip = window.MiniZip.createZip(files);
  await deliverFile(zip, `${exportBaseName()}.zip`);
});

/* =========================================================
 * 設定画面
 * ======================================================= */
const settingsView = {
  render() {
    const f = $('#settingsForm');
    f.vehicleId.value = settings.vehicleId;
    f.evaluator.value = settings.evaluator;
    f.saveAudio.checked = settings.saveAudio;
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
    this.storageInfo();
    const env = [
      `音声認識: ${SpeechRecognition ? '対応' : '非対応'}`,
      `録音: ${window.MediaRecorder ? '対応' : '非対応'}`,
      `形式: ${window.MediaRecorder && MediaRecorder.isTypeSupported ? ['audio/mp4', 'audio/webm'].filter((t) => MediaRecorder.isTypeSupported(t)).join(', ') || 'なし' : '-'}`,
    ].join(' / ');
    $('#diagLog').textContent = [`アプリ版: ${APP_VERSION}`, env, navigator.userAgent, '', ...diag.items].join('\n');
  },
  async storageInfo() {
    const memos = await db.allMemos();
    let txt = `記録 ${memos.length} 件`;
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      txt += ` / 使用量 約${(e.usage / 1024 / 1024).toFixed(1)}MB`;
    }
    $('#storageInfo').textContent = txt + '。削除前に必ずCSV/ZIPを出力してください。';
  },
};

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  settings = {
    vehicleId: f.vehicleId.value.trim(),
    evaluator: f.evaluator.value.trim(),
    categories: Array.from({ length: 6 }, (_, i) => f[`cat${i}`].value.trim()),
    saveAudio: f.saveAudio.checked,
    useGps: f.useGps.checked,
    keepAwake: f.keepAwake.checked,
  };
  saveSettings(settings);
  if (settings.useGps) gps.start(); else gps.stop();
  ui.renderMeta();
  ui.renderCategories();
  toast('設定を保存しました');
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
gps.start();
requestWakeLock();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if (!SpeechRecognition) {
  $('#liveStatus').textContent = 'この端末のブラウザは音声認識に非対応です（音声のみ保存されます）';
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
