import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = '/Users/mahiro/.hermes/profiles/dev/cache/scratch';
const allowed = ['README.md', 'mise.toml', 'appsscript.json', 'Core.js', 'Main.js', 'Web.js', 'Dashboard.html'];

function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'immedio-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of allowed) writeFileSync(join(root, name), `fixture ${name}\n`);
  return root;
}

function entries(archive) {
  return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').sort();
}

test('packages only allowlisted immediate files at the archive root', async (t) => {
  const root = fixture(t);
  for (const name of ['.clasp.json', '.clasprc.json', 'package.json', 'secret.txt']) {
    writeFileSync(join(root, name), 'must not ship');
  }
  for (const name of ['.git', 'tests', 'scripts', 'dist']) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'secret.txt'), 'must not ship');
  }
  const { packageProject } = await import('../scripts/package.mjs');
  const archive = await packageProject({ root, outDir: join(root, 'dist') });
  assert.equal(archive, join(root, 'dist', 'immedio-line.zip'));
  assert.deepEqual(entries(archive), [...allowed].sort());
  for (const name of allowed) {
    assert.equal(execFileSync('unzip', ['-p', archive, name], { encoding: 'utf8' }), `fixture ${name}\n`);
  }
  execFileSync('unzip', ['-t', archive]);
});

test('repeated builds replace stale entries without deleting unrelated files', async (t) => {
  const root = fixture(t);
  const outDir = join(root, 'dist');
  mkdirSync(outDir);
  writeFileSync(join(root, 'stale-secret.txt'), 'secret');
  const archive = join(outDir, 'immedio-line.zip');
  execFileSync('zip', ['-q', archive, 'stale-secret.txt'], { cwd: root });
  writeFileSync(join(outDir, 'keep.txt'), 'keep');
  writeFileSync(join(root, 'immedio-line.zip'), 'outside archive');
  const { packageProject } = await import('../scripts/package.mjs');
  for (let run = 0; run < 2; run++) {
    writeFileSync(join(root, 'Main.js'), `revision ${run}`);
    assert.equal(await packageProject({ root, outDir }), archive);
    assert.deepEqual(entries(archive), [...allowed].sort());
    assert.equal(execFileSync('unzip', ['-p', archive, 'Main.js'], { encoding: 'utf8' }), `revision ${run}`);
    assert.deepEqual(readdirSync(outDir).sort(), ['immedio-line.zip', 'keep.txt']);
    assert.equal(readFileSync(join(outDir, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(root, 'immedio-line.zip'), 'utf8'), 'outside archive');
  }
});

test('CLI packages cwd into its dist directory', (t) => {
  const root = fixture(t);
  const script = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  const archive = join(root, 'dist', 'immedio-line.zip');
  assert.equal(output.trim(), archive);
  assert.deepEqual(entries(archive), [...allowed].sort());
});

for (const missing of allowed) {
  test(`missing ${missing} fails before creating or changing outDir`, async (t) => {
    const root = fixture(t);
    rmSync(join(root, missing));
    const { packageProject } = await import('../scripts/package.mjs');
    const outDir = join(root, 'dist');
    await assert.rejects(async () => packageProject({ root, outDir }), { message: new RegExp(missing.replaceAll('.', '\\.')) });
    assert.equal(existsSync(outDir), false);
    mkdirSync(outDir);
    writeFileSync(join(outDir, 'immedio-line.zip'), 'existing archive');
    writeFileSync(join(outDir, 'keep.txt'), 'keep');
    await assert.rejects(async () => packageProject({ root, outDir }));
    assert.deepEqual(readdirSync(outDir).sort(), ['immedio-line.zip', 'keep.txt']);
    assert.equal(readFileSync(join(outDir, 'immedio-line.zip'), 'utf8'), 'existing archive');
    assert.equal(readFileSync(join(outDir, 'keep.txt'), 'utf8'), 'keep');
  });
}
