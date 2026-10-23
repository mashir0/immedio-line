import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const files = ['README.md', 'mise.toml', 'appsscript.json', 'Core.js', 'Main.js', 'Web.js', 'Dashboard.html'];

export function packageProject({ root, outDir }) {
  root = resolve(root);
  outDir = resolve(outDir);
  for (const name of files) {
    if (!statSync(join(root, name)).isFile()) throw new Error(`Required input is not a file: ${name}`);
  }
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(outDir, '.package-'));
  const archive = join(outDir, 'immedio-line.zip');
  try {
    for (const name of files) copyFileSync(join(root, name), join(scratch, name));
    rmSync(archive, { force: true });
    execFileSync('zip', ['-q', '-X', archive, ...files], { cwd: scratch });
    return archive;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(packageProject({ root: process.cwd(), outDir: join(process.cwd(), 'dist') }));
}
