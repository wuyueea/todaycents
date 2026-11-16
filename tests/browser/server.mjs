import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, '.superpowers/e2e/app');
await mkdir(output, { recursive: true });
await build({
  root, configFile: false, logLevel: 'warn',
  plugins: [{
    name: 'browser-test-driver', enforce: 'pre',
    resolveId(id, importer) {
      if (id === './capacitorDriver' && importer?.replaceAll('\\', '/').endsWith('/src/db/index.ts')) {
        return path.join(root, 'tests/browser/driver.ts');
      }
    },
  }, react()],
  build: { outDir: output, emptyOutDir: true },
});

const databases = new Map();
function database(session) {
  if (!databases.has(session)) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    databases.set(session, db);
  }
  return databases.get(session);
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/__e2e/ready') return json(response, 200, { ready: true });
    if (pathname === '/__e2e/shutdown') {
      if (request.method !== 'POST' || !process.env.TODAYCENTS_E2E_RUN_TOKEN ||
          request.headers['x-test-run'] !== process.env.TODAYCENTS_E2E_RUN_TOKEN) {
        return json(response, 403, { error: 'Invalid test run' });
      }
      json(response, 200, { stopped: true });
      setImmediate(close);
      return;
    }
    if (pathname === '/__e2e/sql') {
      const session = request.headers['x-test-session'];
      if (request.method !== 'POST' || typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session)) {
        return json(response, 400, { error: 'Invalid browser test request' });
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('Test request too large');
      }
      const { op, sql, params = [] } = JSON.parse(body);
      if (!['exec', 'run', 'all', 'get'].includes(op) || typeof sql !== 'string' || !Array.isArray(params)) {
        return json(response, 400, { error: 'Invalid SQL operation' });
      }
      const db = database(session);
      let value = null;
      if (op === 'exec') db.exec(sql);
      else if (op === 'run') db.prepare(sql).run(...params);
      else value = db.prepare(sql)[op](...params) ?? null;
      return json(response, 200, { value });
    }
    const file = path.resolve(output, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(output + path.sep) || !(await stat(file)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(response);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(4179, '127.0.0.1', () => console.log('TodayCents browser-test server ready'));
function close() {
  for (const db of databases.values()) db.close();
  server.closeIdleConnections();
  server.close(() => process.exit(0));
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
