/** Shared deployment; each execution uses its own user's state and resources. */
function initializeSettings() {
  assertUserContext_(true);
  return withLock_(() => initializeUser_());
}

// Caller holds the user lock. Save the new ID before formatting so retries reuse it.
function initializeUser_() {
  const email = assertUserContext_(true);
  const p = props_();
  if ((p.getProperty('USER_EMAIL') && p.getProperty('USER_EMAIL') !== email) ||
      (p.getProperty('INSTANCE_SCRIPT_ID') && p.getProperty('INSTANCE_SCRIPT_ID') !== ScriptApp.getScriptId())) {
    throw new Error('本人のアカウントで初期設定を確認してください。');
  }
  let book;
  const id = p.getProperty('SPREADSHEET_ID');
  if (id) book = SpreadsheetApp.openById(id);
  else {
    book = SpreadsheetApp.create('面談通知 - 通知履歴');
    p.setProperty('SPREADSHEET_ID', book.getId());
  }
  let ledger = book.getSheetByName('_通知履歴');
  if (!ledger) ledger = book.insertSheet('_通知履歴');
  ledger.getRange(1, 1, 1, 7).setValues([['キー', '状態', '通知本文', '再試行キー', '初回送信試行', '通知先', '送信受付時刻']]);
  ledger.setFrozenRows(1);
  // A ledger can be the only visible sheet; never hide it.
  if (!p.getProperty('CONFIG_SETTINGS')) p.setProperty('CONFIG_SETTINGS', JSON.stringify(readSettings_()));
  if (!p.getProperty('DASHBOARD_STATUS')) setStatus_('停止中', '', false);
  p.setProperties({ USER_EMAIL: email, INSTANCE_SCRIPT_ID: ScriptApp.getScriptId(), SCHEMA_VERSION: '3' });
  return { initialized: true };
}

function book_() {
  assertOwner_();
  const id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('通知設定メニューから初期設定を実行してください。');
  return SpreadsheetApp.openById(id);
}

function readSettings_() {
  const settings = JSON.parse(props_().getProperty('CONFIG_SETTINGS') || 'null');
  if (!settings) return NotificationCore.validateSettings('primary', '【面談】');
  return NotificationCore.validateSettings(settings.calendarId, settings.prefix);
}

function ledgerSheet_() {
  const sheet = book_().getSheetByName('_通知履歴');
  if (!sheet) throw new Error('通知履歴シートがありません。初期設定を再実行してください。');
  return sheet;
}

function readLedger_() {
  const sheet = ledgerSheet_();
  return sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
}

function writeLedger_(rows) {
  if (!rows.length) return;
  // All cells are plain text; a malicious calendar title must not become a formula.
  const sheet = ledgerSheet_();
  const capacity = sheet.getMaxRows();
  if (rows.length + 1 > capacity) sheet.insertRowsAfter(capacity, rows.length + 1 - capacity);
  sheet.getRange(2, 1, rows.length, 7).setNumberFormat('@').setValues(rows);
  SpreadsheetApp.flush();
}


function installMonitoringTriggers_(calendarId) {
  assertOwner_();
  // Keep the working pair until the new ledger and ACTIVE_CONFIG are both stored.
  const previous = ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_);
  return { previous, created: createMonitoringTriggers_(calendarId) };
}

function createMonitoringTriggers_(calendarId) {
  const created = [];
  try {
    created.push(ScriptApp.newTrigger('onCalendarChanged').forUserCalendar(calendarId).onEventUpdated().create());
    created.push(ScriptApp.newTrigger('pollCalendar').timeBased().everyMinutes(5).create());
    return created;
  } catch (_) {
    created.forEach(trigger => { try { ScriptApp.deleteTrigger(trigger); } catch (__) {} });
    throw new Error('監視トリガーを作成できませんでした。権限と割当上限を確認してください。以前の監視設定は維持されています。');
  }
}

function deleteMonitoringTriggers_(triggers) {
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function restoreLedger_(rows) {
  const sheet = ledgerSheet_();
  const extras = sheet.getLastRow() - 1 - rows.length;
  if (rows.length) writeLedger_(rows);
  if (extras > 0) sheet.getRange(rows.length + 2, 1, extras, 7).clearContent();
  SpreadsheetApp.flush();
}

function monitoringPairIntact_(calendarId) {
  const triggers = ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_);
  if (triggers.length !== 2) return false;
  const calendar = triggers.find(trigger => trigger.getHandlerFunction() === 'onCalendarChanged');
  const poll = triggers.find(trigger => trigger.getHandlerFunction() === 'pollCalendar');
  return !!(calendar && poll && typeof calendar.getTriggerSourceId === 'function' && calendar.getTriggerSourceId() === calendarId);
}

function safeStopMonitoring_() {
  try {
    const config = JSON.parse(props_().getProperty('ACTIVE_CONFIG') || 'null');
    if (config && config.enabled) {
      config.enabled = false;
      props_().setProperty('ACTIVE_CONFIG', JSON.stringify(config));
    }
  } catch (_) {}
  try {
    ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_).forEach(trigger => {
      try { ScriptApp.deleteTrigger(trigger); } catch (__) {}
    });
  } catch (_) {}
  try { setStatus_('停止中', '監視の切り替えに失敗したため停止しました。再開すると、その時点以降の新規予定が対象です。', false); }
  catch (_) {}
}

function recoverMonitoring_(previousConfigJson, snapshotRows, created) {
  try {
    let removedNew = true;
    created.forEach(trigger => {
      try { ScriptApp.deleteTrigger(trigger); }
      catch (_) { removedNew = false; }
    });
    // Disabling must win over restoring the old calendar while new triggers still exist.
    if (!removedNew) throw new Error('new triggers remain');
    if (snapshotRows) restoreLedger_(snapshotRows);
    const p = props_();
    if ((previousConfigJson || null) !== (p.getProperty('ACTIVE_CONFIG') || null)) {
      if (previousConfigJson) p.setProperty('ACTIVE_CONFIG', previousConfigJson);
      else if (typeof p.deleteProperty === 'function') p.deleteProperty('ACTIVE_CONFIG');
      else throw new Error('config remains');
    }
    const previous = JSON.parse(previousConfigJson || 'null');
    if (!previous || !previous.enabled) {
      deleteMonitoringTriggers_(ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_));
      if (ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_).length) throw new Error('triggers remain');
      return true;
    }
    if (!monitoringPairIntact_(previous.calendarId)) {
      deleteMonitoringTriggers_(ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_));
      createMonitoringTriggers_(previous.calendarId);
    }
    if (!monitoringPairIntact_(previous.calendarId)) throw new Error('pair missing');
    return true;
  } catch (_) {
    safeStopMonitoring_();
    return false;
  }
}

function applyMonitoringChange_(calendarId, previousConfigJson, snapshotRows, commit) {
  const installed = installMonitoringTriggers_(calendarId);
  const previousTriggers = installed && Array.isArray(installed.previous) ? installed.previous : [];
  const created = installed && Array.isArray(installed.created) ? installed.created : [];
  let phase = 'history';
  try {
    commit(next => { phase = next; });
    phase = 'triggers';
    deleteMonitoringTriggers_(previousTriggers);
  } catch (_) {
    const restored = recoverMonitoring_(previousConfigJson, phase === 'history' ? null : snapshotRows, created);
    if (!restored) throw new Error('監視の切り替えに失敗したため停止しました。再開すると、その時点以降の新規予定が対象です。');
    if (phase === 'triggers') throw new Error('監視トリガーを整理できませんでした。以前の監視設定は維持されています。');
    if (phase === 'ledger') throw new Error('監視設定を保存できませんでした。以前の監視設定は維持されています。');
    throw new Error('通知履歴を保存できませんでした。以前の監視設定は維持されています。');
  }
}

function isMonitoringTrigger_(trigger) {
  return ['pollCalendar', 'onCalendarChanged'].includes(trigger.getHandlerFunction());
}

function startNotifications() {
  assertHumanOwner_();
  return startMonitoring_();
}

function startMonitoring_() {
  return withLock_(() => {
    assertOwner_();
    lineConfig_();
    const p = props_();
    const settings = readSettings_();
    settings.requestedCalendarId = settings.calendarId;
    try { settings.calendarId = Calendar.Calendars.get(settings.calendarId).id; }
    catch (_) { throw new Error('対象カレンダーを確認できません。カレンダーID・閲覧権限と割当上限を確認してください。'); }
    if (!settings.calendarId) throw new Error('対象カレンダーを確認できません。');
    const previousConfigJson = p.getProperty('ACTIVE_CONFIG');
    const previous = JSON.parse(previousConfigJson || 'null');
    if (previous && previous.enabled && previous.calendarId === settings.calendarId && previous.prefix === settings.prefix) {
      applyMonitoringChange_(settings.calendarId, previousConfigJson, null, mark => {
        mark('ledger');
        previous.requestedCalendarId = settings.requestedCalendarId;
        p.setProperty('ACTIVE_CONFIG', JSON.stringify(previous));
      });
      setStatus_('稼働中', '設定を確認しました。現在の監視を継続します。', false);
      return { message: '設定を確認しました。現在の監視を継続します。' };
    }
    const startedAt = new Date().toISOString();
    let baseline;
    try { baseline = collectChanges_(settings, null); }
    catch (_) { throw new Error('カレンダーの初回同期に失敗しました。閲覧権限・予定件数と割当上限を確認してください。以前の監視設定は維持されています。'); }
    const next = { ...settings, epoch: Utilities.getUuid(), startedAt, syncToken: baseline.token, enabled: true };
    const rows = readLedger_();
    const snapshot = rows.map(row => row.slice());
    rows.forEach(row => { if (row[1] === 'PENDING') row[1] = row[4] ? 'REVIEW' : 'SKIPPED'; });
    mergeChanges_(rows, baseline.items, next);
    applyMonitoringChange_(settings.calendarId, previousConfigJson, snapshot, mark => {
      mark('history');
      writeLedger_(rows);
      mark('ledger');
      p.setProperty('ACTIVE_CONFIG', JSON.stringify(next));
    });
    const message = '既存予定を通知せず監視を開始しました。カレンダー変更時と5分間隔の復旧確認で処理します。';
    setStatus_('稼働中', message, false);
    return { message };
  });
}

function stopNotifications() {
  assertHumanOwner_();
  return stopMonitoring_();
}

function stopMonitoring_() {
  return withLock_(() => {
    assertOwner_();
    const p = props_();
    const config = JSON.parse(p.getProperty('ACTIVE_CONFIG') || 'null');
    if (config) { config.enabled = false; p.setProperty('ACTIVE_CONFIG', JSON.stringify(config)); }
    ScriptApp.getProjectTriggers().filter(isMonitoringTrigger_).forEach(t => ScriptApp.deleteTrigger(t));
    setStatus_('停止中', '再開すると、その時点以降の新規予定が対象です。停止中の予定は通知しません。', false);
    return { message: '通知を停止しました。' };
  });
}

function sendTestNotification(input) {
  assertHumanOwner_();
  if (!input || input.confirmed !== true) throw new Error('送信の確認が必要です。');
  return testNotification_();
}

function testNotification_() {
  return withLock_(() => {
    assertOwner_();
    lineConfig_();
    const rows = readLedger_();
    rows.push(['TEST|' + Utilities.getUuid(), 'PENDING', 'Calendar LINE通知の接続テストです。', Utilities.getUuid(), '', '', '']);
    writeLedger_(rows);
    const result = drainPending_(rows, { epoch: 'TEST' });
    return { message: result + '\nSENTはLINE APIによる受付を示します。LINEアプリへの到着も確認してください。' };
  });
}

function sendLine_(line, row) {
  assertOwner_();
  try {
    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, followRedirects: false,
      headers: { Authorization: 'Bearer ' + line.token, 'X-Line-Retry-Key': row[3] },
      payload: JSON.stringify({ to: row[5], messages: [{ type: 'text', text: row[2] }] }),
    });
    const code = response.getResponseCode();
    const headers = response.getAllHeaders();
    const duplicateAccepted = code === 409 && Object.keys(headers).some(key => key.toLowerCase() === 'x-line-accepted-request-id' && headers[key]);
    return { accepted: code === 200 || duplicateAccepted, retry: code >= 500 || code === 429, code };
  } catch (_) {
    return { accepted: false, retry: true, code: 0 };
  }
}

function drainPending_(rows, config) {
  const line = lineConfig_();
  const begun = Date.now();
  let attempted = 0;
  let blockedCode = null;
  for (const row of rows) {
    if (attempted >= 20 || Date.now() - begun > 120000) break;
    if (row[1] !== 'PENDING' || !String(row[0]).startsWith(config.epoch + '|')) continue;
    if (row[4] && (Date.now() - Date.parse(row[4]) > 23 * 3600000 || row[5] !== line.recipient || !Number.isFinite(Date.parse(row[4])))) {
      row[1] = 'REVIEW';
      writeLedger_(rows);
      continue;
    }
    if (!row[4]) {
      row[4] = new Date().toISOString();
      row[5] = line.recipient;
    }
    // Persist before any network call; a crash must retain the retry key and payload.
    writeLedger_(rows);
    attempted++;
    const result = sendLine_(line, row);
    if (result.accepted) {
      row[1] = 'SENT';
      row[6] = new Date().toISOString();
      row[2] = ''; // Minimize retained calendar content after API acceptance.
    } else if (!result.retry) {
      row[1] = result.code === 409 ? 'REVIEW' : 'BLOCKED';
    }
    writeLedger_(rows);
    if (!result.accepted) { blockedCode = result.code; break; }
  }
  const pending = rows.filter(r => r[1] === 'PENDING').length;
  const review = rows.filter(r => ['REVIEW', 'BLOCKED'].includes(r[1])).length;
  return '送信試行 ' + attempted + '件 / 待機 ' + pending + '件 / 要確認 ' + review + '件' +
    (blockedCode !== null ? '（LINE HTTP ' + blockedCode + '。0は通信結果不明）' : '');
}

function collectChanges_(config, syncToken) {
  assertOwner_();
  let pageToken;
  const items = [];
  const begun = Date.now();
  for (let page = 0; page < 40; page++) {
    const query = { maxResults: 2500, singleEvents: false, showDeleted: true,
      fields: 'items(id,status,summary,created,start,end,endTimeUnspecified,htmlLink,recurringEventId,description,hangoutLink,conferenceData(entryPoints(entryPointType,uri))),nextPageToken,nextSyncToken' };
    if (syncToken) query.syncToken = syncToken;
    if (pageToken) query.pageToken = pageToken;
    const result = Calendar.Events.list(config.calendarId, query);
    items.push(...(result.items || []));
    if (!result.nextPageToken) {
      if (!result.nextSyncToken) throw new Error('カレンダーの同期トークンを取得できませんでした。');
      return { items, token: result.nextSyncToken };
    }
    pageToken = result.nextPageToken;
    if (Date.now() - begun > 120000) break;
  }
  throw new Error('カレンダーの予定件数が多すぎるため同期を中断しました。小規模な専用カレンダーを指定してください。');
}

function mergeChanges_(rows, items, config) {
  const known = new Map(rows.map(row => [String(row[0]), row]));
  items.forEach(event => {
    if (!event.id) return;
    const key = config.epoch + '|' + event.id;
    const previous = known.get(key);
    if (previous) {
      if (event.status === 'cancelled' && previous[1] === 'PENDING') previous[1] = previous[4] ? 'REVIEW' : 'CANCELLED';
      return;
    }
    if (!(Date.parse(event.created) > Date.parse(config.startedAt))) return;
    const notify = NotificationCore.shouldNotify(event, config, false);
    const row = [key, notify ? 'PENDING' : 'IGNORED', notify ? NotificationCore.message(event) : '', notify ? Utilities.getUuid() : '', '', '', ''];
    rows.push(row);
    known.set(key, row);
  });
  return rows;
}

function isExpiredSync_(error) {
  return Number(error.code || (error.details || {}).code) === 410 || /sync token is no longer valid|full sync is required/i.test(String(error.message || ''));
}

function readStatus_() {
  return JSON.parse(props_().getProperty('DASHBOARD_STATUS') || 'null') || { state: '停止中', detail: '', lastChecked: '' };
}

function setStatus_(state, detail, checked) {
  const previous = readStatus_();
  props_().setProperty('DASHBOARD_STATUS', JSON.stringify({ state, detail, lastChecked: checked ? new Date().toISOString() : previous.lastChecked }));
}

function pollCalendar(e) {
  return runTrigger_('pollCalendar', e);
}

function onCalendarChanged(e) {
  return runTrigger_('onCalendarChanged', e);
}

function runTrigger_(handler, e) {
  // A supplied event is not authorization: verify the execution identity first.
  assertOwner_();

  if (!e || !e.triggerUid) return;
  return withLock_(() => {
    const registered = ScriptApp.getProjectTriggers().find(t => t.getHandlerFunction() === handler && String(t.getUniqueId()) === String(e.triggerUid));
    if (!registered) return;
    const config = JSON.parse(props_().getProperty('ACTIVE_CONFIG') || 'null');
    if (!config || !config.enabled || (handler === 'onCalendarChanged' && e.calendarId !== config.calendarId)) return;
    if (handler === 'onCalendarChanged' && typeof registered.getTriggerSourceId === 'function' && registered.getTriggerSourceId() !== config.calendarId) return;
    return runMonitoring_(true);
  });
}

function runMonitoring_(lockHeld) {
  const work = () => {
    assertOwner_();
    const p = props_();
    const config = JSON.parse(p.getProperty('ACTIVE_CONFIG') || 'null');
    if (!config || !config.enabled) return;
    let calendarFailed = false;
    let rows;
    try {
      let delta;
      try { delta = collectChanges_(config, config.syncToken); }
      catch (error) {
        if (!isExpiredSync_(error)) throw error;
        // Keep the original cutoff and ledger; full sync must not resend old events.
        delta = collectChanges_(config, null);
      }
      rows = mergeChanges_(readLedger_(), delta.items, config);
      writeLedger_(rows);
      config.syncToken = delta.token;
      p.setProperty('ACTIVE_CONFIG', JSON.stringify(config));
    } catch (_) {
      calendarFailed = true;
      // Discard in-memory partial changes; drain only what was durably persisted.
      rows = readLedger_();
    }
    let result;
    try { result = drainPending_(rows, config); }
    catch (_) {
      setStatus_('要確認', '待機通知の処理に失敗しました。LINE設定と通知履歴・GASの割当上限を確認してください。', false);
      throw new Error('通知処理に失敗しました。設定シートの処理結果を確認してください。');
    }
    if (calendarFailed) {
      setStatus_('要確認', 'カレンダー同期に失敗。閲覧権限と割当上限を確認してください。保存済み通知の処理結果: ' + result, false);
      throw new Error('通知処理に失敗しました。カレンダー同期を次回に再試行します。保存済みのLINE通知は処理しました。');
    }
    setStatus_('稼働中', result, true);
  };
  return lockHeld ? work() : withLock_(work);
}

function props_() {
  assertUserContext_(false);
  return PropertiesService.getUserProperties();
}

function withLock_(work) {
  assertUserContext_(false);
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) throw new Error('別の処理を実行中です。少し待って再試行してください。');
  try { return work(); } finally { lock.releaseLock(); }
}

function assertOwner_() {
  const email = assertUserContext_(false);
  const p = props_();
  if (p.getProperty('USER_EMAIL') !== email) throw new Error('本人のアカウントで初期設定を実行してください。');
  if (p.getProperty('INSTANCE_SCRIPT_ID') !== ScriptApp.getScriptId() || p.getProperty('SCHEMA_VERSION') !== '3' || !p.getProperty('SPREADSHEET_ID')) {
    throw new Error('初期設定を実行してください。');
  }
}

function assertHumanOwner_() {
  assertUserContext_(true);
  assertOwner_();
  // Script-ID and saved binding checks above work in both Web and bound contexts.
  // Do not call getActiveSpreadsheet(): the bound-context API is unavailable in Web apps.
}

function getLineSettings() {
  assertUserContext_(true);
  const p = props_();
  return { type: p.getProperty('LINE_TYPE') || 'user', recipient: p.getProperty('LINE_RECIPIENT') || '', hasToken: !!p.getProperty('LINE_TOKEN') };
}

function lineConfig_() {
  assertOwner_();
  const p = props_();
  return NotificationCore.validateLine({ type: p.getProperty('LINE_TYPE'), recipient: p.getProperty('LINE_RECIPIENT'), token: p.getProperty('LINE_TOKEN') || '' });
}

function saveLineSettings(input) {
  assertUserContext_(true);
  return withLock_(() => {
    assertUserContext_(true);
    const p = props_();
    const next = NotificationCore.validateLine(input, { allowEmptyToken: true });
    initializeUser_();
    if (next.recipient !== p.getProperty('LINE_RECIPIENT') || next.token !== p.getProperty('LINE_TOKEN')) {
      // Never retry an ambiguous old request to a different recipient/channel.
      const rows = readLedger_();
      let changed = false;
      rows.forEach(row => {
        if (row[1] === 'PENDING' && row[4]) { row[1] = 'REVIEW'; changed = true; }
      });
      if (changed) writeLedger_(rows);
    }
    p.setProperties({ LINE_TYPE: next.type, LINE_RECIPIENT: next.recipient, LINE_TOKEN: next.token });
    return { saved: true };
  });
}


/** Shared deployment: the configured organization boundary is never inferred. */
function assertUserContext_(human) {
  const raw = PropertiesService.getScriptProperties().getProperty('WORKSPACE_DOMAINS');
  const validDomain = domain => typeof domain === 'string' && domain.length <= 253 &&
    domain === domain.toLowerCase() && domain.includes('.') &&
    domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const domains = typeof raw === 'string' ? raw.split(',').map(value => value.trim()) : [];
  if (!domains.length || domains.some(domain => !validDomain(domain))) throw new Error('組織ドメインの設定を管理者に確認してください。');
  const email = Session.getEffectiveUser().getEmail();
  if (typeof email !== 'string' || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(email) ||
      !domains.includes(email.split('@')[1])) throw new Error('組織のGoogleアカウントを確認してください。本人のアカウントで操作してください。');
  if (human && (!Session.getActiveUser().getEmail() || Session.getActiveUser().getEmail() !== email)) throw new Error('本人のGoogleアカウントで操作してください。');
  return email;
}
