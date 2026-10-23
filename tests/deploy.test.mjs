import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = process.env.TMPDIR || process.env.TEMP || process.cwd();
const deploymentId = 'AKfycb_TEST_DEPLOYMENT_123456789';
function project(t, id = deploymentId) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'immedio-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'CLASP_DEPLOYMENT_ID=' + id + '\nOTHER_SECRET=must-not-log\n');
  writeFileSync(join(root, '.clasp.json'), JSON.stringify({ scriptId: 'SCRIPT_TEST_123456789' }));
  writeFileSync(join(root, '.claspignore'), '**/**\n!Main.js\n');
  return root;
}
async function implementation() {
  return import(pathToFileURL(join(import.meta.dirname, '../scripts/deploy.mjs')).href);
}

test('CLI accepts -m and --description with the same literal description', async () => {
  const { parseDeployArgs } = await implementation();
  for (const flag of ['-m', '--description']) {
    assert.deepEqual(parseDeployArgs(['--dry-run', flag, '表示切替の修正']), { dryRun: true, description: '表示切替の修正' });
    assert.throws(() => parseDeployArgs([flag]), /使い方/);
  }
});

test('env-based deployment checks existing target, pushes, updates same ID, then reads back exact version', async t => {
  const root = project(t);
  const { deployProject } = await implementation();
  const calls = [], logs = [];
  const description = 'トークン表示切替';
  let lists = 0;
  const result = deployProject({ root, env: {}, description, log: msg => logs.push(msg), run: (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (args.includes('list-deployments')) return JSON.stringify([{ deploymentId, versionNumber: ++lists === 1 ? 1 : 2, description: lists === 1 ? 'old' : description }]);
    if (args.includes('update-deployment')) return JSON.stringify({ deploymentId, versionNumber: 2, description });
    return '';
  } });
  assert.equal(result.verified, true);
  assert.equal(result.versionNumber, 2);
  assert.deepEqual(calls.map(c => c.args.find(a => ['list-deployments','push','update-deployment'].includes(a))), ['list-deployments','push','update-deployment','list-deployments']);
  assert.ok(calls.every(c => c.cmd === 'clasp' && c.options.cwd === root && c.args.includes(join(root, '.clasp.json'))));
  const update = calls[2].args;
  assert.equal(update[update.indexOf('update-deployment') + 1], deploymentId);
  assert.equal(update[update.indexOf('--description') + 1], description);
  assert.doesNotMatch(logs.join('\n'), /must-not-log/);
});

test('missing or malformed deployment ID stops before every clasp invocation', async t => {
  const { deployProject } = await implementation();
  for (const id of ['', 'bad;command', '" spaced "', '--help']) {
    const root = project(t, id);
    assert.throws(() => deployProject({ root, env: {}, log: () => {}, run: () => assert.fail('no clasp call allowed') }), /CLASP_DEPLOYMENT_ID/);
  }
});

test('wrong deployment target stops before push and push failure stops before deploy', async t => {
  const root = project(t);
  const { deployProject } = await implementation();
  let calls = [];
  assert.throws(() => deployProject({ root, env: {}, log: () => {}, run: (cmd, args) => { calls.push(args); return '[]'; } }), /見つかりません/);
  assert.equal(calls.length, 1);
  calls = [];
  assert.throws(() => deployProject({ root, env: {}, log: () => {}, run: (cmd, args) => {
    calls.push(args);
    if (args.includes('push')) throw new Error('push rejected');
    return JSON.stringify([{ deploymentId, versionNumber: 1 }]);
  } }), /push/);
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(args => args.includes('update-deployment')));
});

test('dry run parses env and prints plan without any clasp or network calls', async t => {
  const root = project(t);
  const { deployProject } = await implementation();
  const logs = [];
  const result = deployProject({ root, env: {}, dryRun: true, log: msg => logs.push(msg), run: () => assert.fail('dry run must not execute') });
  assert.equal(result.verified, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.deploymentId, deploymentId);
  assert.match(logs.join('\n'), /push/);
  assert.match(logs.join('\n'), /update-deployment/);
  assert.doesNotMatch(logs.join('\n'), /must-not-log/);
});

test('verification mismatch or deployment failure is not reported as successful', async t => {
  const root = project(t);
  const { deployProject } = await implementation();
  for (const mismatch of ['readback', 'update']) {
    let lists = 0;
    assert.throws(() => deployProject({ root, env: {}, log: () => {}, run: (cmd, args) => {
      if (args.includes('list-deployments')) return JSON.stringify([{ deploymentId, versionNumber: ++lists === 1 ? 1 : 999 }]);
      if (args.includes('update-deployment')) {
        if (mismatch === 'update') throw Error('deployment rejected');
        return JSON.stringify({ deploymentId, versionNumber: 2, description: 'Webアプリ更新' });
      }
      return '';
    } }), /確認|更新|deployment/);
  }
});
