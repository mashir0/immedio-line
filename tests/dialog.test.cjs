const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('LINE settings form loads current destination and submits edits without exposing a saved token', () => {
  const file = path.join(__dirname, '..', 'LineSettings.html');
  assert.ok(fs.existsSync(file), 'LINE setup dialog must exist');
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /type="password"/);
  const elements = Object.fromEntries(['line-form', 'type', 'recipient', 'token', 'status', 'save'].map(id => [id, { value: '', textContent: '', disabled: false, addEventListener(name, callback) { this[name] = callback; } }]));
  let success;
  let saved;
  const run = {
    withSuccessHandler(fn) { success = fn; return run; },
    withFailureHandler() { return run; },
    getLineSettings() { success({ type: 'group', recipient: 'C' + 'b'.repeat(32), hasToken: true }); },
    saveLineSettings(input) { saved = input; success({ saved: true }); },
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document: { getElementById: id => elements[id] }, google: { script: { run } } });
  assert.equal(elements.recipient.value, 'C' + 'b'.repeat(32));
  assert.equal(elements.token.value, '');
  elements.recipient.value = 'U' + 'a'.repeat(32);
  elements.type.value = 'user';
  elements.token.value = 'secret-new';
  elements['line-form'].submit({ preventDefault() {} });
  assert.equal(saved.recipient, elements.recipient.value);
  assert.equal(saved.token, 'secret-new');
  assert.equal(elements.token.value, '');
  assert.match(elements.status.textContent, /保存/);
});
