// Static server exposing harness files and npm packages without copying vendor code.
//
// Routes:
//   /                → harness/index.html
//   /vendor/<pkg>/…  → node_modules/<pkg>/…
//   everything else  → harness/<path>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, dirname, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
const HARNESS_DIR = join(ROOT, 'harness');
const MODULES_DIR = join(ROOT, 'node_modules');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
};

// The resolved path must remain inside the allowed root.
function safeJoin(base, rel) {
  const full = normalize(join(base, rel));
  const relToBase = relative(base, full);
  return relToBase && !relToBase.startsWith('..') && !isAbsolute(relToBase) ? full : null;
}

function resolve(urlPath) {
  if (urlPath === '/' || urlPath === '') return join(HARNESS_DIR, 'index.html');
  // npm package mapping.
  if (urlPath.startsWith('/vendor/')) return safeJoin(MODULES_DIR, urlPath.slice('/vendor/'.length));
  // Shared harness and spec modules resolve from the project root.
  if (urlPath.startsWith('/harness/') || urlPath.startsWith('/spec/')) return safeJoin(ROOT, urlPath);
  // Engine pages resolve from harness/.
  return safeJoin(HARNESS_DIR, urlPath);
}

export function startServer(port = 0) {
  return new Promise((resolve_, reject_) => {
    const server = createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        // Avoid a favicon 404, which the parity gate would treat as a console error.
        if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        const fp = resolve(urlPath);
        if (!fp || !existsSync(fp) || !statSync(fp).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 ' + urlPath);
          return;
        }
        const buf = await readFile(fp);
        res.writeHead(200, {
          'Content-Type': MIME[extname(fp)] || 'application/octet-stream',
          // Each run should load a clean page.
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e));
      }
    });
    // Surface listen failures such as EADDRINUSE to callers.
    server.once('error', reject_);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject_);
      resolve_(server);
    });
  });
}

// Standalone preview server: node runner/server.mjs [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8500;
  const s = await startServer(port);
  console.log(`[server] http://127.0.0.1:${s.address().port}/`);
}
