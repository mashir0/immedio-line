/** Shared internal Web app. Deployment: DOMAIN / USER_ACCESSING. */
function userInitialized_(email) {
  const p = props_();
  const savedEmail = p.getProperty('USER_EMAIL');
  const scriptId = p.getProperty('INSTANCE_SCRIPT_ID');
  const schema = p.getProperty('SCHEMA_VERSION');
  if ((savedEmail && savedEmail !== email) || (scriptId && scriptId !== ScriptApp.getScriptId()) || (schema && schema !== '3')) {
    throw new Error('本人の初期設定情報が一致しません。管理者に連絡してください。');
  }
  return !!(savedEmail && scriptId && schema === '3' && p.getProperty('SPREADSHEET_ID'));
}

function doGet() {
  assertUserContext_(true);
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('面談通知 — 社内管理画面')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Caller must be authorized and hold the current user's lock. */
function dashboardForUser_(email) {
  const initialized = userInitialized_(email);
  const config = initialized ? JSON.parse(props_().getProperty('ACTIVE_CONFIG') || 'null') : null;
  const triggers = initialized ? ScriptApp.getProjectTriggers() : [];
  const counts = { pending: 0, review: 0, blocked: 0 };
  if (initialized) readLedger_().forEach(row => {
    if (row[1] === 'PENDING') counts.pending++;
    if (row[1] === 'REVIEW') counts.review++;
    if (row[1] === 'BLOCKED') counts.blocked++;
  });
  const settings = readSettings_();
  const status = readStatus_();
  const line = getLineSettings();
  return {
    initialized,
    account: { email },
    settings: { calendarId: settings.calendarId, prefix: settings.prefix },
    status: { state: String(status.state || '停止中'), detail: String(status.detail || ''), lastChecked: String(status.lastChecked || '') },
    monitoring: {
      enabled: !!(config && config.enabled),
      calendarId: config ? config.calendarId : '',
      requestedCalendarId: config ? (config.requestedCalendarId || config.calendarId) : '',
      prefix: config ? config.prefix : '',
      calendarTrigger: !!config && triggers.some(t => t.getHandlerFunction() === 'onCalendarChanged' && t.getTriggerSourceId() === config.calendarId),
      recoveryTrigger: triggers.some(t => t.getHandlerFunction() === 'pollCalendar'),
    },
    line: { type: line.type, recipient: line.recipient, hasToken: !!line.hasToken, token: initialized ? (props_().getProperty('LINE_TOKEN') || '') : '' },
    counts,
  };
}

function getDashboard() {
  const email = assertUserContext_(true);
  return withLock_(() => dashboardForUser_(email));
}

function saveDashboardSettings(input) {
  const email = assertUserContext_(true);
  if (!input || typeof input !== 'object') throw new Error('カレンダーと接頭辞を入力してください。');
  const settings = NotificationCore.validateSettings(input.calendarId, input.prefix);
  return withLock_(() => {
    assertUserContext_(true);
    initializeUser_(); // Explicit first save creates this employee's private history file.
    props_().setProperty('CONFIG_SETTINGS', JSON.stringify(settings));
    return dashboardForUser_(email);
  });
}

function webAction_(work, fallback) {
  assertUserContext_(true);
  const result = work();
  return { message: typeof result === 'string' ? result : (result && result.message) || fallback, dashboard: getDashboard() };
}

function startFromWeb() {
  return webAction_(() => startMonitoring_(), 'カレンダー変更時の監視と5分間隔の復旧確認を開始しました。');
}

function stopFromWeb() {
  return webAction_(() => stopMonitoring_(), '自分の通知を停止しました。');
}

function testFromWeb(input) {
  assertUserContext_(true);
  if (!input || input.confirmed !== true) throw new Error('テスト送信の確認が必要です。');
  return webAction_(() => testNotification_(), 'テスト通知を試行しました。LINEへの到着も確認してください。');
}
