const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app(initialized = true) {
  const users = new Map();
  const calls = [];
  let current = 'alice@techbiz.com';
  let active = current;
  let locked = false;
  const fresh = email => initialized ? { USER_EMAIL: email, INSTANCE_SCRIPT_ID: 'shared1', SCHEMA_VERSION: '3', SPREADSHEET_ID: email + '-sheet', LINE_TOKEN: email + '-SECRET', CONFIG_SETTINGS: JSON.stringify({ calendarId: 'primary', prefix: email }), ACTIVE_CONFIG: JSON.stringify({ enabled: true, calendarId: email, requestedCalendarId: 'primary', prefix: email, syncToken: 'SECRET-SYNC' }) } : {};
  function data() { if (!users.has(current)) users.set(current, fresh(current)); return users.get(current); }
  const output = { setTitle() { return output; }, addMetaTag() { return output; } };
  const c = vm.createContext({
    assertUserContext_: human => { if (!current.endsWith('@techbiz.com') || !current || (human && active !== current)) throw new Error('社内の本人アカウントでアクセスしてください。'); return current; },
    props_: () => ({ getProperty: key => data()[key] || null, setProperty: (key, value) => { data()[key] = value; } }),
    withLock_: fn => { assert.equal(locked, false, 'no nested user locks'); locked = true; try { return fn(); } finally { locked = false; } },
    initializeUser_: () => { assert.equal(locked, true); calls.push('init:' + current); Object.assign(data(), { USER_EMAIL: current, SCHEMA_VERSION: '3', INSTANCE_SCRIPT_ID: 'shared1', SPREADSHEET_ID: current + '-sheet' }); },
    ScriptApp: { getScriptId: () => 'shared1', getProjectTriggers: () => [{ getHandlerFunction: () => 'onCalendarChanged', getTriggerSourceId: () => current }, { getHandlerFunction: () => 'pollCalendar' }] },
    readSettings_: () => JSON.parse(data().CONFIG_SETTINGS || '{"calendarId":"primary","prefix":"【面談】"}'),
    readStatus_: () => ({ state: '停止中', detail: 'ok', lastChecked: '' }),
    getLineSettings: () => ({ type: 'user', recipient: data().LINE_RECIPIENT || '', hasToken: !!data().LINE_TOKEN }),
    readLedger_: () => { calls.push('ledger:' + current); return [['e1', 'PENDING'], ['e2', 'REVIEW'], ['e3', 'BLOCKED']]; },
    startMonitoring_: () => { calls.push('start:' + current); return { message: 'started' }; },
    stopMonitoring_: () => { calls.push('stop:' + current); return { message: 'stopped' }; },
    testNotification_: () => { calls.push('test:' + current); return 'test accepted'; },
    HtmlService: { createHtmlOutputFromFile: name => { calls.push(name); return output; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'Web.js'), 'utf8'), c);
  return { c, calls, data, users, setUser(email) { current = email; active = email; }, setActive(email) { active = email; } };
}

test('page load returns only the authenticated employee token without initialization side effects', () => {
  const a = app();
  assert.equal(a.c.getDashboard({ email: 'bob@techbiz.com' }).line.token, 'alice@techbiz.com-SECRET');
  a.setUser('bob@techbiz.com');
  assert.equal(a.c.getDashboard().line.token, 'bob@techbiz.com-SECRET');
  a.setActive('alice@techbiz.com');
  assert.throws(() => a.c.getDashboard(), /アカウント/);
  a.setUser('outsider@example.com');
  assert.throws(() => a.c.getDashboard(), /アカウント/);
  const fresh = app(false);
  assert.equal(fresh.c.getDashboard().line.token, '');
  assert.equal(fresh.calls.length, 0);
});

test('first visit loads a real dashboard without creating history or registering triggers', () => {
  const { c, calls } = app(false);
  c.doGet();
  const d = c.getDashboard();
  assert.equal(d.initialized, false);
  assert.equal(d.account.email, 'alice@techbiz.com');
  assert.equal(d.settings.calendarId, 'primary');
  assert.equal(d.line.hasToken, false);
  assert.equal(d.counts.pending, 0);
  assert.deepEqual(calls, ['Dashboard']);
});

test('current user dashboard whitelists nonsecret data and never selects another employee', () => {
  const a = app();
  const alice = a.c.getDashboard();
  a.setUser('bob@techbiz.com');
  const bob = a.c.getDashboard();
  assert.equal(alice.initialized, true);
  assert.equal(alice.account.email, 'alice@techbiz.com');
  assert.equal(bob.account.email, 'bob@techbiz.com');
  assert.equal(bob.settings.prefix, 'bob@techbiz.com');
  assert.equal(bob.monitoring.calendarTrigger, true);
  assert.equal(bob.monitoring.recoveryTrigger, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bob.counts)), { pending: 1, review: 1, blocked: 1 });
  assert.equal(alice.line.token, 'alice@techbiz.com-SECRET');
  assert.equal(bob.line.token, 'bob@techbiz.com-SECRET');
  assert.doesNotMatch(JSON.stringify([alice, bob]), /SECRET-SYNC|syncToken|SPREADSHEET_ID/);
});

test('all shared Web endpoints reject outsiders, blank identities and deployer-execution mismatches before side effects', () => {
  const a = app(false);
  for (const email of ['outsider@example.com', 'alice@tecchbiz.com', '']) {
    a.setUser(email);
    for (const call of [() => a.c.doGet(), () => a.c.getDashboard(), () => a.c.saveDashboardSettings({ calendarId: 'primary', prefix: 'x' }), () => a.c.startFromWeb(), () => a.c.stopFromWeb(), () => a.c.testFromWeb({ confirmed: true })]) assert.throws(call, /アカウント/);
  }
  a.setUser('alice@techbiz.com'); a.setActive('bob@techbiz.com');
  assert.throws(() => a.c.getDashboard(), /アカウント/);
  assert.equal(a.calls.length, 0);
  assert.equal(a.users.size, 0);
});

test('explicit validated settings save initializes only current user and leaves active monitoring untouched', () => {
  const a = app(false);
  assert.throws(() => a.c.saveDashboardSettings({ calendarId: 'primary', prefix: '' }), /接頭辞/);
  assert.equal(a.calls.length, 0);
  const d = a.c.saveDashboardSettings({ calendarId: 'team@techbiz.com', prefix: '【新規】' });
  assert.equal(d.initialized, true);
  assert.equal(a.data().ACTIVE_CONFIG, undefined);
  assert.equal(a.calls.filter(x => x.startsWith('init:')).length, 1);
  a.setUser('bob@techbiz.com');
  assert.equal(a.c.getDashboard().initialized, false);
  assert.equal(a.data().CONFIG_SETTINGS, undefined);
});

test('mismatched stored identity or script is never accepted as the current user binding', () => {
  const a = app();
  a.data().USER_EMAIL = 'bob@techbiz.com';
  assert.throws(() => a.c.getDashboard(), /初期設定|本人|一致/);
  a.data().USER_EMAIL = 'alice@techbiz.com'; a.data().INSTANCE_SCRIPT_ID = 'other-script';
  assert.throws(() => a.c.getDashboard(), /初期設定|一致/);
});

test('actions use user helpers without spreadsheet UI and test requires an explicit true confirmation', () => {
  const { c, calls } = app();
  assert.throws(() => c.testFromWeb(), /確認/);
  assert.throws(() => c.testFromWeb({ confirmed: 'true' }), /確認/);
  assert.equal(c.testFromWeb({ confirmed: true }).message, 'test accepted');
  assert.equal(c.startFromWeb().message, 'started');
  assert.equal(c.stopFromWeb().message, 'stopped');
  assert.equal(calls.filter(x => x.startsWith('test:')).length, 1);
  assert.equal(calls.filter(x => x.startsWith('init:')).length, 0);
});
