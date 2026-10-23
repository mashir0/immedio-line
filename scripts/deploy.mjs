import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const projectRoot = resolve(import.meta.dirname, '..');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

export function deployProject({ root = projectRoot, env = process.env, description = 'Webアプリ更新', dryRun = false, run = execFileSync, log = console.log } = {}) {
  let fileEnv = {};
  try { fileEnv = parseEnv(readFileSync(join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deploymentId = env.CLASP_DEPLOYMENT_ID ?? fileEnv.CLASP_DEPLOYMENT_ID;
  if (!validId(deploymentId)) throw Error('.env に有効な CLASP_DEPLOYMENT_ID を設定してください（既存のデプロイID。空白やURLは不可）。');
  const projectFile = join(root, '.clasp.json');
  let config;
  try { config = JSON.parse(readFileSync(projectFile, 'utf8')); }
  catch { throw Error('.clasp.json を読み込めません。接続先GASを設定してください。'); }
  if (!validId(config.scriptId)) throw Error('.clasp.json の scriptId が無効です。');
  if (typeof description !== 'string' || !description.trim() || description.includes('\0')) throw Error('更新の説明を指定してください。');
  const list = ['--project', projectFile, '--json', 'list-deployments', config.scriptId];
  const push = ['--project', projectFile, '--ignore', join(root, '.claspignore'), 'push'];
  const update = ['--project', projectFile, 'update-deployment', deploymentId, '--description', description, '--json'];
  const commands = [list, push, update, list];
  if (dryRun) {
    log('DRY RUN: clasp・ネットワークへの操作は行いません。');
    for (const args of commands) log(['clasp', ...args].map(arg => JSON.stringify(arg)).join(' '));
    return { deploymentId, dryRun: true, verified: false };
  }
  const json = args => JSON.parse(run('clasp', args, { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }));
  const before = json(list);
  if (!Array.isArray(before) || !before.some(item => item.deploymentId === deploymentId && Number.isInteger(item.versionNumber) && item.versionNumber > 0)) {
    throw Error('接続先GASに指定のバージョン付きデプロイが見つかりません。pushは実行していません。');
  }
  log('既存デプロイを確認しました。ソースをpushします。');
  run('clasp', push, { cwd: root, stdio: 'inherit' });
  log('push完了。既存デプロイを新バージョンへ更新します。');
  let updated;
  try {
    updated = json(update);
    if (updated.deploymentId !== deploymentId || !Number.isInteger(updated.versionNumber) || updated.versionNumber < 1) throw Error('更新結果のIDまたはバージョンが一致しません。');
  } catch (error) {
    throw Error('デプロイ更新に失敗しました。ソースのpushは完了していますが、Web版の反映は未確認です。', { cause: error });
  }
  let after;
  try { after = json(list); }
  catch (error) { throw Error('更新後の再取得に失敗しました。デプロイの反映確認が必要です。', { cause: error }); }
  const verified = Array.isArray(after) && after.find(item => item.deploymentId === deploymentId);
  if (!verified || verified.versionNumber !== updated.versionNumber || verified.description !== description) {
    throw Error('デプロイの更新後確認が一致しません。GASの「デプロイを管理」で確認してください。');
  }
  log(`確認完了: 既存デプロイをバージョン ${verified.versionNumber} に更新しました（URL維持）。`);
  return { deploymentId, versionNumber: verified.versionNumber, verified: true };
}

export function parseDeployArgs(args) {
  let dryRun = false, description;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (['-m', '--description'].includes(args[i]) && args[i + 1] !== undefined) description = args[++i];
    else throw Error('使い方: npm run deploy -- [--dry-run] [-m "変更内容"]');
  }
  return { dryRun, ...(description === undefined ? {} : { description }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { deployProject(parseDeployArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
