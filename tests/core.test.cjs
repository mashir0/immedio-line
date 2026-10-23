const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function core() {
  const file = path.join(__dirname, '..', 'Core.js');
  assert.ok(fs.existsSync(file), 'Core.js must implement settings validation');
  return vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nNotificationCore;');
}

test('new-event classification excludes old, cancelled, duplicate and recurring instances', () => {
  const c = core();
  const cfg = { prefix: '【面談】', startedAt: '2026-10-01T00:00:00Z' };
  const fresh = { id: 'n1', summary: '【面談】A', created: '2026-10-02T00:00:00Z', status: 'confirmed' };
  assert.equal(c.shouldNotify(fresh, cfg, false), true);
  assert.equal(c.shouldNotify(fresh, cfg, true), false);
  assert.equal(c.shouldNotify({ ...fresh, created: cfg.startedAt }, cfg, false), false);
  assert.equal(c.shouldNotify({ ...fresh, summary: '他の予定' }, cfg, false), false);
  assert.equal(c.shouldNotify({ ...fresh, status: 'cancelled' }, cfg, false), false);
  assert.equal(c.shouldNotify({ ...fresh, recurringEventId: 'master' }, cfg, false), false);
  assert.equal(c.shouldNotify({ ...fresh, created: 'invalid' }, cfg, false), false);
  assert.equal(c.shouldNotify({ ...fresh, id: '' }, cfg, false), false);
});

test('notification includes title, readable date and calendar link but not attendee or location data', () => {
  const c = core();
  const text = c.message({ summary: '【面談】A', start: { date: '2026-10-24' }, end: { date: '2026-10-25' }, attendees: ['SECRET'], location: 'SECRET', htmlLink: 'https://calendar.google.com/calendar/event?eid=x' });
  assert.match(text, /【面談】A/);
  assert.match(text, /10-24\(土\) 終日/);
  assert.doesNotMatch(text, /SECRET/);
  assert.doesNotMatch(c.message({ htmlLink: 'https://evil.test' }), /evil/);
  assert.ok(c.message({ summary: 'x'.repeat(6000) }).length <= 5000);
});

test('Japanese date ranges use actual weekdays, local timezone and explicit dates across midnight or years', () => {
  const c = core();
  const range = (start, end) => c.message({ start: { dateTime: start }, end: { dateTime: end } });
  assert.match(range('2026-10-25T18:30:00+09:00', '2026-10-25T19:00:00+09:00'), /10-25\(日\) 18:30〜19:00/);
  assert.match(range('2026-10-25T18:30:00+09:00', '2026-10-26T09:00:00+09:00'), /10-25\(日\) 18:30〜10-26\(月\) 09:00/);
  assert.match(range('2026-10-24T23:30:00Z', '2026-10-25T00:00:00Z'), /10-25\(日\) 08:30〜09:00/);
  assert.match(range('2026-12-31T23:30:00+09:00', '2027-01-01T01:00:00+09:00'), /2026-12-31\(木\) 23:30〜2027-01-01\(金\) 01:00/);
  assert.doesNotMatch(range('invalid', 'invalid'), /NaN|Invalid Date/);
});

test('all-day date ranges do not show the exclusive end day as an occupied day', () => {
  const c = core();
  assert.match(c.message({ start: { date: '2026-10-24' }, end: { date: '2026-10-27' } }), /10-24\(土\)〜10-26\(月\) 終日/);
  assert.match(c.message({ start: { dateTime: '2026-10-25T18:30:00+09:00' }, endTimeUnspecified: true }), /10-25\(日\) 18:30/);
});

test('configured video URL and description are included, without exposing conference PINs or telephone entries', () => {
  const c = core();
  const text = c.message({ summary: '面談', hangoutLink: 'https://meet.google.com/abc-defg-hij', conferenceData: { entryPoints: [
    { entryPointType: 'phone', uri: 'tel:+81123', pin: 'SECRET_PIN' },
    { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij', password: 'SECRET_PASSWORD' },
  ] }, description: '<p>事前に資料を確認<br>開始5分前に入室</p><p><a href="https://example.com/document?a=1&amp;b=2">資料</a></p>' });
  assert.equal(text.split('https://meet.google.com/abc-defg-hij').length - 1, 1);
  assert.match(text, /ミーティングURL/);
  assert.match(text, /メモ\n事前に資料を確認\n開始5分前に入室/);
  assert.match(text, /資料.*https:\/\/example.com\/document\?a=1&b=2/);
  assert.doesNotMatch(text, /<p>|<br>|<a |SECRET_PIN|SECRET_PASSWORD|tel:/);
  assert.match(c.message({ conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/123' }] } }), /https:\/\/zoom.us\/j\/123/);
  assert.doesNotMatch(c.message({ hangoutLink: 'javascript:alert(1)' }), /javascript:/);
});

test('long notes are explicitly truncated within LINE text limit without splitting an emoji', () => {
  const c = core();
  const text = c.message({ summary: '面談', description: '😀'.repeat(5000) });
  assert.ok(text.length <= 5000);
  assert.match(text, /省略/);
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test('LINE settings validate ID types and allow blank tokens only for settings saves', () => {
  const c = core();
  const user = 'U' + 'a'.repeat(32);
  const group = 'C' + 'b'.repeat(32);
  assert.equal(c.validateLine({ type: 'user', recipient: user, token: 'new' }, '').token, 'new');
  assert.equal(c.validateLine({ type: 'group', recipient: group, token: '' }, { allowEmptyToken: true }).token, '');
  assert.throws(() => c.validateLine({ type: 'user', recipient: group, token: 't' }, ''), /通知先ID/);
  assert.throws(() => c.validateLine({ type: 'group', recipient: user, token: 't' }, ''), /通知先ID/);
  assert.throws(() => c.validateLine({ type: 'user', recipient: user, token: '' }, ''), /トークン/);
  assert.throws(() => c.validateLine({ type: 'user', recipient: user, token: 'new\n' }), /トークン/);
  assert.throws(() => c.validateLine({ type: 'user', recipient: { toString: () => user }, token: 'new' }), /通知先ID/);
  assert.throws(() => c.validateLine({ type: 'user', recipient: user, token: {} }, { allowEmptyToken: true }), /トークン/);
  assert.throws(() => c.validateLine({ type: 'room', recipient: user, token: 't' }, ''), /種類/);
});

test('settings normalize calendar ID but preserve the literal prefix; empty prefix is rejected', () => {
  const c = core();
  assert.equal(c.validateSettings(' primary ', '【面談】').calendarId, 'primary');
  assert.equal(c.validateSettings('primary', ' 面談').prefix, ' 面談');
  assert.throws(() => c.validateSettings('', '【面談】'), /カレンダー/);
  assert.throws(() => c.validateSettings('primary', ''), /接頭辞/);
  assert.throws(() => c.validateSettings('primary', '   '), /接頭辞/);
});
