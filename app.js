'use strict';

/*
 * 走行評価メモ
 * 種類ボタンをタップ → 入力欄が開く → iPhoneキーボードの🎤（音声入力）で話す → 保存
 * 開始時刻 = 種類ボタンをタップした時刻 / 終了時刻 = 保存した時刻
 */

const APP_VERSION = 'v7';

/* =========================================================
 * 設定
 * ======================================================= */
const SETTINGS_KEY = 'voicememo.settings.v1';
const DEFAULT_SETTINGS = {
  vehicleId: '',
  evaluator: '',
  categories: ['異音', '振動', '操縦安定性', '乗り心地', '警告灯・表示', 'その他'],
  useGps: true,
  keepAwake: true,
};

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
 * IndexedDB
 * （旧版の音声ストアは互換のため残し、削除時に一緒に消す）
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
    addMemo(memo) {
      return tx(['memos'], 'readwrite', (t) => reqP(t.objectStore('memos').add(memo)));
    },
    updateMemo(memo) {
      return tx(['memos'], 'readwrite', (t) => { t.objectStore('memos').put(memo); });
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

/* =========================================================
 * 入力シート（種類タップで開く）
 * ======================================================= */
const sheet = {
  draft: null, // { category, start: Date, gps }
  timerId: null,

  // iOSでキーボードを出すため、タップ処理の中で同期的に表示→focusする
  open(category) {
    if (this.draft) return;
    this.draft = { category, start: new Date(), gps: gps.current() };
    if (settings.useGps && !this.draft.gps && 'geolocation' in navigator) {
      const d = this.draft;
      navigator.geolocation.getCurrentPosition(
        (p) => { if (!d.gps) d.gps = { lat: p.coords.latitude, lng: p.coords.longitude }; },
        () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
      );
    }
    $('#sheetCat').textContent = category;
    $('#sheetStart').textContent = `開始 ${fmtTime(this.draft.start.toISOString())}`;
    $('#sheetElapsed').textContent = '0:00';
    const ta = $('#sheetText');
    ta.value = '';
    $('#sheet').hidden = false;
    $('#backdrop').hidden = false;
    document.body.classList.add('sheet-open');
    ta.focus();
    const t0 = this.draft.start.getTime();
    this.timerId = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      $('#sheetElapsed').textContent = `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
    }, 500);
    requestWakeLock();
  },

  close() {
    clearInterval(this.timerId);
    this.draft = null;
    $('#sheetText').blur();
    $('#sheet').hidden = true;
    $('#backdrop').hidden = true;
    document.body.classList.remove('sheet-open');
  },

  async save() {
    const d = this.draft;
    if (!d) return;
    const end = new Date();
    const text = $('#sheetText').value.trim();
    const memo = {
      vehicleId: settings.vehicleId,
      evaluator: settings.evaluator,
      category: d.category,
      start: d.start.toISOString(),
      end: end.toISOString(),
      durationSec: Math.round((end - d.start) / 100) / 10,
      lat: d.gps ? d.gps.lat : null,
      lng: d.gps ? d.gps.lng : null,
      text,
    };
    this.close();
    try {
      await db.addMemo(memo);
      toast(text ? `保存：${d.category}「${text.slice(0, 20)}${text.length > 20 ? '…' : ''}」` : `保存：${d.category}（テキストなし）`, 2500);
      ui.renderRecent();
    } catch (err) {
      toast('保存に失敗しました: ' + (err && err.message), 4000);
    }
  },

  cancel() {
    const ta = $('#sheetText');
    if (ta.value.trim() && !confirm('入力内容を破棄しますか？')) { ta.focus(); return; }
    this.close();
  },
};

$('#sheetSave').addEventListener('click', () => sheet.save());
$('#sheetCancel').addEventListener('click', () => sheet.cancel());
// 誤操作で入力を失わないよう、背景タップでは閉じない

/* =========================================================
 * 記録画面
 * ======================================================= */
const ui = {
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
      b.className = 'cat-btn';
      b.innerHTML = '<span class="num"></span><span class="name"></span>';
      b.firstChild.textContent = i + 1;
      b.lastChild.textContent = name || `(未設定${i + 1})`;
      b.disabled = !name;
      b.addEventListener('click', () => sheet.open(name));
      grid.appendChild(b);
    });
  },

  async renderRecent() {
    const memos = (await db.allMemos()).sort((a, b) => b.id - a.id);
    const el = $('#recent');
    if (!memos.length) {
      el.textContent = '種類をタップ → キーボードの🎤を押して話す → 保存';
      return;
    }
    const m = memos[0];
    el.textContent = '';
    const head = document.createElement('div');
    head.className = 'recent-head';
    head.textContent = `直前の記録（全${memos.length}件） ${fmtTime(m.start)} ${m.category}`;
    const body = document.createElement('div');
    body.className = 'recent-text';
    body.textContent = m.text || '(テキストなし)';
    el.append(head, body);
  },

  showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'record') this.renderRecent();
    if (name === 'list') list.render();
    if (name === 'settings') settingsView.render();
  },
};

/* =========================================================
 * 一覧
 * ======================================================= */
const list = {
  async render() {
    const memos = (await db.allMemos()).sort((a, b) => b.id - a.id);
    const body = $('#memoBody');
    body.innerHTML = '';
    $('#emptyMsg').style.display = memos.length ? 'none' : 'block';
    $('#count').textContent = `${memos.length} 件`;

    for (const m of memos) {
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

      const ta = document.createElement('textarea');
      ta.value = m.text;
      ta.placeholder = '(テキストなし) タップして入力';
      ta.addEventListener('change', async () => {
        m.text = ta.value;
        m.edited = true;
        await db.updateMemo(m);
        ta.classList.add('saved');
        setTimeout(() => ta.classList.remove('saved'), 1200);
      });
      td('col-text').appendChild(ta);
      const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
      ta.addEventListener('input', fit);
      requestAnimationFrame(fit);

      const oc = td('ops');
      if (m.lat != null) {
        const a = document.createElement('a');
        a.className = 'icon-btn';
        a.href = `https://maps.apple.com/?ll=${m.lat},${m.lng}&q=${encodeURIComponent(m.category)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '地図';
        oc.appendChild(a);
      }
      const del = document.createElement('button');
      del.className = 'icon-btn del';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        if (!confirm(`No.${m.id}（${m.category} ${fmtTime(m.start)}）を削除しますか？`)) return;
        await db.deleteMemo(m.id);
        this.render();
      });
      oc.appendChild(del);

      body.appendChild(tr);
    }
  },
};

/* =========================================================
 * CSVエクスポート
 * ======================================================= */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(memos) {
  const header = ['No', '車両ID', '評価者', '種類', '開始時刻', '終了時刻', '所要時間(秒)', '緯度', '経度', 'テキスト'];
  const rows = memos.map((m) => [
    m.id, m.vehicleId, m.evaluator, m.category,
    fmtDateTime(m.start), fmtDateTime(m.end), m.durationSec.toFixed(1),
    m.lat != null ? m.lat.toFixed(6) : '', m.lng != null ? m.lng.toFixed(6) : '',
    m.text,
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

$('#exportCsv').addEventListener('click', async () => {
  const memos = (await db.allMemos()).sort((a, b) => a.id - b.id);
  if (!memos.length) { toast('記録がありません'); return; }
  const blob = new Blob([buildCsv(memos)], { type: 'text/csv' });
  await deliverFile(blob, `voicememo_${sanitize(settings.vehicleId) || 'vehicle'}_${fmtStamp()}.csv`);
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
    this.storageInfo();
  },
  async storageInfo() {
    const memos = await db.allMemos();
    $('#storageInfo').textContent = `記録 ${memos.length} 件。削除前に必ずCSVを出力してください。（アプリ版 ${APP_VERSION}）`;
  },
};

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  settings = {
    vehicleId: f.vehicleId.value.trim(),
    evaluator: f.evaluator.value.trim(),
    categories: Array.from({ length: 6 }, (_, i) => f[`cat${i}`].value.trim()),
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
  if (!confirm('全ての記録を削除します。元に戻せません。よろしいですか？')) return;
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
gps.start();
requestWakeLock();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
