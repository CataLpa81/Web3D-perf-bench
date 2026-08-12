// Open the manual bench in Chromium with GPU and vsync flags.
// Usage: node runner/open-bench.mjs [port]
import { chromium } from 'playwright';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from './server.mjs';
import { chromiumArgs } from './browser.mjs';

const port = Number(process.argv[2]) || 8500;
let server = null;
try {
  server = await startServer(port);
} catch (e) {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`[bench] Port ${port} is already in use; reusing the existing server`);
}
const actualPort = server ? server.address().port : port;

// Isolate persistent profiles by port so multiple benches can run independently.
const profileDir = join(tmpdir(), `h5-3d-bench-profile-${port}`);
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
  args: [
    ...chromiumArgs(),
    '--window-size=1400,1080',
    '--auto-open-devtools-for-tabs=false',
  ],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`http://127.0.0.1:${actualPort}/`);

console.log(`[bench] Manual bench opened: http://127.0.0.1:${actualPort}/`);
console.log('[bench] Vsync is disabled; the harness caps rendering at 300 FPS');
console.log(`[bench] The server remains available at http://127.0.0.1:${actualPort}/`);
console.log('[bench] Regular browser windows remain vsync-limited');

// Keep the server alive after the window closes.
process.on('SIGINT', async () => {
  await ctx.close().catch(() => {});
  if (server) server.close();
  process.exit(0);
});
await new Promise(() => {});   // Wait for SIGINT.
