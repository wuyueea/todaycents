import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root, '.superpowers/e2e/tmp');
mkdirSync(temporary, { recursive: true });
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const child = spawn(process.execPath, [
  '--require', path.join(root, 'scripts/dsh-vite-shim.cjs'), cli, ...process.argv.slice(2),
], {
  cwd: root, stdio: 'inherit',
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.playwright-browsers'),
    TODAYCENTS_E2E_RUN_TOKEN: randomUUID(),
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
