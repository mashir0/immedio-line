'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '..', 'Dashboard.html');

function dashboard({ gas = true } = {}) {
  assert.ok(fs.existsSync(filename), 'Dashboard.html must exist');
  const html = fs.readFileSync(filename, 'utf8');
  const elements = new Map();
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const attrs = tag[0];
    elements.set(tag[1], {
      value: attrs.match(/\bvalue="([^"]*)"/)?.[1] || '',
      type: attrs.match(/\btype="([^"]*)"/)?.[1] || '', readOnly: false, placeholder: '',
      textContent: '', disabled: /\bdisabled\b/.test(attrs), hidden: /\bhidden\b/.test(attrs),
      dataset: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this[name] = value; },
    });
  }
  const calls = [], confirmations = [];
  let allowConfirm = true;
  const handlers = {};
  const bridge = new Proxy({}, { get(_, method) {
    if (method === 'withSuccessHandler') return fn => { handlers.success = fn; return bridge; };
    if (method === 'withFailureHandler') return fn => { handlers.failure = fn; return bridge; };
    return (...args) => calls.push({ method, args, ...handlers });
  } });
  const documentEvents = {}, windowEvents = {};
  const document = {
    hidden: false,
    addEventListener(name, fn) { documentEvents[name] = fn; },
    getElementById(id) { assert.ok(elements.has(id), `Missing element ${id}`); return elements.get(id); },
    querySelectorAll(selector) {
      if (selector === 'button') return [...elements].filter(([id]) => ['save-settings','save-line','start','stop','test','refresh'].includes(id)).map(([, el]) => el);
      return [];
    },
  };
  const context = { document, window: { addEventListener(name, fn) { windowEvents[name] = fn; }, confirm(message) { confirmations.push(message); return allowConfirm; } }, console };
  if (gas) context.google = { script: { run: bridge } };
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length, 'Dashboard has executable inline JavaScript');
  vm.runInNewContext(scripts.map(match => match[1]).join('\n'), context);
  return { html, calls, confirmations, el: id => document.getElementById(id),
    confirm(value) { allowConfirm = value; },
    leave() { windowEvents.blur?.(); },
    hidePage() { document.hidden = true; documentEvents.visibilitychange?.(); },
    fire(id, event = 'click') { const el = document.getElementById(id); if (!el.disabled) el.listeners[event]?.({ preventDefault() {} }); },
    ok(value, index = calls.length - 1) { calls[index].success(value); },
    fail(message, index = calls.length - 1) { calls[index].failure(new Error(message)); },
  };
}
function data(overrides = {}) {
  return { settings: { calendarId: 'primary', prefix: 'immedio' },
    status: { state: 'ready', detail: '設定を確認してください', lastChecked: '2026-10-23T03:00:00Z' },
    monitoring: { enabled: false, calendarTrigger: false, recoveryTrigger: false, calendarId: '', prefix: '' },
    line: { type: 'user', recipient: 'U' + 'a'.repeat(32), hasToken: true },
    counts: { pending: 2, review: 1, blocked: 0 }, ...overrides };
}

test('password field preloads saved token masked, toggles locally and stays editable without clearing', () => {
  const page = dashboard();
  page.ok(data({ line: { type: 'user', recipient: 'U' + 'a'.repeat(32), hasToken: true, token: 'stored-test-value' } }));
  assert.equal(page.el('line-token').value, 'stored-test-value');
  assert.equal(page.el('line-token').type, 'password');
  assert.equal(page.el('line-token').readOnly, false);
  assert.doesNotMatch(page.el('line-state').textContent, /未保存/);
  page.fire('toggle-token');
  assert.equal(page.el('line-token').type, 'text');
  page.leave(); page.hidePage();
  assert.equal(page.el('line-token').value, 'stored-test-value');
  assert.equal(page.el('line-token').type, 'text');
  page.fire('toggle-token');
  assert.equal(page.el('line-token').value, 'stored-test-value');
  assert.equal(page.el('line-token').type, 'password');
  assert.equal(page.calls.length, 1);
  page.el('line-token').value = 'edited'; page.fire('line-token', 'input');
  assert.match(page.el('line-state').textContent, /未保存/);
  page.el('line-token').value = 'stored-test-value'; page.fire('line-token', 'input');
  assert.doesNotMatch(page.el('line-state').textContent, /未保存/);
});

test('token save keeps the value, marks saved, and blank save deletes the existing token', () => {
  const line = { type: 'user', recipient: 'U' + 'a'.repeat(32), hasToken: true, token: 'original' };
  const page = dashboard(); page.ok(data({ line }));
  page.el('line-token').value = 'updated'; page.fire('line-token', 'input');
  page.fire('line-form', 'submit'); page.ok({ saved: true });
  page.ok(data({ line: { ...line, token: 'updated' } }));
  assert.equal(page.el('line-token').value, 'updated');
  assert.doesNotMatch(page.el('line-state').textContent, /未保存/);
  page.el('line-token').value = ''; page.fire('line-token', 'input');
  page.fire('line-form', 'submit');
  assert.equal(page.calls.at(-1).args[0].token, '');
  page.ok({ saved: true }); page.ok(data({ line: { ...line, token: '', hasToken: false } }));
  assert.equal(page.el('line-token').value, '');
  assert.doesNotMatch(page.el('line-state').textContent, /未保存/);
});

test('save buttons require changes, disable during RPC and disable again after reverting or saving', () => {
  const page = dashboard(); page.ok(data({ initialized: true }));
  assert.equal(page.el('save-settings').disabled, true);
  assert.equal(page.el('save-line').disabled, true);
  page.fire('settings-form', 'submit'); page.fire('line-form', 'submit');
  assert.equal(page.calls.length, 1, 'unchanged forms do not issue save RPCs');
  page.el('prefix').value = 'changed'; page.fire('prefix', 'input');
  assert.equal(page.el('save-settings').disabled, false);
  assert.equal(page.el('save-line').disabled, true);
  page.el('prefix').value = 'immedio'; page.fire('prefix', 'input');
  assert.equal(page.el('save-settings').disabled, true);
  page.el('line-token').value = 'new'; page.fire('line-token', 'input');
  assert.equal(page.el('save-line').disabled, false);
  page.fire('refresh');
  assert.equal(page.el('save-line').disabled, true);
  page.ok(data({ initialized: true }));
  assert.equal(page.el('save-line').disabled, false);
  page.fire('line-form', 'submit'); page.ok({ saved: true });
  page.ok(data({ initialized: true, line: { type: 'user', recipient: 'U' + 'a'.repeat(32), token: 'new', hasToken: true } }));
  assert.equal(page.el('save-line').disabled, true);
});

test('recipient label and acquisition guide follow selected or loaded destination type without RPC', () => {
  const page = dashboard(); page.ok(data());
  assert.equal(page.el('recipient-label').textContent, 'Messaging API User ID');
  assert.equal(page.el('recipient-group-guide').hidden, true);
  page.el('line-token').value = 'retained-test-token';
  page.el('line-type').value = 'group'; page.fire('line-type', 'change');
  assert.equal(page.el('line-token').value, 'retained-test-token');
  assert.equal(page.el('recipient-label').textContent, 'Messaging API Group ID');
  assert.match(page.el('recipient-summary').textContent, /グループ/);
  assert.equal(page.el('recipient-group-guide').hidden, false);
  assert.equal(page.el('recipient-user-guide').hidden, true);
  assert.equal(page.el('line-recipient').value, '');
  assert.equal(page.calls.length, 1);
  page.fire('refresh'); page.ok(data());
  assert.equal(page.el('line-recipient').value, '', 'refresh must not restore previous-type ID');
  page.el('line-recipient').value = 'C' + 'b'.repeat(32);
  page.fire('line-type', 'change');
  assert.equal(page.el('line-recipient').value, 'C' + 'b'.repeat(32), 'duplicate event does not erase new input');
  page.el('line-type').value = 'user'; page.fire('line-type', 'change');
  assert.equal(page.el('line-recipient').value, 'U' + 'a'.repeat(32));
  page.el('line-type').value = 'group'; page.fire('line-type', 'change');
  assert.equal(page.el('line-recipient').value, 'C' + 'b'.repeat(32));
  page.el('line-type').value = 'user'; page.fire('line-type', 'change');
  assert.equal(page.el('recipient-label').textContent, 'Messaging API User ID');
  assert.equal(page.el('recipient-user-guide').hidden, false);
  const loaded = dashboard();
  loaded.ok(data({ line: { type: 'group', recipient: 'C' + 'b'.repeat(32), token: '', hasToken: false } }));
  assert.equal(loaded.el('recipient-label').textContent, 'Messaging API Group ID');
  assert.equal(loaded.el('line-recipient').value, 'C' + 'b'.repeat(32), 'loading a saved group does not clear its ID');
  for (const word of ['グループトーク・複数人トークへの参加を許可する', 'Webhook', 'source.groupId', 'チャネルアクセストークン', 'テスト送信']) assert.ok(loaded.html.includes(word), word);
});

test('invalid IDs, token control characters and oversized settings cannot be saved', () => {
 const page = dashboard(); page.ok(data());
 for (const value of ['bad-id', 'C' + 'b'.repeat(32), 'U' + 'a'.repeat(31), "U' OR 1=1 --", '<script>alert(1)</script>']) {
  page.el('line-recipient').value=value; page.fire('line-recipient','input');
  assert.equal(page.el('save-line').disabled,true);
  assert.ok(page.el('line-error').textContent);
  page.fire('line-form','submit');
  assert.equal(page.calls.length,1);
 }
 page.el('line-recipient').value='U'+'b'.repeat(32);
 page.el('line-token').value='bad\nheader';page.fire('line-token','input');
 assert.equal(page.el('save-line').disabled,true);
 page.el('line-token').value='';page.fire('line-token','input');
 assert.equal(page.el('save-line').disabled,false, 'blank token is an explicit deletion');
 page.el('prefix').value='x'.repeat(201);page.fire('prefix','input');
 assert.equal(page.el('save-settings').disabled,true);
 assert.ok(page.el('settings-error').textContent);
});

test('calendar ID has expandable acquisition help including primary and shared calendars', () => {
  const html = fs.readFileSync(filename, 'utf8');
  const help = html.match(/<details id="calendar-guide"[\s\S]*?<\/details>/)?.[0];
  assert.ok(help);
  for (const word of ['カレンダーIDの取得方法', 'primary', 'Googleカレンダー', '設定と共有', 'カレンダーの統合', 'カレンダーID', '閲覧権限']) assert.ok(help.includes(word), word);
  assert.match(html, /aria-describedby="calendar-help calendar-guide"/);
});

test('LINE fields use Messaging API User ID and accessible expandable acquisition help', () => {
  const html = fs.readFileSync(filename, 'utf8');
  assert.match(html, /<label id="recipient-label" for="line-recipient">Messaging API User ID<\/label>/);
  assert.match(html, /<input id="line-recipient"[^>]*aria-describedby="recipient-help"/);
  const idHelp = html.match(/<details id="recipient-help"[\s\S]*?<\/details>/)?.[0];
  assert.ok(idHelp, 'recipient help must be a native keyboard/touch accessible disclosure');
  assert.match(idHelp, /<summary[^>]*>.*取得方法/);
  for (const text of ['LINE Developers', 'チャネル基本設定', 'あなたのユーザーID', 'プロバイダーID', 'チャネルID', 'グループID', 'Webhook', 'Messaging APIを利用する']) assert.ok(idHelp.includes(text), text);
  const tokenHelp = html.match(/<details id="token-guide"[\s\S]*?<\/details>/)?.[0];
  assert.ok(tokenHelp);
  assert.match(tokenHelp, /<summary[^>]*>.*取得方法/);
  for (const text of ['Messaging API設定', 'チャネルアクセストークン（長期）', '発行', 'チャネルシークレット']) assert.ok(tokenHelp.includes(text), text);
  assert.match(html, /<input id="line-token"[^>]*type="password"[^>]*aria-describedby="token-help token-state token-guide"/);
  assert.doesNotMatch(idHelp + tokenHelp, /<button|onmouseover|onmouseenter/);
});

test('shared internal app explains the first-use sequence and calendar plus five-minute recovery triggers', () => {
  const page = dashboard();
  assert.match(page.html, /社内共通アプリ/);
  assert.match(page.html, /Google権限承認済み → カレンダー設定を保存 → LINE設定を保存 → テスト → 開始/);
  assert.match(page.html, /カレンダー変更トリガー.*5分ごとの復旧トリガー/);
  assert.doesNotMatch(page.html, /自分専用|コピーを作成|個人.*デプロイ|初期セットアップ/);
});

test('first-use banner discloses history creation on explicit save and disappears after either save initializes', () => {
  for (const form of ['settings-form', 'line-form']) {
    const page = dashboard();
    assert.equal(page.el('first-use').hidden, true, 'do not claim first-use before state is loaded');
    page.ok(data({ initialized: false, line: { type: 'user', recipient: '', hasToken: false } }));
    assert.equal(page.el('first-use').hidden, false);
    assert.equal(page.el('first-use').textContent, '初回の設定保存時に、自分のDriveへ履歴用スプレッドシートを作成します。共有や普段のセル操作は不要です。');
    assert.equal(page.el('saved-config').textContent, '未保存（初期値を表示中）');
    assert.match(page.el('config-state').textContent, /カレンダー設定を保存/);
    assert.doesNotMatch(page.el('config-state').textContent, /保存済み/);
    assert.doesNotMatch(page.el('line-state').textContent, /保存済み/);
    assert.deepEqual(page.calls.map(call => call.method), ['getDashboard'], 'load must not initialize or save');
    page.fire('refresh'); page.ok(data({ initialized: false }));
    assert.deepEqual(page.calls.map(call => call.method), ['getDashboard', 'getDashboard']);
    page.fire(form, 'submit');
    assert.equal(page.el('first-use').hidden, false, 'keep disclosure while save is pending');
    page.fail('保存できません');
    assert.equal(page.el('first-use').hidden, false, 'failed saves do not initialize');
    page.fire(form, 'submit');
    if (form === 'line-form') {
      page.ok({ saved: true });
      assert.equal(page.el('first-use').hidden, false, 'wait for initialized readback');
    }
    page.ok(data({ initialized: true }));
    assert.equal(page.el('first-use').hidden, true);
    assert.match(page.el('saved-config').textContent, /ID: primary/);
  }
});

test('signed-in account is read-only server text, never an identity selector or RPC argument', () => {
  const page = dashboard();
  const email = '<img src=x onerror=alert(1)>@example.com';
  page.ok(data({ account: { email }, initialized: true }));
  assert.equal(page.el('account-email').textContent, email);
  assert.match(page.html, /<dd id="account-email">/);
  assert.doesNotMatch(page.html, /<(?:input|select)[^>]*(?:userId|account-email)|contenteditable|innerHTML/);
  assert.equal(page.el('first-use').hidden, true);
  page.fire('refresh');
  assert.equal(JSON.stringify(page.calls[1].args), '[]');
  page.ok(data({ account: { email: '' } }));
  assert.equal(page.el('account-email').textContent, '取得できませんでした');
  page.fire('refresh'); page.ok(data());
  assert.equal(page.el('account-email').textContent, '取得できませんでした');
  assert.equal(page.el('first-use').hidden, true, 'legacy fixtures without initialized remain compatible');
});

test('primary alias is shown as applied when the active calendar has its resolved ID', () => {
  const page = dashboard();
  page.ok(data({ monitoring: { enabled: true, calendarTrigger: true, recoveryTrigger: true, calendarId: 'owner@example.com', requestedCalendarId: 'primary', prefix: 'immedio' } }));
  assert.match(page.el('config-state').textContent, /保存済み設定で監視/);
});

test('loads real dashboard data and renders settings, health, counts, and active configuration safely', () => {
  const page = dashboard();
  assert.equal(page.calls[0]?.method, 'getDashboard');
  assert.equal(page.el('refresh').disabled, true);
  const value = data({ status: { state: 'running', detail: '<img src=x onerror=alert(1)>', lastChecked: '2026-10-23T03:00:00Z' } });
  page.ok(value);
  assert.equal(page.el('calendar-id').value, 'primary');
  assert.equal(page.el('prefix').value, 'immedio');
  assert.equal(page.el('line-recipient').value, 'U' + 'a'.repeat(32));
  assert.equal(page.el('line-token').value, '');
  assert.match(page.el('status-text').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(page.el('last-checked').textContent, /2026-10-23/);
  assert.match(page.el('trigger-health').textContent, /カレンダー: なし.*復旧: なし/);
  assert.match(page.el('queue-counts').textContent, /待機: 2.*要確認: 1.*ブロック: 0/);
  assert.match(page.el('active-config').textContent, /停止中/);
  assert.match(page.el('token-state').textContent, /登録済み/);
  assert.equal(page.el('refresh').disabled, false);
  assert.doesNotMatch(page.html, /innerHTML|localStorage|https?:\/\//);
});

test('settings submit preserves literal prefix and refresh preserves dirty fields', () => {
  const page = dashboard(); page.ok(data());
  page.el('calendar-id').value = 'team@example.com';
  page.el('prefix').value = ' [予約] ';
  page.fire('prefix', 'input');
  assert.match(page.el('config-state').textContent, /未保存/);
  page.fire('settings-form', 'submit');
  assert.equal(page.calls[1]?.method, 'saveDashboardSettings');
  assert.equal(JSON.stringify(page.calls[1].args), JSON.stringify([{ calendarId: 'team@example.com', prefix: ' [予約] ' }]));
  assert.equal(page.el('test').disabled, true);
  page.ok(data({ settings: { calendarId: 'team@example.com', prefix: ' [予約] ' } }));
  assert.match(page.el('config-state').textContent, /開始・更新/);
  page.el('prefix').value = 'next'; page.fire('prefix', 'input');
  page.fire('refresh');
  assert.equal(page.calls[2]?.method, 'getDashboard');
  page.ok(data({ settings: { calendarId: 'team@example.com', prefix: ' [予約] ' } }));
  assert.equal(page.el('prefix').value, 'next');
  assert.match(page.el('config-state').textContent, /未保存/);
});

test('LINE save retains saved value and preserves newer edits during save and readback', () => {
  const page = dashboard(); page.ok(data());
  page.el('line-token').value = 'submitted-token';
  page.fire('line-form', 'submit');
  assert.equal(page.calls.at(-1).args[0].token, 'submitted-token');
  page.ok({ saved: true });
  assert.equal(page.el('line-token').value, 'submitted-token');
  page.el('line-token').value = 'newer-edit'; page.fire('line-token', 'input');
  page.ok(data({ line: { type: 'user', recipient: 'U' + 'a'.repeat(32), hasToken: true, token: 'submitted-token' } }));
  assert.equal(page.el('line-token').value, 'newer-edit');
  assert.match(page.el('line-state').textContent, /未保存/);
});

test('operations require confirmation, use exact APIs, and render fresh response without a second send', () => {
  for (const [id, method, prompt] of [['start', 'startFromWeb', /基準.*作り直/], ['stop', 'stopFromWeb', /停止/], ['test', 'testFromWeb', /通知枠|クォータ/]]) {
    const page = dashboard(); page.ok(data());
    page.confirm(false); page.fire(id);
    assert.equal(page.calls.length, 1);
    assert.match(page.confirmations[0], prompt);
    page.confirm(true); page.fire(id); page.fire(id);
    assert.equal(page.calls.length, 2);
    assert.equal(page.calls[1].method, method);
    assert.equal(JSON.stringify(page.calls[1].args), id === 'test' ? '[{"confirmed":true}]' : '[]');
    const fresh = data({ monitoring: { enabled: true, calendarTrigger: true, recoveryTrigger: true, calendarId: 'primary', prefix: 'immedio' } });
    page.ok({ message: '<b>完了</b>', dashboard: fresh });
    assert.equal(page.el('notice').textContent, '<b>完了</b>');
    assert.match(page.el('config-state').textContent, /保存済み設定で監視/);
    assert.match(page.el('trigger-health').textContent, /カレンダー: あり.*復旧: あり/);
    assert.equal(page.el(id).disabled, false);
  }
});

test('LINE edits show unsaved state and survive refresh including typed secrets', () => {
  const page = dashboard(); page.ok(data());
  page.el('line-recipient').value = 'C' + 'c'.repeat(32); page.fire('line-recipient', 'input');
  assert.match(page.el('line-state').textContent, /未保存/);
  page.el('line-token').value = 'new-secret'; page.fire('line-token', 'input');
  page.fire('refresh'); page.ok(data());
  assert.equal(page.el('line-recipient').value, 'C' + 'c'.repeat(32));
  assert.equal(page.el('line-token').value, 'new-secret');
  assert.match(page.el('line-state').textContent, /未保存/);
});

test('RPC errors remain visible and all buttons recover without clearing an unsaved token', () => {
  for (const action of ['refresh', 'settings-form', 'line-form', 'start', 'stop', 'test']) {
    const page = dashboard(); page.ok(data());
    page.el('line-token').value = 'retain-on-error';
    page.el('prefix').value = 'changed-before-error'; page.fire('prefix', 'input');
    page.fire(action, action.endsWith('form') ? 'submit' : 'click');
    page.fail('<script>permission denied</script>');
    assert.equal(page.el('notice').dataset.kind, 'error');
    assert.match(page.el('notice').textContent, /<script>permission denied<\/script>/);
    assert.equal(page.el('line-token').value, 'retain-on-error');
    for (const id of ['refresh', 'save-settings', 'save-line', 'start', 'stop', 'test']) assert.equal(page.el(id).disabled, false);
    assert.equal(page.el('dashboard')['aria-busy'], 'false');
  }
});

test('initial load failure and malformed success permit retry without fictional data', () => {
  const page = dashboard();
  page.fail('権限が必要です');
  assert.match(page.el('notice').textContent, /権限が必要/);
  assert.equal(page.el('refresh').disabled, false);
  page.fire('refresh'); page.ok(null);
  assert.equal(page.el('notice').dataset.kind, 'error');
  assert.equal(page.el('refresh').disabled, false);
  page.fire('refresh'); page.ok(data());
  assert.match(page.el('queue-counts').textContent, /待機: 2/);
});

test('a successful LINE save retains the token if readback fails', () => {
  const page = dashboard(); page.ok(data());
  page.el('line-token').value = 'write-once';
  page.fire('line-form', 'submit'); page.ok({ saved: true });
  page.fail('再取得できません');
  assert.equal(page.el('line-token').value, 'write-once');
  assert.equal(page.el('save-line').disabled, true);
  assert.match(page.el('notice').textContent, /再取得できません/);
});

test('edits made while a save is pending are not overwritten by its response', () => {
  const page = dashboard(); page.ok(data());
  page.el('prefix').value = 'first';
  page.fire('settings-form', 'submit');
  page.el('prefix').value = 'second'; page.fire('prefix', 'input');
  page.ok(data({ settings: { calendarId: 'primary', prefix: 'first' } }));
  assert.equal(page.el('prefix').value, 'second');
  assert.match(page.el('saved-config').textContent, /first/);
  assert.match(page.el('config-state').textContent, /未保存/);
});

test('outside GAS displays a clear error and disables every action', () => {
  const page = dashboard({ gas: false });
  assert.match(page.el('notice').textContent, /GAS上で開いてください/);
  for (const id of ['refresh', 'save-settings', 'save-line', 'start', 'stop', 'test']) assert.equal(page.el(id).disabled, true);
});
