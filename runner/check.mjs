import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CASES, DEFAULTS } from '../spec/cases.js';
import { ROOT, startServer } from './server.mjs';

const scripts = [
  'runner/browser.mjs',
  'runner/collect.mjs',
  'runner/open-bench.mjs',
  'runner/report.mjs',
  'runner/server.mjs',
  'spec/cases.js',
  'spec/contract.js',
  'spec/scene-spec.js',
  'harness/common/probe.js',
  'harness/common/runtime.js',
];

for (const file of scripts) {
  execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
}

const tempDir = await mkdtemp(join(tmpdir(), 'h5-3d-bench-check-'));
try {
  for (const file of ['harness/three.html', 'harness/babylon.html', 'harness/playcanvas.html', 'harness/index.html']) {
    const source = await readFile(join(ROOT, file), 'utf8');
    const matches = [...source.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/g)];
    if (!matches.length) throw new Error(`${file}: module script not found`);
    for (let i = 0; i < matches.length; i++) {
      const out = join(tempDir, `${basename(file)}-${i}.mjs`);
      await writeFile(out, matches[i][1]);
      execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

for (const [id, testCase] of Object.entries(CASES)) {
  if (!testCase.domain || !Array.isArray(testCase.ladder) || !testCase.ladder.length) {
    throw new Error(`${id}: invalid case definition`);
  }
  for (const key of Object.keys(testCase.fixed || {})) {
    if (!(key in DEFAULTS)) throw new Error(`${id}: unknown fixed parameter ${key}`);
  }
}

for (const file of [
  'harness/assets/CesiumMan.glb',
  'harness/assets/ammo.wasm.js',
  'harness/assets/ammo.wasm.wasm',
  'harness/assets/AMMO-LICENSE.txt',
  'harness/assets/pbr/albedo.jpg',
  'harness/assets/pbr/normal.jpg',
  'harness/assets/pbr/roughness.jpg',
  'harness/assets/pbr/metalness.jpg',
]) {
  await access(join(ROOT, file));
}

const server = await startServer(0);
try {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  for (const path of ['/', '/spec/cases.js', '/vendor/three/build/three.module.js']) {
    const response = await fetch(base + path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  }
  const traversalStatus = await new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: '/harness/%2e%2e/%2e%2e/package.json',
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  if (traversalStatus !== 404) throw new Error('path traversal check failed');
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log(`[check] ${Object.keys(CASES).length} cases, syntax, assets and server routes OK`);
