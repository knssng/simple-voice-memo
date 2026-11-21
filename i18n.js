'use strict';

/*
 * 表示言語（UI）の辞書：ja = 日本語 / zh = 中文（简体）
 * 文字起こしの言語（録音ボタン横の切替）とは独立した設定。
 * {name} はパラメータで置き換える。
 */
const I18N = {
  ja: {
    appTitle: '走行評価メモ',
    tabRecord: '記録', tabList: '一覧', tabSettings: '設定',

    // 記録画面
    recSelect: '種類を選択してください',
    recHold: '押している間 録音',
    recRecording: '録音中… 離すと停止',
    recentEmpty: '種類を選び、赤いボタンを押している間に話してください。離すと保存し、自動で文字起こしします。',
    noText: '(テキストなし)',
    catUnset: '(未設定{n})',
    langAria: '録音言語: {l}（タップで切替）',
    metaVehicle: '車両 {v}',
    metaNone: '車両ID未設定',

    // 一覧
    exportCsv: 'CSV出力', exportZip: 'CSV+音声ZIP',
    thNo: 'No', thCategory: '種類', thTime: '開始 / 終了', thText: 'テキスト', thOps: '操作',
    emptyList: '記録はまだありません',
    count: 'セッション{s}・{n} 件',
    sec: '{s}秒',
    play: '▶ 再生', stop: '■ 停止', redo: '再変換', map: '地図', del: '削除',
    textPh: '(テキストなし) タップして入力',
    confirmRedo: '手で修正したテキストを文字起こし結果で上書きします。よろしいですか？',
    confirmDel: 'No.{no}（{cat} {time}）を削除しますか？',
    pending: '文字起こし待ち…',
    pendingNoModel: '文字起こし待ち（モデル未準備）',
    transcribing: '文字起こし中…',
    failed: '文字起こし失敗',
    failedMsg: '文字起こし失敗：{m}',

    // 右上の状態表示・モデル
    stLoadCache: 'モデル読込中 {p}%',
    stDownload: 'モデルをダウンロード中 {p}%',
    stDetailCache: '端末から読込中…（通信なし） {p}%',
    stDetailDownload: 'ダウンロード中… {p}%（Wi-Fi推奨）',
    stFailWait: 'モデル取得失敗・{n}件待ち',
    stFail: 'モデル取得失敗',
    stBusy: '文字起こし中（残り{n}件）',
    stReady: '文字起こし準備OK',
    stDetailReady: '読込済み：{name}（{label}・オフラインでも使えます）',
    stMissingWait: 'モデル未ダウンロード・{n}件待ち',
    stMissing: 'モデル未ダウンロード',
    stDetailMissing: '未ダウンロード：{name}',
    btnRetry: 'モデルのダウンロードを再試行',
    btnLoaded: 'モデル読込済み',
    btnLoad: 'モデルをダウンロード／読込',
    errOffline: 'オフラインのためモデルをダウンロードできません。電波のある場所で再試行してください',
    errDownload: 'モデルをダウンロードできませんでした（{host}）。',
    errHintMirror: '中国国内では「モデルの配布元」を hf-mirror.com にしてください',
    errHintRetry: '通信状況を確認して再試行してください',
    errLoad: 'モデルを読み込めませんでした：{m}',
    errWorker: 'ワーカーの起動に失敗しました',
    threads: 'CPU {n}スレッド',

    // モデル・配布元
    modelSv: 'SenseVoice（FunASR・約240MB）',
    modelSvNote: '推奨。中国語・日本語とも高精度で高速（数秒の音声を1秒前後）。CPUで処理',
    modelWs: 'Whisper small（OpenAI・約250MB）',
    modelWsNote: '高精度。1件あたり数秒〜十数秒',
    modelWb: 'Whisper base（OpenAI・約80MB）',
    modelWbNote: '軽量だが誤変換が多い',
    hostHfNote: '日本など',
    hostMirrorNote: '中国国内向けミラー',

    // 設定画面
    hUiLang: '表示言語 / 界面语言',
    hEval: '評価情報', vehicleId: '車両ID', evaluator: '評価者',
    hCats: '事象の種類（6個）', catLabel: '種類 {n}', resetCats: '種類を初期値に戻す',
    hModel: '文字起こしモデル（端末内で処理）',
    modelHint: '初回のみモデルをダウンロードします（Wi-Fi推奨）。以後は端末に保存され、通信なしで文字起こしできます。',
    hHost: 'モデルの配布元',
    hostHint: '中国国内では huggingface.co に接続できないため hf-mirror.com を選んでください。一度ダウンロードしたモデルは配布元を変えても使えます（Whisper は配布元ごとに再ダウンロード）。',
    hOptions: 'オプション', useGps: '位置情報(GPS)を記録する', keepAwake: '画面を消灯させない',
    save: '保存',
    hData: 'データ管理',
    clearAll: '全記録を削除（次のセッションへ）',
    cached: '✓ ダウンロード済み（端末に保存）',
    delModel: 'このモデルを削除',
    confirmDelModel: '{name} を端末から削除しますか？',
    storage: 'セッション{s}：記録 {n} 件（音声 約{a}MB）／ モデル 約{m}MB{models}。削除前に必ずCSV/ZIPを出力してください。（アプリ版 {v}）',
    persistHome: 'ホーム画面から起動中：モデル・記録は端末に保持されます{p}',
    persisted: '（永続化済み）',
    persistTab: '⚠ Safariのタブで使用中：7日間開かないとモデル・記録が自動削除されることがあります。共有ボタン→「ホーム画面に追加」から起動してください。',
    confirmClear: '全ての記録と音声を削除し、本日（{date}）のセッション{s}を開始します（No は 1 から）。元に戻せません。よろしいですか？',

    // ポップアップ・確認
    tMicDenied: 'マイクの使用が許可されていません（設定 > アプリ > Safari > マイク）',
    tNoRecorder: 'このブラウザは録音に対応していません',
    tHold: '録音ボタンは押し続けてください',
    tRecFail: '録音できませんでした。もう一度お試しください',
    tSaveFail: '保存に失敗しました: {m}',
    tAudioMissing: '音声が見つかりません',
    tCantPlay: 'この音声は再生できません',
    tPlayErr: '再生できません: {m}',
    tNoRecords: '記録がありません',
    confirmExportBusy: '文字起こしが終わっていない記録が{n}件あります。このまま出力しますか？',
    tZip: 'ZIPを作成中…',
    tModelDeleted: 'モデルを削除しました',
    tSavedReload: '設定を保存しました。モデルを読み込み直します',
    tSaved: '設定を保存しました',
    tResetCats: '初期値を入力しました。「保存」を押すと反映されます',
    tLoadCache: 'モデルを端末から読み込みます',
    tLoadDownload: 'モデルをダウンロードします（Wi-Fi推奨）',
    tCleared: '全記録を削除しました。セッション{s}を開始します',

    // CSV
    csvHeader: ['評価日', 'セッション', 'No', '車両ID', '評価者', '種類', '言語', '録音開始', '録音終了', '録音時間(秒)', '緯度', '経度', 'テキスト', '音声ファイル'],
    csvLangJa: '日本語', csvLangZh: '中国語',

    // 種類の初期値
    defaultCats: ['Take Over', 'ナビルート無視', '交通ルール無視', '車両挙動', '乗り心地', 'その他'],
  },

  zh: {
    appTitle: '路试评价备忘',
    tabRecord: '记录', tabList: '列表', tabSettings: '设置',

    recSelect: '请选择类型',
    recHold: '按住录音',
    recRecording: '录音中… 松开停止',
    recentEmpty: '选择类型后，按住红色按钮说话。松开即保存并自动转写。',
    noText: '（无文本）',
    catUnset: '（未设置{n}）',
    langAria: '录音语言：{l}（点击切换）',
    metaVehicle: '车辆 {v}',
    metaNone: '未设置车辆ID',

    exportCsv: '导出CSV', exportZip: 'CSV+音频ZIP',
    thNo: '序号', thCategory: '类型', thTime: '开始 / 结束', thText: '文本', thOps: '操作',
    emptyList: '暂无记录',
    count: '第{s}场次・{n} 条',
    sec: '{s}秒',
    play: '▶ 播放', stop: '■ 停止', redo: '重新转写', map: '地图', del: '删除',
    textPh: '（无文本）点击输入',
    confirmRedo: '将用转写结果覆盖手动修改的文本，确定吗？',
    confirmDel: '确定删除 No.{no}（{cat} {time}）吗？',
    pending: '等待转写…',
    pendingNoModel: '等待转写（模型未就绪）',
    transcribing: '转写中…',
    failed: '转写失败',
    failedMsg: '转写失败：{m}',

    stLoadCache: '模型加载中 {p}%',
    stDownload: '模型下载中 {p}%',
    stDetailCache: '正在从本机加载…（无需联网） {p}%',
    stDetailDownload: '下载中… {p}%（建议使用Wi-Fi）',
    stFailWait: '模型获取失败・{n}条待处理',
    stFail: '模型获取失败',
    stBusy: '转写中（剩余{n}条）',
    stReady: '转写就绪',
    stDetailReady: '已加载：{name}（{label}・可离线使用）',
    stMissingWait: '模型未下载・{n}条待处理',
    stMissing: '模型未下载',
    stDetailMissing: '未下载：{name}',
    btnRetry: '重试下载模型',
    btnLoaded: '模型已加载',
    btnLoad: '下载／加载模型',
    errOffline: '当前离线，无法下载模型。请在有网络的地方重试',
    errDownload: '无法下载模型（{host}）。',
    errHintMirror: '在中国境内请将“模型下载源”设为 hf-mirror.com',
    errHintRetry: '请检查网络后重试',
    errLoad: '无法加载模型：{m}',
    errWorker: '后台处理启动失败',
    threads: 'CPU {n}线程',

    modelSv: 'SenseVoice（FunASR・约240MB）',
    modelSvNote: '推荐。中文、日语均高精度且速度快（数秒音频约1秒完成）。CPU处理',
    modelWs: 'Whisper small（OpenAI・约250MB）',
    modelWsNote: '精度高。每条需数秒至十几秒',
    modelWb: 'Whisper base（OpenAI・约80MB）',
    modelWbNote: '体积小，但识别错误较多',
    hostHfNote: '日本等地',
    hostMirrorNote: '中国境内镜像',

    hUiLang: '表示言語 / 界面语言',
    hEval: '评价信息', vehicleId: '车辆ID', evaluator: '评价人',
    hCats: '事件类型（6个）', catLabel: '类型 {n}', resetCats: '恢复默认类型',
    hModel: '转写模型（在本机处理）',
    modelHint: '仅首次需要下载模型（建议使用Wi-Fi）。之后保存在本机，无需联网即可转写。',
    hHost: '模型下载源',
    hostHint: '在中国境内无法连接 huggingface.co，请选择 hf-mirror.com。已下载的模型切换下载源后仍可使用（Whisper 需按下载源重新下载）。',
    hOptions: '选项', useGps: '记录位置信息（GPS）', keepAwake: '保持屏幕常亮',
    save: '保存',
    hData: '数据管理',
    clearAll: '删除全部记录（进入下一场次）',
    cached: '✓ 已下载（保存在本机）',
    delModel: '删除此模型',
    confirmDelModel: '确定从本机删除 {name} 吗？',
    storage: '第{s}场次：记录 {n} 条（音频 约{a}MB）／ 模型 约{m}MB{models}。删除前请务必导出CSV/ZIP。（版本 {v}）',
    persistHome: '从主屏幕启动：模型和记录保存在本机{p}',
    persisted: '（已持久化）',
    persistTab: '⚠ 正在Safari标签页中使用：7天未打开时，模型和记录可能被自动删除。请通过分享按钮→“添加到主屏幕”后启动。',
    confirmClear: '将删除全部记录和音频，并开始今天（{date}）的第{s}场次（序号从1开始）。此操作无法撤销，确定吗？',

    tMicDenied: '未允许使用麦克风（设置 > App > Safari > 麦克风）',
    tNoRecorder: '此浏览器不支持录音',
    tHold: '请按住录音按钮',
    tRecFail: '录音失败，请重试',
    tSaveFail: '保存失败：{m}',
    tAudioMissing: '找不到音频',
    tCantPlay: '无法播放此音频',
    tPlayErr: '无法播放：{m}',
    tNoRecords: '没有记录',
    confirmExportBusy: '有{n}条记录尚未完成转写。仍要导出吗？',
    tZip: '正在生成ZIP…',
    tModelDeleted: '已删除模型',
    tSavedReload: '设置已保存，将重新加载模型',
    tSaved: '设置已保存',
    tResetCats: '已填入默认值，按“保存”后生效',
    tLoadCache: '从本机加载模型',
    tLoadDownload: '开始下载模型（建议使用Wi-Fi）',
    tCleared: '已删除全部记录，开始第{s}场次',

    csvHeader: ['评价日期', '场次', '序号', '车辆ID', '评价人', '类型', '语言', '录音开始', '录音结束', '录音时长(秒)', '纬度', '经度', '文本', '音频文件'],
    csvLangJa: '日语', csvLangZh: '中文',

    defaultCats: ['Take Over', '无视导航路线', '无视交通规则', '车辆行为', '乘坐舒适性', '其他'],
  },
};

const UI_LANGS = { ja: '日本語', zh: '中文' };
let uiLang = 'ja';

/** 文言を取得（{name} をパラメータで置換） */
function t(key, params = {}) {
  const dict = I18N[uiLang] || I18N.ja;
  const s = key in dict ? dict[key] : (I18N.ja[key] ?? key);
  if (typeof s !== 'string') return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}

/** HTML の data-i18n / data-i18n-ph を現在の言語で書き換える */
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.documentElement.lang = uiLang === 'zh' ? 'zh-CN' : 'ja';
  document.title = t('appTitle');
}
