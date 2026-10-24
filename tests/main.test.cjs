const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeBook(id = 'sheet1') {
  const sheets = new Map();
  return {
    getId: () => id, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
    getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) {
      const cells = [];
      const sheet = {
        getRange(row, col, nr = 1, nc = 1) {
          const range = {
            getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells[row - 1 + i]?.[col - 1 + j] ?? '')),
            setValues(values) { values.forEach((line, i) => line.forEach((v, j) => { (cells[row - 1 + i] ||= [])[col - 1 + j] = v; })); return range; },
            getValue: () => cells[row - 1]?.[col - 1] ?? '',
            setValue(value) { return range.setValues([[value]]); },
            setNumberFormat: () => range,
            clearContent() { return range.setValues(Array.from({ length: nr }, () => Array(nc).fill(''))); },
          };
          return range;
        },
        getMaxRows: () => 1000, insertRowsAfter: () => sheet,
        getLastRow() {
          for (let i = cells.length - 1; i >= 0; i--) {
            if ((cells[i] || []).some(value => value !== '' && value != null)) return i + 1;
          }
          return 0;
        },
        setFrozenRows: () => sheet, setColumnWidth: () => sheet, hideSheet: () => sheet,
      };
      sheets.set(name, sheet);
      return sheet;
    },
  };
}

function app() {
  const file = path.join(__dirname, '..', 'Main.js');
  assert.ok(fs.existsSync(file), 'Main.js must implement the setup menu and LINE settings');
  const data = { SPREADSHEET_ID: 'sheet1', SCHEMA_VERSION: '3', INSTANCE_SCRIPT_ID: 'script1', USER_EMAIL: 'employee@example.com', LINE_TOKEN: 'existing', LINE_RECIPIENT: 'U' + 'a'.repeat(32), LINE_TYPE: 'user' };
  let locked = false;
  const book = fakeBook();
  const menu = [];
  const ui = { Button: { YES: 'YES' }, ButtonSet: { YES_NO: 'YES_NO' }, createMenu: () => { const m = { addItem: (title, fn) => { menu.push([title, fn]); return m; }, addSeparator: () => m, addToUi: () => {} }; return m; }, alert: () => {} };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'WORKSPACE_DOMAINS' ? 'example.com' : null }), getUserProperties: () => ({
      getProperty: key => data[key] ?? null,
      setProperty: (key, value) => { data[key] = String(value); },
      setProperties: values => Object.assign(data, values),
      deleteProperty: key => { delete data[key]; },
    }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'employee@example.com' }), getActiveUser: () => ({ getEmail: () => 'employee@example.com' }) },
    LockService: { getScriptLock: () => assert.fail('script lock forbidden'), getUserLock: () => ({ tryLock: () => { if (locked) return false; locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    Utilities: { getUuid: () => '11111111-2222-4333-8444-555555555555' },
    SpreadsheetApp: { create: () => book, getActiveSpreadsheet: () => assert.fail('bound API forbidden'), openById: () => book, getUi: () => ui, flush: () => {} },
    ScriptApp: { getScriptId: () => 'script1' },
    Date, JSON, console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Core.js'), 'utf8') + '\n' + fs.readFileSync(file, 'utf8'), context);
  return { context, data, book, menu, locked: () => locked };
}

test('new event queue sends formatted time, configured meeting URL and notes through LINE payload', () => {
  const { context: c } = app();
  const cfg = { epoch: 'format', prefix: '【面談】', startedAt: '2026-10-01T00:00:00Z' };
  const event = { id: 'format1', created: '2026-10-23T00:00:00Z', summary: '【面談】A社', start: { dateTime: '2026-10-25T18:30:00+09:00' }, end: { dateTime: '2026-10-25T19:00:00+09:00' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', description: '職務経歴書を準備してください。' };
  const rows = c.mergeChanges_([], [event], cfg);
  let payload;
  c.writeLedger_ = () => {};
  c.UrlFetchApp = { fetch: (url, options) => { payload = JSON.parse(options.payload); return { getResponseCode: () => 200, getAllHeaders: () => ({}) }; } };
  c.drainPending_(rows, cfg);
  assert.match(payload.messages[0].text, /10-25\(日\) 18:30〜19:00/);
  assert.match(payload.messages[0].text, /https:\/\/meet.google.com\/abc-defg-hij/);
  assert.match(payload.messages[0].text, /メモ\n職務経歴書を準備してください。/);
  assert.equal(rows[0][1], 'SENT');
});

test('human settings RPC works in Web context without any active-spreadsheet method', () => {
  const { context: c } = app();
  c.SpreadsheetApp.getActiveSpreadsheet = () => { throw new Error('not available in Web context'); };
  assert.equal(c.getLineSettings().hasToken, true);
  c.readLedger_ = () => [];
  assert.equal(c.saveLineSettings({ type: 'user', recipient: 'U' + 'a'.repeat(32), token: '' }).saved, true);
});

test('incremental sync pages retain the original token and queue each new event only once', () => {
  const { context: c, data } = app();
  const cfg = { epoch: 'run1', calendarId: 'cal1', prefix: '【面談】', startedAt: '2026-10-01T00:00:00Z', syncToken: 'original', enabled: true };
  const event = { id: 'new', summary: '【面談】A', created: '2026-10-02T00:00:00Z' };
  const calls = [];
  c.Calendar = { Events: { list: (id, query) => {
    calls.push({ id, ...query });
    return query.pageToken ? { items: [event], nextSyncToken: 'next' } : { items: [event, { ...event, id: 'other', summary: '無関係' }], nextPageToken: 'page2' };
  } } };
  const delta = c.collectChanges_(cfg, cfg.syncToken);
  assert.equal(delta.token, 'next');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].syncToken, 'original');
  for (const field of ['description', 'hangoutLink', 'conferenceData(entryPoints(entryPointType,uri))', 'endTimeUnspecified']) assert.ok(calls[0].fields.includes(field), 'must fetch ' + field);
  assert.ok(!calls[0].fields.includes('attendees') && !calls[0].fields.includes('location'));
  assert.equal(calls[1].pageToken, 'page2');
  let rows = c.mergeChanges_([], delta.items, cfg);
  assert.equal(rows.filter(r => r[1] === 'PENDING').length, 1);
  assert.equal(rows.filter(r => r[1] === 'IGNORED').length, 1);
  rows = c.mergeChanges_(rows, [{ ...event, id: 'other', summary: '【面談】後から変更' }, event], cfg);
  assert.equal(rows.filter(r => r[1] === 'PENDING').length, 1);
});

test('notification worker stores ledger before advancing token and reuses it across repeated runs', () => {
  const { context: c, data } = app();
  data.ACTIVE_CONFIG = JSON.stringify({ epoch: 'run1', calendarId: 'cal', prefix: '【面談】', startedAt: '2026-10-01T00:00:00Z', syncToken: 'old', enabled: true });
  c.Calendar = { Events: { list: () => ({ items: [{ id: 'n', summary: '【面談】A', created: '2026-10-02T00:00:00Z' }], nextSyncToken: 'next' }) } };
  let rows = [];
  c.readLedger_ = () => rows;
  c.writeLedger_ = next => { assert.equal(JSON.parse(data.ACTIVE_CONFIG).syncToken, 'old'); rows = next; };
  c.drainPending_ = () => { assert.equal(JSON.parse(data.ACTIVE_CONFIG).syncToken, 'next'); };
  c.setStatus_ = () => {};
  c.runMonitoring_();
  assert.equal(rows[0][1], 'PENDING');
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).syncToken, 'next');
});

test('start baselines existing events, replaces only its own trigger, and stop disables polling', () => {
  const { context: c, data } = app();
  c.initializeSettings();
  const triggers = [{ getHandlerFunction: () => 'unrelated', getUniqueId: () => 'keep' }];
  c.ScriptApp = {
    getScriptId: () => 'script1',
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: fn => {
      const create = () => { const t = { getHandlerFunction: () => fn, getUniqueId: () => String(triggers.length) }; triggers.push(t); return t; };
      return {
        timeBased: () => ({ everyMinutes: n => ({ create: () => { assert.equal(n, 5); return create(); } }) }),
        forUserCalendar: id => ({ onEventUpdated: () => ({ create: () => { assert.equal(id, 'resolved-calendar'); return create(); } }) }),
      };
    },
  };
  c.Calendar = { Calendars: { get: () => ({ id: 'resolved-calendar' }) }, Events: { list: () => ({ items: [{ id: 'existing' }], nextSyncToken: 'baseline' }) } };
  c.startNotifications();
  const initial = JSON.parse(data.ACTIVE_CONFIG);
  assert.equal(initial.enabled, true);
  assert.equal(initial.syncToken, 'baseline');
  assert.equal(initial.calendarId, 'resolved-calendar');
  assert.equal(initial.requestedCalendarId, 'primary');
  assert.equal(c.readLedger_().length, 0);
  c.startNotifications();
  assert.equal(triggers.filter(t => t.getHandlerFunction() === 'onCalendarChanged').length, 1);
  assert.equal(triggers.filter(t => t.getHandlerFunction() === 'pollCalendar').length, 1);
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).startedAt, initial.startedAt);
  c.stopNotifications();
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).enabled, false);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].getHandlerFunction(), 'unrelated');
});

test('failed trigger pair creation rolls back without touching previous config or queue', () => {
  const { context: c, data } = app();
  c.initializeSettings();
  const old = { enabled: true, calendarId: 'old', prefix: 'old', epoch: 'r', startedAt: '2026-01-01', syncToken: 'token' };
  data.ACTIVE_CONFIG = JSON.stringify(old);
  const prior = { getHandlerFunction: () => 'pollCalendar' };
  const created = { getHandlerFunction: () => 'onCalendarChanged' };
  const triggers = [prior];
  c.ScriptApp.getProjectTriggers = () => triggers.slice();
  c.ScriptApp.deleteTrigger = t => triggers.splice(triggers.indexOf(t), 1);
  c.ScriptApp.newTrigger = fn => ({
    forUserCalendar: () => ({ onEventUpdated: () => ({ create: () => { triggers.push(created); return created; } }) }),
    timeBased: () => ({ everyMinutes: () => ({ create: () => { throw new Error('secret'); } }) }),
  });
  c.Calendar = { Calendars: { get: () => ({ id: 'new' }) }, Events: { list: () => ({ items: [], nextSyncToken: 'newtoken' }) } };
  c.readLedger_ = () => [['r|e', 'PENDING', 'body', 'uuid', '', '', '']];
  c.writeLedger_ = () => assert.fail('queue must survive failed trigger installation');
  assert.throws(() => c.startNotifications(), /トリガー/);
  assert.deepEqual(triggers, [prior]);
  assert.deepEqual(JSON.parse(data.ACTIVE_CONFIG), old);
});

function switchSetup(options = {}) {
  const { context: c, data } = app();
  c.initializeSettings();
  const old = { enabled: true, calendarId: 'old-cal', requestedCalendarId: 'old-cal', prefix: '【面談】', epoch: 'old-epoch', startedAt: '2026-01-01T00:00:00Z', syncToken: 'old-token' };
  data.ACTIVE_CONFIG = JSON.stringify(old);
  data.CONFIG_SETTINGS = JSON.stringify({ calendarId: 'new-cal', prefix: '【面談】' });
  data.DASHBOARD_STATUS = JSON.stringify({ state: '稼働中', detail: '継続', lastChecked: '2026-10-01T00:00:00Z' });
  c.writeLedger_([['old-epoch|event', 'PENDING', '本文', 'retry-key', '', '', '']]);
  const originalRows = c.readLedger_().map(row => row.slice());
  const triggers = [
    { source: 'old-cal', getHandlerFunction: () => 'onCalendarChanged', getUniqueId: () => 'old-calendar', getTriggerSourceId: () => 'old-cal' },
    { source: 'old-cal', getHandlerFunction: () => 'pollCalendar', getUniqueId: () => 'old-poll', getTriggerSourceId: () => 'old-cal' },
  ];
  let deletes = 0;
  const saved = [];
  c.ScriptApp = {
    getScriptId: () => 'script1',
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(trigger) {
      deletes += 1;
      if (options.failDelete === 'second' && deletes === 2) throw new Error('secret-delete');
      if (options.failDelete === 'all') throw new Error('secret-delete');
      const index = triggers.indexOf(trigger);
      if (index >= 0) triggers.splice(index, 1);
    },
    newTrigger(fn) {
      let source = null;
      const builder = {
        forUserCalendar(id) { source = id; return builder; },
        onEventUpdated: () => builder,
        timeBased: () => builder,
        everyMinutes(n) { assert.equal(n, 5); return builder; },
        create() {
          const trigger = { source, getHandlerFunction: () => fn, getUniqueId: () => 'new-' + (triggers.length + 1), getTriggerSourceId: () => source };
          triggers.push(trigger);
          return trigger;
        },
      };
      return builder;
    },
  };
  c.Calendar = {
    Calendars: { get: id => ({ id }) },
    Events: { list: () => ({ items: [{ id: 'fresh', summary: '【面談】新規', created: '2099-01-01T00:00:00Z' }], nextSyncToken: 'new-token' }) },
  };
  const write = c.writeLedger_;
  let configWrites = 0;
  c.writeLedger_ = rows => {
    if (options.failWrite) throw new Error('secret-ledger');
    saved.push({
      phase: 'ledger',
      previous: triggers.filter(trigger => trigger.source === 'old-cal').length,
      nextCalendar: triggers.filter(trigger => trigger.getTriggerSourceId() === 'new-cal').length,
    });
    return write(rows);
  };
  c.PropertiesService.getUserProperties = () => ({
    getProperty: key => data[key] ?? null,
    setProperty(key, value) {
      if (key === 'ACTIVE_CONFIG') {
        configWrites += 1;
        saved.push({
          phase: 'config',
          previous: triggers.filter(trigger => trigger.source === 'old-cal').length,
          nextCalendar: triggers.filter(trigger => trigger.getTriggerSourceId() === 'new-cal').length,
        });
        if (options.failConfig && configWrites === 1) throw new Error('secret-property');
      }
      data[key] = String(value);
    },
    setProperties: values => Object.assign(data, values),
    deleteProperty: key => { delete data[key]; },
  });
  return { c, data, old, triggers, originalRows, saved };
}

test('calendar switch publishes the saved state before retiring the previous trigger pair', () => {
  const { c, data, triggers, saved } = switchSetup();
  c.startNotifications();
  assert.ok(saved.some(step => step.phase === 'ledger' && step.previous === 2 && step.nextCalendar === 1));
  assert.ok(saved.some(step => step.phase === 'config' && step.previous === 2 && step.nextCalendar === 1));
  assert.equal(triggers.filter(trigger => trigger.source === 'old-cal').length, 0);
  assert.equal(triggers.filter(trigger => trigger.source === 'new-cal' && trigger.getHandlerFunction() === 'onCalendarChanged').length, 1);
  assert.equal(triggers.filter(trigger => trigger.getHandlerFunction() === 'pollCalendar').length, 1);
  const config = JSON.parse(data.ACTIVE_CONFIG);
  assert.equal(config.enabled, true);
  assert.equal(config.calendarId, 'new-cal');
  assert.equal(config.syncToken, 'new-token');
  assert.equal(c.readLedger_().some(row => row[0] === 'old-epoch|event' && row[1] === 'SKIPPED'), true);
  assert.equal(c.readLedger_().some(row => row[0].endsWith('|fresh') && row[1] === 'PENDING'), true);
});

test('ledger save failure while switching calendars keeps the previous monitoring pair', () => {
  const { c, data, old, triggers, originalRows } = switchSetup({ failWrite: true });
  assert.throws(() => c.startNotifications(), error => /通知履歴を保存できませんでした。以前の監視設定は維持されています。/.test(error.message) && !/secret/.test(error.message));
  assert.deepEqual(c.readLedger_(), originalRows);
  assert.deepEqual(JSON.parse(data.ACTIVE_CONFIG), old);
  assert.deepEqual(triggers.map(trigger => trigger.getUniqueId()), ['old-calendar', 'old-poll']);
  assert.equal(JSON.parse(data.DASHBOARD_STATUS).state, '稼働中');
});

test('config save failure while switching calendars restores the ledger and previous pair', () => {
  const { c, data, old, triggers, originalRows } = switchSetup({ failConfig: true });
  assert.throws(() => c.startNotifications(), error => /監視設定を保存できませんでした。以前の監視設定は維持されています。/.test(error.message) && !/secret/.test(error.message));
  assert.deepEqual(c.readLedger_(), originalRows);
  assert.deepEqual(JSON.parse(data.ACTIVE_CONFIG), old);
  assert.deepEqual(triggers.map(trigger => trigger.getUniqueId()), ['old-calendar', 'old-poll']);
  assert.equal(JSON.parse(data.DASHBOARD_STATUS).state, '稼働中');
});

test('partial removal of the previous trigger pair rolls back to that calendar', () => {
  const { c, data, old, triggers, originalRows } = switchSetup({ failDelete: 'second' });
  assert.throws(() => c.startNotifications(), error => /監視トリガーを整理できませんでした。以前の監視設定は維持されています。/.test(error.message) && !/secret/.test(error.message));
  assert.deepEqual(c.readLedger_(), originalRows);
  assert.deepEqual(JSON.parse(data.ACTIVE_CONFIG), old);
  assert.equal(triggers.filter(trigger => trigger.source === 'new-cal').length, 0);
  assert.equal(triggers.filter(trigger => trigger.getHandlerFunction() === 'onCalendarChanged' && trigger.getTriggerSourceId() === 'old-cal').length, 1);
  assert.equal(triggers.filter(trigger => trigger.getHandlerFunction() === 'pollCalendar').length, 1);
  assert.equal(JSON.parse(data.DASHBOARD_STATUS).state, '稼働中');
});

test('unremovable replacement triggers stop monitoring instead of leaving a mismatched calendar', () => {
  const { c, data, triggers } = switchSetup({ failDelete: 'all' });
  assert.throws(() => c.startNotifications(), error => /監視の切り替えに失敗したため停止しました/.test(error.message) && !/secret/.test(error.message));
  const config = JSON.parse(data.ACTIVE_CONFIG);
  assert.equal(config.enabled, false);
  assert.equal(JSON.parse(data.DASHBOARD_STATUS).state, '停止中');
  let lists = 0;
  c.Calendar.Events.list = () => { lists++; return { items: [], nextSyncToken: 'unused' }; };
  triggers.filter(trigger => ['pollCalendar', 'onCalendarChanged'].includes(trigger.getHandlerFunction())).forEach(trigger => {
    const event = { triggerUid: trigger.getUniqueId(), calendarId: trigger.source };
    if (trigger.getHandlerFunction() === 'pollCalendar') c.pollCalendar(event);
    else c.onCalendarChanged(event);
  });
  assert.equal(lists, 0);
});

test('public trigger entry points require registered matching events and owner context', () => {
  const { context: c, data } = app();
  data.ACTIVE_CONFIG = JSON.stringify({ enabled: true, calendarId: 'cal' });
  const triggers = ['pollCalendar', 'onCalendarChanged'].map((fn, i) => ({ getHandlerFunction: () => fn, getUniqueId: () => String(i + 1), getTriggerSourceId: () => 'cal' }));
  c.ScriptApp.getProjectTriggers = () => triggers;
  let runs = 0;
  c.runMonitoring_ = () => { runs++; };
  c.pollCalendar();
  c.pollCalendar({ triggerUid: '2' });
  c.onCalendarChanged({ triggerUid: '2', calendarId: 'foreign' });
  c.onCalendarChanged({ triggerUid: 'fake', calendarId: 'cal' });
  assert.equal(runs, 0);
  c.pollCalendar({ triggerUid: '1' });
  c.onCalendarChanged({ triggerUid: '2', calendarId: 'cal' });
  assert.equal(runs, 2);
  c.Session.getActiveUser = () => ({ getEmail: () => '' });
  c.onCalendarChanged({ triggerUid: '2', calendarId: 'cal' });
  assert.equal(runs, 3);
  c.Session.getActiveUser = () => ({ getEmail: () => 'foreign@example.com' });
  c.pollCalendar({ triggerUid: '1' });
  c.Session.getActiveUser = () => ({ getEmail: () => '' });
  c.Session.getEffectiveUser = () => ({ getEmail: () => 'foreign@example.com' });
  assert.throws(() => c.pollCalendar({ triggerUid: '1' }), /本人/);
  assert.equal(runs, 4);
});

test('human RPC and menus reject blank or foreign active users even under owner execution', () => {
  const { context: c, data } = app();
  c.initializeSettings();
  for (const email of ['', 'foreign@example.com']) {
    c.Session.getActiveUser = () => ({ getEmail: () => email });
    for (const fn of ['initializeSettings', 'startNotifications', 'stopNotifications', 'sendTestNotification', 'getLineSettings', 'saveLineSettings']) {
      const before = JSON.stringify(data);
      assert.throws(() => c[fn]({}), /本人/, fn);
      assert.equal(JSON.stringify(data), before);
    }
  }
});

test('no-UI action helpers use saved binding, lock and owner without active spreadsheet', () => {
  const { context: c, data, locked } = app();
  c.initializeSettings();
  c.SpreadsheetApp.getUi = () => assert.fail('no UI in backend');
  c.SpreadsheetApp.getActiveSpreadsheet = () => assert.fail('no active spreadsheet in backend');
  c.Calendar = { Calendars: { get: () => { assert.equal(locked(), true); return { id: 'cal' }; } }, Events: { list: () => ({ items: [], nextSyncToken: 'baseline' }) } };
  c.installMonitoringTriggers_ = () => {};
  c.ScriptApp.getProjectTriggers = () => [];
  c.UrlFetchApp = { fetch: () => { assert.equal(locked(), true); return { getResponseCode: () => 200, getAllHeaders: () => ({}) }; } };
  assert.ok(c.startMonitoring_().message);
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).enabled, true);
  assert.ok(c.testNotification_().message);
  assert.ok(c.stopMonitoring_().message);
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).enabled, false);
  assert.equal(locked(), false);
  c.Session.getEffectiveUser = () => ({ getEmail: () => 'foreign' });
  for (const fn of ['startMonitoring_', 'stopMonitoring_', 'testNotification_']) assert.throws(() => c[fn](), /本人/);
});

test('copied instance cannot read LINE secrets or access Calendar, LINE or triggers', () => {
  const { context: c, data } = app();
  data.INSTANCE_SCRIPT_ID = 'source-script';
  c.ScriptApp.getProjectTriggers = () => assert.fail('must not inspect source triggers');
  c.Calendar = { Events: { list: () => assert.fail('must not access Calendar') } };
  c.UrlFetchApp = { fetch: () => assert.fail('must not send LINE') };
  for (const work of [() => c.lineConfig_(), () => c.collectChanges_({ calendarId: 'source' }), () => c.sendLine_({ token: 'source' }, []), () => c.installMonitoringTriggers_('source')]) {
    assert.throws(work, /初期設定/);
  }
});

test('start errors mask external service details and preserve previous active config', () => {
  const { context: c, data } = app();
  c.initializeSettings();
  data.ACTIVE_CONFIG = '{"enabled":true,"calendarId":"old"}';
  const before = data.ACTIVE_CONFIG;
  c.Calendar = { Calendars: { get: () => { throw new Error('sensitive-token-from-service'); } } };
  assert.throws(() => c.startMonitoring_(), error => /カレンダー/.test(error.message) && !/sensitive/.test(error.message));
  assert.equal(data.ACTIVE_CONFIG, before);
  c.Calendar.Calendars.get = () => ({ id: 'new' });
  c.Calendar.Events = { list: () => { throw new Error('sensitive-token-from-service'); } };
  assert.throws(() => c.startMonitoring_(), error => /カレンダー/.test(error.message) && !/sensitive/.test(error.message));
  assert.equal(data.ACTIVE_CONFIG, before);
});

test('LINE queue persists retry metadata before HTTP and reuses the same payload after transient failure', () => {
  const { context: c } = app();
  const rows = [['run1|event', 'PENDING', '通知本文', '11111111-2222-4333-8444-555555555555', '', '', '']];
  let persisted;
  const requests = [];
  c.writeLedger_ = next => { persisted = JSON.parse(JSON.stringify(next)); };
  c.UrlFetchApp = { fetch: (url, options) => {
    assert.ok(persisted[0][4]);
    assert.equal(persisted[0][5], 'U' + 'a'.repeat(32));
    requests.push({ url, options });
    return { getResponseCode: () => requests.length === 1 ? 500 : 200, getAllHeaders: () => ({}) };
  } };
  c.drainPending_(rows, { epoch: 'run1' });
  assert.equal(rows[0][1], 'PENDING');
  c.drainPending_(rows, { epoch: 'run1' });
  assert.equal(rows[0][1], 'SENT');
  assert.equal(rows[0][2], '');
  assert.equal(requests[0].options.headers['X-Line-Retry-Key'], requests[1].options.headers['X-Line-Retry-Key']);
  assert.equal(requests[0].options.payload, requests[1].options.payload);
  assert.equal(requests[0].options.followRedirects, false);
});

test('expired retries and changed destinations are held for review rather than sent blindly', () => {
  const { context: c, data } = app();
  const rows = [['run1|old', 'PENDING', '本文', 'uuid', new Date(Date.now() - 24 * 3600000).toISOString(), data.LINE_RECIPIENT, '']];
  c.writeLedger_ = () => {};
  c.UrlFetchApp = { fetch: () => assert.fail('must not send expired request') };
  c.drainPending_(rows, { epoch: 'run1' });
  assert.equal(rows[0][1], 'REVIEW');
  rows.push(['run1|attempted', 'PENDING', '本文', 'uuid2', new Date().toISOString(), data.LINE_RECIPIENT, '']);
  c.readLedger_ = () => rows;
  c.saveLineSettings({ type: 'group', recipient: 'C' + 'b'.repeat(32), token: '' });
  assert.equal(rows[1][1], 'REVIEW');
});

test('test notification requires explicit confirmation and records API acceptance without exposing token', () => {
  const { context: c, book } = app();
  c.initializeSettings();
  let calls = 0;
  c.UrlFetchApp = { fetch: () => { calls++; return { getResponseCode: () => 200, getAllHeaders: () => ({}) }; } };
  assert.throws(() => c.sendTestNotification(), /確認/);
  assert.equal(calls, 0);
  c.sendTestNotification({ confirmed: true });
  assert.equal(calls, 1);
  assert.equal(c.readLedger_()[0][1], 'SENT');
  assert.equal(c.readLedger_()[0][2], '');
});

test('initial sync also queues new events created while baseline is being read', () => {
  const { context: c, data } = app();
  c.initializeSettings();
  c.installMonitoringTriggers_ = () => {};
  const originalNow = Date.now;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-01T00:00:00Z'])); } static now() { return Date.parse('2026-10-01T00:00:00Z'); } }
  c.Date = Clock;
  c.Calendar = { Calendars: { get: () => ({ id: 'cal' }) }, Events: { list: () => ({ items: [{ id: 'new-during-sync', summary: '【面談】A', created: '2026-10-01T00:00:01Z' }], nextSyncToken: 'baseline' }) } };
  c.startNotifications();
  assert.equal(c.readLedger_()[0]?.[1], 'PENDING');
});

test('ledger expands its row grid before writing beyond the default sheet capacity', () => {
  const { context: c, book } = app();
  c.initializeSettings();
  const sheet = book.getSheetByName('_通知履歴');
  sheet.getMaxRows = () => 1000;
  let added = 0;
  sheet.insertRowsAfter = (after, count) => { assert.equal(after, 1000); added += count; };
  const rows = Array.from({ length: 1001 }, (_, i) => ['e' + i, 'IGNORED', '', '', '', '', '']);
  c.writeLedger_(rows);
  assert.ok(added >= 2);
});

test('expired calendar tokens recover by full sync without discarding the original notification cutoff', () => {
  const { context: c, data } = app();
  const cfg = { epoch: 'run1', calendarId: 'cal', prefix: '【面談】', startedAt: '2026-10-01T00:00:00Z', syncToken: 'expired', enabled: true };
  data.ACTIVE_CONFIG = JSON.stringify(cfg);
  const calls = [];
  c.Calendar = { Events: { list: (id, q) => {
    calls.push(q);
    if (q.syncToken) throw { code: 410 };
    return { items: [
      { id: 'old', created: '2026-09-01T00:00:00Z', summary: '【面談】既存' },
      { id: 'new', created: '2026-10-02T00:00:00Z', summary: '【面談】新規' },
    ], nextSyncToken: 'recovered' };
  } } };
  let rows = [];
  c.readLedger_ = () => rows;
  c.writeLedger_ = value => { rows = value; };
  c.drainPending_ = () => 'ok';
  c.setStatus_ = () => {};
  c.runMonitoring_();
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'run1|new');
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).startedAt, cfg.startedAt);
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).syncToken, 'recovered');
});

test('partial sync failures keep the previous token and do not send incomplete changes', () => {
  const { context: c, data } = app();
  data.ACTIVE_CONFIG = JSON.stringify({ epoch: 'r', calendarId: 'c', prefix: 'x', startedAt: '2026-10-01T00:00:00Z', syncToken: 'old', enabled: true });
  c.Calendar = { Events: { list: (id, q) => {
    if (q.pageToken) throw new Error('network');
    return { items: [{ id: 'e' }], nextPageToken: 'next' };
  } } };
  c.writeLedger_ = () => assert.fail('must not commit partial pages');
  c.readLedger_ = () => [];
  c.drainPending_ = rows => { assert.equal(rows.length, 0, 'only durable prior requests may be sent'); return 'ok'; };
  c.setStatus_ = () => {};
  assert.throws(() => c.runMonitoring_(), /通知処理に失敗/);
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).syncToken, 'old');
});

test('LINE accepts a proven duplicate retry but not a generic conflict and masks transport errors', () => {
  const { context: c } = app();
  const row = ['r|e', 'PENDING', '本文', 'uuid', '', 'U' + 'a'.repeat(32), ''];
  c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 409, getAllHeaders: () => ({ 'X-Line-Accepted-Request-Id': 'request' }) }) };
  assert.equal(c.sendLine_({ token: 'secret' }, row).accepted, true);
  c.UrlFetchApp.fetch = () => ({ getResponseCode: () => 409, getAllHeaders: () => ({}) });
  assert.equal(c.sendLine_({ token: 'secret' }, row).accepted, false);
  c.UrlFetchApp.fetch = () => { throw new Error('sensitive secret from transport'); };
  const result = c.sendLine_({ token: 'secret' }, row);
  assert.equal(result.retry, true);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('foreign users cannot read LINE setup or change it', () => {
  const { context: c, data } = app();
  c.Session.getEffectiveUser = () => ({ getEmail: () => 'someone@example.com' });
  assert.throws(() => c.getLineSettings(), /本人/);
  assert.throws(() => c.saveLineSettings({}), /本人/);
  assert.throws(() => c.initializeSettings(), /本人/);
});

test('cancelled queued events are not sent, while already-attempted cancellations require review', () => {
  const { context: c } = app();
  const cfg = { epoch: 'r', prefix: 'x', startedAt: '2026-10-01T00:00:00Z' };
  const rows = [['r|a', 'PENDING', '本文', 'uuid', '', '', ''], ['r|b', 'PENDING', '本文', 'uuid2', '2026-10-02', 'Uxx', '']];
  c.mergeChanges_(rows, [{ id: 'a', status: 'cancelled' }, { id: 'b', status: 'cancelled' }], cfg);
  assert.equal(rows[0][1], 'CANCELLED');
  assert.equal(rows[1][1], 'REVIEW');
});

test('persisted LINE requests are retried even when calendar synchronization is unavailable', () => {
  const { context: c, data } = app();
  data.ACTIVE_CONFIG = JSON.stringify({ epoch: 'r', calendarId: 'cal', prefix: 'x', startedAt: '2026-10-01T00:00:00Z', syncToken: 'old', enabled: true });
  let rows = [['r|event', 'PENDING', '既存の待機通知', '11111111-2222-4333-8444-555555555555', '', '', '']];
  c.readLedger_ = () => rows;
  c.writeLedger_ = value => { rows = value; };
  c.Calendar = { Events: { list: () => { throw new Error('calendar offline'); } } };
  let sent = 0;
  c.UrlFetchApp = { fetch: () => { sent++; return { getResponseCode: () => 200, getAllHeaders: () => ({}) }; } };
  const statuses = [];
  c.setStatus_ = (...values) => statuses.push(values);
  assert.throws(() => c.runMonitoring_(), /通知処理に失敗/);
  assert.equal(sent, 1);
  assert.equal(rows[0][1], 'SENT');
  assert.equal(JSON.parse(data.ACTIVE_CONFIG).syncToken, 'old');
  assert.equal(statuses.at(-1)[0], '要確認');
  assert.match(statuses.at(-1)[1], /カレンダー/);
});

test('LINE dialog saves later recipient changes, deletes a blank token and never returns credentials', () => {
  const { context: c, data, locked } = app();
  const recipient = 'C' + 'b'.repeat(32);
  c.readLedger_ = () => [];
  c.writeLedger_ = () => {};
  c.saveLineSettings({ type: 'group', recipient, token: '' });
  assert.equal(data.LINE_RECIPIENT, recipient);
  assert.equal(data.LINE_TOKEN, '');
  const visible = c.getLineSettings();
  assert.equal(visible.recipient, recipient);
  assert.equal(visible.hasToken, false);
  assert.equal('token' in visible, false);
  assert.equal(locked(), false);
  assert.throws(() => c.lineConfig_(), /トークン/);
  const before = JSON.stringify(data);
  assert.throws(() => c.saveLineSettings({ type: 'group', recipient: 'invalid', token: 'new' }), /通知先ID/);
  assert.equal(JSON.stringify(data), before);
});


test('workspace authorization fails closed before user properties or resources', () => {
  const { context: c } = app();
  let domains = 'example.com';
  c.PropertiesService.getScriptProperties = () => ({ getProperty: key => { assert.equal(key, 'WORKSPACE_DOMAINS'); return domains; } });
  c.PropertiesService.getUserProperties = () => assert.fail('unauthorized user store read');
  for (const value of [null, '', 'Example.com', 'example.com,', '*.example.com', '@example.com', 'example..com']) {
    domains = value;
    assert.throws(() => c.assertUserContext_(true), /組織|ドメイン/);
  }
  domains = 'example.com,company.co.jp';
  for (const email of ['', 'employee@evil.example.com', 'employee@example.com.evil', 'bad@@example.com']) {
    c.Session.getEffectiveUser = () => ({ getEmail: () => email });
    assert.throws(() => c.assertUserContext_(false), /組織|アカウント/);
  }
  c.Session.getEffectiveUser = () => ({ getEmail: () => 'employee@example.com' });
  c.Session.getActiveUser = () => ({ getEmail: () => 'other@example.com' });
  assert.throws(() => c.assertUserContext_(true), /本人/);
  assert.equal(c.assertUserContext_(false), 'employee@example.com');
});


test('first human save creates one private ledger and repeat initialization preserves user state', () => {
  const { context: c, data, book } = app();
  Object.keys(data).forEach(key => delete data[key]);
  let creates = 0;
  c.SpreadsheetApp.create = title => { assert.equal(title, '面談通知 - 通知履歴'); creates++; return book; };
  assert.equal(c.readSettings_().calendarId, 'primary');
  assert.equal(c.readStatus_().state, '停止中');
  assert.equal(c.getLineSettings().hasToken, false);
  assert.equal(creates, 0);
  assert.throws(() => c.saveLineSettings({ type: 'user', recipient: 'invalid', token: 'secret' }), /通知先ID/);
  assert.equal(creates, 0);
  c.saveLineSettings({ type: 'user', recipient: 'U' + 'a'.repeat(32), token: 'alice-token' });
  assert.equal(creates, 1);
  assert.equal(data.USER_EMAIL, 'employee@example.com');
  assert.equal(data.SCHEMA_VERSION, '3');
  assert.equal(data.INSTANCE_SCRIPT_ID, 'script1');
  assert.ok(book.getSheetByName('_通知履歴'));
  c.writeLedger_([['r|one', 'PENDING', 'private body', 'uuid', '', '', '']]);
  data.CONFIG_SETTINGS = JSON.stringify({ calendarId: 'custom', prefix: 'custom' });
  c.setStatus_('custom', 'keep', false);
  c.initializeSettings();
  assert.equal(creates, 1);
  assert.equal(c.readLedger_()[0][2], 'private body');
  assert.equal(c.readSettings_().calendarId, 'custom');
  assert.equal(c.readStatus_().detail, 'keep');
  assert.equal(data.LINE_TOKEN, 'alice-token');
});

test('failed setup persists sheet ID for retry and inaccessible saved history never creates replacement', () => {
  const { context: c, data, book } = app();
  Object.keys(data).forEach(key => delete data[key]);
  let creates = 0;
  c.SpreadsheetApp.create = () => { creates++; return book; };
  const insert = book.insertSheet;
  book.insertSheet = () => { throw new Error('setup failed'); };
  assert.throws(() => c.initializeSettings(), /setup failed/);
  assert.equal(data.SPREADSHEET_ID, 'sheet1');
  assert.equal(data.SCHEMA_VERSION, undefined);
  book.insertSheet = insert;
  c.initializeSettings();
  assert.equal(creates, 1);
  c.SpreadsheetApp.openById = () => { throw new Error('inaccessible'); };
  assert.throws(() => c.initializeSettings(), /inaccessible/);
  assert.equal(creates, 1);
  assert.equal(data.SPREADSHEET_ID, 'sheet1');
});

// Simulates Apps Script services, not real Google authorization or API delivery.
function sharedApp() {
  let effective = 'alice@techbiz.com', active = effective, seq = 0;
  const stores = new Map(), locks = new Set(), books = new Map(), triggers = [], requests = [], calendarCalls = [];
  const state = { domains: 'techbiz.com', httpCode: 200, calendarError: null, items: [], failPoll: false };
  const userData = () => { if (!stores.has(effective)) stores.set(effective, {}); return stores.get(effective); };
  const c = vm.createContext({ Date, JSON, console,
    Session: { getEffectiveUser: () => ({ getEmail: () => effective }), getActiveUser: () => ({ getEmail: () => active }) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: key => { assert.equal(key, 'WORKSPACE_DOMAINS'); return state.domains; } }),
      getUserProperties: () => { const data = userData(); return { getProperty: key => data[key] ?? null, setProperty: (k, v) => { data[k] = String(v); }, setProperties: values => Object.assign(data, values), deleteProperty: key => { delete data[key]; } }; },
    },
    LockService: { getScriptLock: () => assert.fail('global lock forbidden'), getUserLock: () => { const owner = effective; return {
      tryLock: () => { if (locks.has(owner)) return false; locks.add(owner); return true; },
      releaseLock: () => { assert.ok(locks.delete(owner)); },
    }; } },
    Utilities: { getUuid: () => 'uuid-' + ++seq },
    SpreadsheetApp: {
      create: () => { assert.ok(locks.has(effective)); const book = fakeBook('book-' + ++seq); books.set(book.getId(), { owner: effective, book }); return book; },
      openById: id => { const entry = books.get(id); assert.equal(entry?.owner, effective, 'personal books cannot cross owners'); return entry.book; },
      getActiveSpreadsheet: () => assert.fail('bound API forbidden'), getUi: () => assert.fail('UI forbidden'), flush: () => {},
    },
    ScriptApp: {
      getScriptId: () => 'shared-script', getProjectTriggers: () => triggers.filter(t => t.owner === effective),
      deleteTrigger: t => { assert.equal(t.owner, effective); triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: handler => { const owner = effective; let source = null; const builder = {
        forUserCalendar: id => { source = id; return builder; }, onEventUpdated: () => builder,
        timeBased: () => builder, everyMinutes: n => { assert.equal(n, 5); return builder; },
        create: () => { assert.ok(locks.has(owner)); if (state.failPoll && handler === 'pollCalendar') throw Error('quota'); const uid = String(++seq); const t = { owner, source, getHandlerFunction: () => handler, getUniqueId: () => uid, getTriggerSourceId: () => t.source }; triggers.push(t); return t; },
      }; return builder; },
    },
    Calendar: { Calendars: { get: id => { assert.ok(locks.has(effective)); return { id: id === 'primary' ? effective : id }; } }, Events: { list: (id, query) => {
      assert.ok(locks.has(effective)); calendarCalls.push({ owner: effective, id, query: { ...query } });
      if (state.calendarError) throw state.calendarError;
      return { items: state.items, nextSyncToken: 'token-' + effective };
    } } },
    UrlFetchApp: { fetch: (url, options) => { assert.ok(locks.has(effective)); const persisted = c.readLedger_(); assert.ok(persisted.some(r => r[3] === options.headers['X-Line-Retry-Key'] && r[4])); requests.push({ owner: effective, options: JSON.parse(JSON.stringify(options)) }); return { getResponseCode: () => state.httpCode, getAllHeaders: () => ({}) }; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'Main.js'), 'utf8'), c);
  return { c, state, stores, locks, books, triggers, requests, calendarCalls, data: userData,
    as(email, activeEmail = email) { effective = email; active = activeEmail; },
    trigger(handler) { const t = triggers.find(t => t.owner === effective && t.getHandlerFunction() === handler); return { triggerUid: t.getUniqueId(), calendarId: t.source }; },
    save(token, letter) { return c.saveLineSettings({ type: 'user', recipient: 'U' + letter.repeat(32), token }); },
  };
}

test('clearing a saved token affects only its owner and blocks outbound sending', () => {
  const h = sharedApp(), { c } = h;
  h.save('alice-test', 'a');
  h.as('bob@techbiz.com'); h.save('bob-test', 'b');
  h.as('alice@techbiz.com');
  c.saveLineSettings({ type: 'user', recipient: 'U' + 'a'.repeat(32), token: '' });
  assert.equal(c.getLineSettings().hasToken, false);
  assert.throws(() => c.lineConfig_(), /トークン/);
  h.as('bob@techbiz.com');
  assert.equal(c.lineConfig_().token, 'bob-test');
  assert.equal(h.requests.length, 0);
});

test('real shared backend loads only the authenticated employee token without creating resources', () => {
  const h = sharedApp(), { c } = h;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Web.js'), 'utf8'), c);
  h.save('alice-test-token', 'a');
  const books = h.books.size;
  assert.equal(c.getDashboard().line.token, 'alice-test-token');
  assert.equal(h.books.size, books);
  h.as('bob@techbiz.com');
  assert.equal(c.getDashboard().line.token, '');
  h.save('bob-test-token', 'b');
  assert.equal(c.getDashboard({ user: 'alice@techbiz.com' }).line.token, 'bob-test-token');
  assert.doesNotMatch(JSON.stringify(c.getDashboard()), /alice-test-token/);
  h.as('bob@techbiz.com', 'alice@techbiz.com');
  assert.throws(() => c.getDashboard(), /本人/);
  h.as('outsider@example.com');
  assert.throws(() => c.getDashboard(), /組織/);
  assert.equal(h.requests.length, 0);
});

test('shared Web API integrates with real backend for two employees without nested locks or first-visit writes', () => {
  const h = sharedApp(), { c } = h;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Web.js'), 'utf8'), c);
  assert.equal(c.getDashboard().initialized, false);
  assert.equal(h.books.size, 0);
  assert.equal(h.triggers.length, 0);
  c.saveDashboardSettings({ calendarId: 'primary', prefix: '【Alice】' });
  h.save('alice-private-token', 'a');
  const aliceView = c.startFromWeb().dashboard;
  assert.equal(aliceView.monitoring.calendarTrigger, true);
  assert.equal(aliceView.monitoring.recoveryTrigger, true);
  assert.equal(aliceView.monitoring.requestedCalendarId, 'primary');
  assert.equal(aliceView.account.email, 'alice@techbiz.com');
  h.as('bob@techbiz.com');
  const bobFirst = c.getDashboard();
  assert.equal(bobFirst.initialized, false);
  assert.equal(bobFirst.line.hasToken, false);
  assert.equal(bobFirst.settings.prefix, '【面談】');
  assert.equal(h.books.size, 1);
  c.saveDashboardSettings({ calendarId: 'primary', prefix: '【Bob】' });
  h.save('bob-private-token', 'b');
  const bobView = c.startFromWeb().dashboard;
  assert.equal(bobView.account.email, 'bob@techbiz.com');
  assert.doesNotMatch(JSON.stringify(bobView), /Alice|alice-private-token/);
  assert.equal(bobView.line.token, 'bob-private-token');
  assert.equal(h.books.size, 2);
  h.locks.add('alice@techbiz.com');
  assert.equal(c.getDashboard().settings.prefix, '【Bob】');
  h.as('alice@techbiz.com');
  assert.throws(() => c.getDashboard(), /別の処理/);
  h.locks.delete('alice@techbiz.com');
  c.stopFromWeb();
  h.as('bob@techbiz.com');
  assert.equal(c.getDashboard().monitoring.enabled, true);
  assert.equal(h.triggers.length, 2);
  assert.equal(h.locks.size, 0);
});

test('calendar callback rejects a registered UID whose real source differs from active config', () => {
  const h = sharedApp(), { c } = h;
  h.save('alice-token', 'a'); c.startMonitoring_();
  const event = h.trigger('onCalendarChanged');
  h.triggers.find(t => t.getHandlerFunction() === 'onCalendarChanged').source = 'foreign-calendar';
  const before = h.calendarCalls.length;
  c.onCalendarChanged(event);
  assert.equal(h.calendarCalls.length, before);
});

test('Alice and Bob independently initialize, save secrets, start, repair and stop in one shared script', () => {
  const h = sharedApp(), { c } = h;
  for (const email of ['alice@techbiz.com', 'bob@techbiz.com']) {
    h.as(email);
    assert.equal(c.getLineSettings().hasToken, false);
    assert.equal(c.readSettings_().calendarId, 'primary');
    assert.equal(c.readStatus_().state, '停止中');
    assert.equal(h.books.size, email.startsWith('alice') ? 0 : 1);
    assert.throws(() => h.save('invalid-token', 'z'), /通知先ID/);
    h.save(email + '-token', email.startsWith('alice') ? 'a' : 'b');
    c.startNotifications();
    const initial = JSON.parse(h.data().ACTIVE_CONFIG);
    c.startNotifications();
    const repaired = JSON.parse(h.data().ACTIVE_CONFIG);
    assert.equal(repaired.startedAt, initial.startedAt);
    assert.equal(repaired.epoch, initial.epoch);
    assert.equal(repaired.syncToken, initial.syncToken);
    assert.equal(repaired.requestedCalendarId, 'primary');
    c.initializeSettings();
    assert.equal(c.getLineSettings().hasToken, true);
    assert.equal('token' in c.getLineSettings(), false);
  }
  assert.equal(h.books.size, 2);
  assert.equal(h.triggers.length, 4);
  const alice = h.stores.get('alice@techbiz.com'), bob = h.stores.get('bob@techbiz.com');
  assert.notEqual(alice.SPREADSHEET_ID, bob.SPREADSHEET_ID);
  assert.notEqual(alice.LINE_TOKEN, bob.LINE_TOKEN);
  assert.equal(c.book_('arbitrary-other-book').getId(), bob.SPREADSHEET_ID);
  const bobSnapshot = JSON.stringify(bob);
  h.as('alice@techbiz.com'); c.stopNotifications();
  assert.equal(JSON.stringify(bob), bobSnapshot);
  assert.equal(h.triggers.length, 2);
  assert.ok(h.triggers.every(t => t.owner === 'bob@techbiz.com'));
  h.as('bob@techbiz.com'); c.stopNotifications();
  assert.equal(h.triggers.length, 0);
  assert.equal(h.locks.size, 0);
});

test('creator callbacks isolate failed requests, retry payloads, checkpoints and credentials across users', () => {
  const h = sharedApp(), { c } = h;
  h.save('alice-secret', 'a'); c.startMonitoring_();
  const aliceEvent = h.trigger('pollCalendar');
  h.state.httpCode = 500;
  c.sendTestNotification({ confirmed: true });
  assert.equal(c.readLedger_()[0][1], 'PENDING');
  h.as('bob@techbiz.com'); h.save('bob-secret', 'b'); c.startMonitoring_();
  const bobEvent = h.trigger('pollCalendar'), bobBefore = h.data().ACTIVE_CONFIG;
  const calendarBefore = h.calendarCalls.length;
  c.pollCalendar(aliceEvent);
  assert.equal(h.calendarCalls.length, calendarBefore);
  h.state.httpCode = 200;
  c.sendTestNotification({ confirmed: true });
  assert.equal(c.readLedger_()[0][1], 'SENT');
  h.as('alice@techbiz.com', 'bob@techbiz.com');
  assert.throws(() => c.sendTestNotification({ confirmed: true }), /本人/);
  h.state.calendarError = Error('calendar offline');
  assert.throws(() => c.pollCalendar(aliceEvent), /カレンダー/);
  assert.equal(c.readLedger_()[0][1], 'PENDING');
  h.state.calendarError = null;
  c.withLock_(() => c.drainPending_(c.readLedger_(), { epoch: 'TEST' }));
  assert.equal(c.readLedger_()[0][1], 'SENT');
  const aliceRequests = h.requests.filter(r => r.owner === 'alice@techbiz.com');
  assert.equal(aliceRequests.length, 2);
  assert.equal(aliceRequests[0].options.payload, aliceRequests[1].options.payload);
  assert.equal(aliceRequests[0].options.headers['X-Line-Retry-Key'], aliceRequests[1].options.headers['X-Line-Retry-Key']);
  for (const r of h.requests) {
    assert.equal(r.options.headers.Authorization, r.owner.startsWith('alice') ? 'Bearer alice-secret' : 'Bearer bob-secret');
    assert.equal(JSON.parse(r.options.payload).to, 'U' + (r.owner.startsWith('alice') ? 'a' : 'b').repeat(32));
  }
  h.as('bob@techbiz.com', ''); c.pollCalendar(bobEvent);
  assert.equal(h.data().ACTIVE_CONFIG, bobBefore);
  assert.equal(c.readLedger_().length, 1);
  assert.equal(h.locks.size, 0);
});

test('user locks serialize callbacks and mutations but do not block another employee', () => {
  const h = sharedApp(), { c } = h;
  h.save('alice-secret', 'a'); c.startMonitoring_();
  const aliceEvent = h.trigger('pollCalendar');
  h.locks.add('alice@techbiz.com');
  const before = JSON.stringify(h.data());
  const calls = h.calendarCalls.length;
  for (const fn of [() => c.pollCalendar(aliceEvent), () => c.initializeSettings(), () => h.save('replacement', 'a'), () => c.startMonitoring_(), () => c.stopMonitoring_()]) assert.throws(fn, /別の処理/);
  assert.equal(JSON.stringify(h.data()), before);
  assert.equal(h.calendarCalls.length, calls);
  h.as('bob@techbiz.com'); h.save('bob-secret', 'b'); c.startMonitoring_();
  assert.equal(h.locks.has('alice@techbiz.com'), true);
  assert.equal(h.locks.has('bob@techbiz.com'), false);
  h.locks.delete('alice@techbiz.com');
  h.as('alice@techbiz.com', ''); c.pollCalendar(aliceEvent);
  assert.equal(h.locks.size, 0);
});

test('calendar workers durably retry only their creator queue through outage and token recovery', () => {
  const h = sharedApp(), { c } = h;
  for (const [email, letter] of [['alice@techbiz.com', 'a'], ['bob@techbiz.com', 'b']]) {
    h.as(email); h.save(email + '-secret', letter); c.startMonitoring_();
    const config = JSON.parse(h.data().ACTIVE_CONFIG);
    config.startedAt = '2026-10-01T00:00:00Z';
    h.data().ACTIVE_CONFIG = JSON.stringify(config);
  }
  h.as('alice@techbiz.com', '');
  const aliceEvent = h.trigger('onCalendarChanged');
  h.state.items = [{ id: 'alice-event', summary: '【面談】Alice', created: '2026-10-02T00:00:00Z' }];
  h.state.httpCode = 503;
  c.onCalendarChanged(aliceEvent);
  const durable = JSON.parse(JSON.stringify(c.readLedger_()));
  assert.equal(durable[0][1], 'PENDING');
  const aliceToken = JSON.parse(h.data().ACTIVE_CONFIG).syncToken;
  h.as('bob@techbiz.com', 'alice@techbiz.com');
  h.state.items = [{ id: 'bob-event', summary: '【面談】Bob', created: '2026-10-02T00:00:00Z' }];
  h.state.httpCode = 200;
  c.pollCalendar(h.trigger('pollCalendar'));
  assert.equal(c.readLedger_()[0][1], 'SENT');
  assert.match(c.readLedger_()[0][0], /bob-event$/);
  const bobState = JSON.stringify(h.data());
  h.as('alice@techbiz.com', 'bob@techbiz.com');
  h.state.calendarError = Error('calendar offline');
  assert.throws(() => c.onCalendarChanged(aliceEvent), /カレンダー/);
  assert.equal(c.readLedger_()[0][1], 'SENT');
  assert.equal(JSON.parse(h.data().ACTIVE_CONFIG).syncToken, aliceToken);
  assert.equal(JSON.stringify(h.stores.get('bob@techbiz.com')), bobState);
  const retries = h.requests.filter(r => r.owner === 'alice@techbiz.com');
  assert.equal(retries.length, 2);
  assert.equal(retries[0].options.payload, retries[1].options.payload);
  assert.equal(retries[0].options.headers['X-Line-Retry-Key'], durable[0][3]);
  assert.equal(retries[1].options.headers['X-Line-Retry-Key'], durable[0][3]);
  assert.equal(retries[1].options.headers.Authorization, 'Bearer alice@techbiz.com-secret');
  h.state.calendarError = null;
  const list = c.Calendar.Events.list;
  c.Calendar.Events.list = (id, query) => { if (query.syncToken) throw { code: 410 }; return list(id, query); };
  h.state.items = [{ id: 'alice-event', summary: '【面談】Alice', created: '2026-10-02T00:00:00Z' }];
  c.onCalendarChanged(aliceEvent);
  assert.equal(c.readLedger_().length, 1);
  assert.equal(JSON.parse(h.data().ACTIVE_CONFIG).startedAt, '2026-10-01T00:00:00Z');
  assert.equal(h.requests.length, 3);
});

test('techbiz.com authorization denies outsiders and mismatched humans before user state or resources', () => {
  const h = sharedApp(), { c } = h;
  c.PropertiesService.getUserProperties = () => assert.fail('denied user store accessed');
  c.LockService.getUserLock = () => assert.fail('denied user lock accessed');
  for (const email of ['', 'alice@evil.techbiz.com', 'alice@techbiz.com.evil', 'alice@example.com', 'bad@@techbiz.com']) {
    h.as(email);
    for (const work of [() => c.getLineSettings(), () => c.initializeSettings(), () => h.save('secret', 'a'), () => c.pollCalendar({ triggerUid: 'fake' }), () => c.readSettings_()]) assert.throws(work, /組織|アカウント/);
  }
  for (const active of ['', 'bob@techbiz.com']) {
    h.as('alice@techbiz.com', active);
    for (const work of [() => c.getLineSettings(), () => c.initializeSettings(), () => h.save('secret', 'a')]) assert.throws(work, /本人/);
  }
  assert.equal(h.books.size, 0);
  assert.equal(h.triggers.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.stores.size, 0);
});
