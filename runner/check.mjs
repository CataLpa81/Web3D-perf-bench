import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CASES, DEFAULTS, interpolateCapacity } from '../spec/cases.js';
import { buildGridForTotalTriangles } from '../spec/scene-spec.js';
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

for (const caseId of ['lights', 'lights-forward', 'drawcalls']) {
  const testCase = CASES[caseId];
  for (const count of testCase.ladder) {
    const objects = testCase.axis === 'objects' ? count : testCase.fixed.objects;
    const grid = buildGridForTotalTriangles(testCase.fixed.triangles, objects);
    if (grid.triangleCount * objects !== testCase.fixed.triangles) {
      throw new Error(`${caseId}@${count}: triangle total is not exact`);
    }
  }
}

const bounded = interpolateCapacity([
  { value: 100, p95: 10 },
  { value: 200, p95: 20 },
], 16.67);
if (bounded.status !== 'bounded' || bounded.capacity !== 100) {
  throw new Error('capacity must report a tested bound without interpolation');
}
const nonmonotonic = interpolateCapacity([
  { value: 100, p95: 10 },
  { value: 200, p95: 20 },
  { value: 400, p95: 12 },
], 16.67);
if (nonmonotonic.status !== 'nonmonotonic') {
  throw new Error('capacity must reject materially non-monotonic ladders');
}
const invalidBound = interpolateCapacity([
  { value: 100, p95: 10, complete: true },
  { value: 200, p95: null, complete: false },
  { value: 400, p95: 12, complete: true },
], 16.67);
if (invalidBound.status !== 'bounded-invalid' || invalidBound.capacity !== 100) {
  throw new Error('capacity must stop at the first incomplete rung');
}
const completedBoundBeforeInvalid = interpolateCapacity([
  { value: 100, p95: 10, complete: true },
  { value: 200, p95: 20, complete: true },
  { value: 400, p95: null, complete: false },
], 16.67);
if (completedBoundBeforeInvalid.status !== 'bounded' || completedBoundBeforeInvalid.capacity !== 100) {
  throw new Error('a later incomplete rung must not erase an established tested bound');
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
