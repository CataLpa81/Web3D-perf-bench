// Each engine/rung pair gets a fresh page and WebGL context.
//
// Usage:
//   node runner/collect.mjs
//   node runner/collect.mjs --case=lights,drawcalls
//   node runner/collect.mjs --domain=render
//   node runner/collect.mjs --case=shadows --duration=6000 --repeats=5
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { createHash } from 'node:crypto';
import { startServer, ROOT } from './server.mjs';
import { chromiumArgs } from './browser.mjs';
import { buildRunPoints, CASES, DEFAULTS, DOMAINS, DOMAIN_ORDER, VSYNC_BUDGET, interpolateCapacity } from '../spec/cases.js';
import { CONTRACT, mulberry32 } from '../spec/contract.js';

const ENGINES = [
  { key: 'three', page: 'three.html' },
  { key: 'babylon', page: 'babylon.html' },
  { key: 'playcanvas', page: 'playcanvas.html' },
];

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] ?? true;
  }
  return args;
}
const args = parseArgs();
const RUN_CONFIG = {
  durationMs: args.duration == null ? 6000 : Number(args.duration),
  repeats: args.repeats == null ? 5 : Number(args.repeats),
  minFrames: args['min-frames'] == null ? 180 : Number(args['min-frames']),
  orderSeed: args.seed == null ? 0x51a7 : Number(args.seed),
};
if (!Number.isFinite(RUN_CONFIG.durationMs) || RUN_CONFIG.durationMs <= 0) {
  console.error(`[collect] invalid --duration=${args.duration}`);
  process.exit(1);
}
if (!Number.isInteger(RUN_CONFIG.repeats) || RUN_CONFIG.repeats <= 0) {
  console.error(`[collect] invalid --repeats=${args.repeats}`);
  process.exit(1);
}
if (!Number.isInteger(RUN_CONFIG.minFrames) || RUN_CONFIG.minFrames <= 0) {
  console.error(`[collect] invalid --min-frames=${args['min-frames']}`);
  process.exit(1);
}
if (!Number.isInteger(RUN_CONFIG.orderSeed)) {
  console.error(`[collect] invalid --seed=${args.seed}`);
  process.exit(1);
}
const fpsCapArg = args['fps-cap'] == null ? CONTRACT.frameRateCap : Number(args['fps-cap']);
if (!Number.isFinite(fpsCapArg) || fpsCapArg <= 0) {
  console.error(`[collect] invalid --fps-cap=${args['fps-cap']}`);
  process.exit(1);
}
const requestedFpsCap = Math.min(CONTRACT.frameRateCap, fpsCapArg);
const caseIds = args.case ? String(args.case).split(',').map(s => s.trim()) : null;
// --domain accepts a comma-separated subset of render, animation, physics, and baseline.
const domainFilter = args.domain ? String(args.domain).split(',').map(s => s.trim()) : null;
const engineFilter = args.engine ? String(args.engine).split(',').map(s => s.trim()) : null;
const engines = engineFilter ? ENGINES.filter(e => engineFilter.includes(e.key)) : ENGINES;
if (engineFilter) {
  const unknown = engineFilter.filter(key => !ENGINES.some(engine => engine.key === key));
  if (unknown.length) {
    console.error(`[collect] unknown engine: ${unknown.join(', ')}. Available: ${ENGINES.map(e => e.key).join(', ')}`);
    process.exit(1);
  }
}

const CHROME_ARGS = chromiumArgs();

// Headless by default. The GPU gate rejects software renderers such as SwiftShader.
const HEADLESS = !args.headed;

function metricForRecord(caseId, rec) {
  const mode = CASES[caseId]?.primaryMetric || 'cpu';
  if (mode === 'gpu') return rec.info?.gpuFrame || null;
  if (mode === 'bottleneck') {
    const cpu = rec.info?.cpuFrame;
    const gpu = rec.info?.gpuFrame;
    if (!cpu || !gpu) return null;
    return {
      frameCount: Math.min(cpu.frameCount || 0, gpu.frameCount || 0),
      p50: Math.max(cpu.p50 ?? 0, gpu.p50 ?? 0),
      p95: Math.max(cpu.p95 ?? 0, gpu.p95 ?? 0),
      p99: Math.max(cpu.p99 ?? 0, gpu.p99 ?? 0),
      max: Math.max(cpu.max ?? 0, gpu.max ?? 0),
      mean: Math.max(cpu.mean ?? 0, gpu.mean ?? 0),
      source: (gpu.p95 ?? 0) >= (cpu.p95 ?? 0) ? 'gpu' : 'cpu',
    };
  }
  return rec.info?.cpuFrame || null;
}

// ---------- Blocking parity gate ----------
// The gate checks equal inputs, not equal visual output.
function gateSingle(rec) {
  const reasons = [];
  const { info, state } = rec;
  if (!info || !state) { reasons.push('NO_HARNESS_DATA'); return reasons; }
  if (state.error) reasons.push(`RUNTIME_ERROR: ${state.error}`);
  if (!info.gpu?.ok) reasons.push(`GPU_NOT_REAL: ${info.gpu?.renderer}`);
  if (!info.gpu?.webgl2) reasons.push('WEBGL2_REQUIRED');
  if (info.actual?.antialiasEnabled !== CONTRACT.antialias) {
    reasons.push(`ANTIALIAS_MISMATCH: expected=${CONTRACT.antialias} actual=${info.actual?.antialiasEnabled}`);
  }
  if (info.renderWidth !== 1280 || info.renderHeight !== 720) {
    reasons.push(`BACKBUFFER_MISMATCH: ${info.renderWidth}x${info.renderHeight}`);
  }
  // Heavy scenes may extend their duration to reach this sample floor.
  const minFrames = rec.minFrames ?? 300;
  if (!info.cpuFrame || info.cpuFrame.steadyFrameCount < minFrames) {
    reasons.push(`INSUFFICIENT_STEADY_CPU_SAMPLES: ${info.cpuFrame?.steadyFrameCount ?? 0} < ${minFrames}`);
  }
  if (info.hitDurationCeiling) {
    reasons.push(`DURATION_CEILING_REACHED: ${info.actualDurationMs ?? 'n/a'}ms`);
  }
  if (info.steadyForced) {
    reasons.push(`STEADY_STATE_NOT_CONVERGED: windows=${JSON.stringify(info.steadyWindowsP95 || [])}`);
  }
  if (CASES[rec.caseId]?.gpuTiming) {
    if (!info.gpuFrame?.supported) {
      reasons.push(`GPU_TIMER_UNSUPPORTED: ${rec.caseId} requires EXT_disjoint_timer_query_webgl2`);
    } else {
      if (info.gpuFrame.disjointEvents > 0) {
        reasons.push(`GPU_TIMER_DISJOINT: ${info.gpuFrame.disjointEvents}`);
      }
      if (info.gpuFrame.skippedFrames > 0) {
        reasons.push(`GPU_TIMER_SKIPPED_FRAMES: ${info.gpuFrame.skippedFrames}`);
      }
      if (info.gpuFrame.frameCount < minFrames) {
        reasons.push(`INSUFFICIENT_GPU_FRAMES: ${info.gpuFrame.frameCount} < ${minFrames}`);
      }
    }
  }
  if (!info.probe || info.probe.drawCalls <= 0) {
    // Empty and CPU-only raycast intentionally allow zero draw calls.
    if (rec.caseId !== 'empty' && rec.caseId !== 'raycast') {
      reasons.push(`NO_DRAW_CALLS: ${info.probe?.drawCalls}`);
    }
  }
  // The framebuffer probe catches geometry that was submitted but fully culled.
  const expectsPixels = rec.caseId !== 'empty'
    && ((rec.params?.objects > 0) || (rec.params?.coverage > 0)
        || (rec.params?.shadowCasters > 0) || (rec.params?.visibilityObjects > 0)
        || (rec.params?.skinned > 0) || (rec.params?.bodies > 0));
  if (expectsPixels && info.framebufferCoverage != null && info.framebufferCoverage < 0.001) {
    reasons.push(`EMPTY_FRAMEBUFFER: coverage=${info.framebufferCoverage} (scene content produced no visible pixels)`);
  }
  // Actual layers must match the requested coverage multiplier.
  if (rec.params?.coverage > 0 && info.actual?.overdrawLayers != null
      && info.actual.overdrawLayers !== rec.params.coverage) {
    reasons.push(`OVERDRAW_LAYER_MISMATCH: requested=${rec.params.coverage} actual=${info.actual.overdrawLayers}`);
  }
  if (rec.params?.coverage > 0
      && (!(info.overdrawGeometryCoverage >= 0.995))) {
    reasons.push(`OVERDRAW_NOT_FULLSCREEN: diagnostic coverage=${info.overdrawGeometryCoverage ?? 'n/a'}`);
  }
  if (rec.params?.coverage > 0 && info.actual?.overdrawTextureInputs !== 4) {
    reasons.push(`OVERDRAW_TEXTURE_INPUT_MISMATCH: ${info.actual?.overdrawTextureInputs ?? 'n/a'} != 4`);
  }
  if (rec.params?.coverage > 0 && (info.actual?.overdrawActiveSamplers?.length ?? 0) < 4) {
    reasons.push(`OVERDRAW_TEXTURES_NOT_SAMPLED: ${info.actual?.overdrawActiveSamplers?.join(',') || 'none'}`);
  }
  if (rec.caseId === 'raycast' && info.actual?.raycastParity !== true) {
    reasons.push(`RAYCAST_HIT_MISMATCH: expected=${info.actual?.raycastExpectedHits ?? 'n/a'} actual=${info.actual?.raycastHits ?? 'n/a'}`);
  }
  if (rec.params?.shadowCasters > 0) {
    if (info.actual?.shadowInstanced !== true) reasons.push('SHADOW_CASTERS_NOT_INSTANCED');
    if (info.actual?.shadowLights !== rec.params.shadowLights) {
      reasons.push(`SHADOW_LIGHT_MISMATCH: requested=${rec.params.shadowLights} actual=${info.actual?.shadowLights ?? 'n/a'}`);
    }
    if (info.actual?.shadowMaps !== rec.params.shadowLights) {
      reasons.push(`SHADOW_MAP_COUNT_MISMATCH: requested=${rec.params.shadowLights} actual=${info.actual?.shadowMaps ?? 'n/a'}`);
    }
    if (info.actual?.shadowMapSize !== rec.params.shadowMapSize) {
      reasons.push(`SHADOW_MAP_SIZE_MISMATCH: requested=${rec.params.shadowMapSize} actual=${info.actual?.shadowMapSize ?? 'n/a'}`);
    }
    if (Math.abs((info.actual?.shadowNear ?? NaN) - CONTRACT.shadow.near) > 1e-6) {
      reasons.push(`SHADOW_NEAR_MISMATCH: expected=${CONTRACT.shadow.near} actual=${info.actual?.shadowNear ?? 'n/a'}`);
    }
    if (info.actual?.shadowMapStorage !== 'independent-2d-per-light') {
      reasons.push(`SHADOW_MAP_STORAGE_INVALID: ${info.actual?.shadowMapStorage ?? 'n/a'}`);
    }
    if (info.probe?.drawCalls !== info.actual?.expectedShadowDrawCalls) {
      reasons.push(`SHADOW_DRAW_CALL_MISMATCH: expected=${info.actual?.expectedShadowDrawCalls ?? 'n/a'} actual=${info.probe?.drawCalls ?? 'n/a'}`);
    }
    if (info.probe?.triangles !== info.actual?.expectedShadowTriangles) {
      reasons.push(`SHADOW_TRIANGLE_MISMATCH: expected=${info.actual?.expectedShadowTriangles ?? 'n/a'} actual=${info.probe?.triangles ?? 'n/a'}`);
    }
  }
  if (rec.caseId === 'drawcalls') {
    if (info.actual?.uniqueGeometryResources !== 1) {
      reasons.push(`GEOMETRY_NOT_SHARED: unique=${info.actual?.uniqueGeometryResources ?? 'n/a'}`);
    }
    if (info.probe?.drawCalls !== rec.params.objects) {
      reasons.push(`DRAWCALL_MISMATCH: expected=${rec.params.objects} actual=${info.probe?.drawCalls ?? 'n/a'}`);
    }
    if (info.probe?.triangles !== rec.params.triangles) {
      reasons.push(`DRAW_TRIANGLE_MISMATCH: expected=${rec.params.triangles} actual=${info.probe?.triangles ?? 'n/a'}`);
    }
  }
  if (rec.caseId === 'visibility') {
    if (info.actual?.expectedVisibleObjects !== rec.params.visibleCount) {
      reasons.push(`VISIBLE_INPUT_MISMATCH: expected=${rec.params.visibleCount} actual=${info.actual?.expectedVisibleObjects ?? 'n/a'}`);
    }
    if (info.probe?.drawCalls !== rec.params.visibleCount) {
      reasons.push(`VISIBLE_SUBMISSION_MISMATCH: expected=${rec.params.visibleCount} actual=${info.probe?.drawCalls ?? 'n/a'}`);
    }
  }
  if (rec.caseId === 'physics') {
    if (info.actual?.physicsInstanced !== true) reasons.push('PHYSICS_RENDER_NOT_INSTANCED');
    if (info.actual?.physStepsPerFrame !== 1) reasons.push(`PHYSICS_STEPS_PER_FRAME_INVALID: ${info.actual?.physStepsPerFrame ?? 'n/a'}`);
    if (info.actual?.physicsSleepingAllowed !== false) reasons.push('PHYSICS_SLEEP_NOT_DISABLED');
    if (info.actual?.physicsSleepingBodies !== 0) {
      reasons.push(`PHYSICS_SLEEPING_BODIES: ${info.actual?.physicsSleepingBodies ?? 'n/a'}`);
    }
    if (info.probe?.drawCalls !== info.actual?.expectedPhysicsDrawCalls) {
      reasons.push(`PHYSICS_DRAWCALL_MISMATCH: expected=${info.actual?.expectedPhysicsDrawCalls ?? 'n/a'} actual=${info.probe?.drawCalls ?? 'n/a'}`);
    }
    if (info.probe?.triangles !== info.actual?.expectedPhysicsTriangles) {
      reasons.push(`PHYSICS_TRIANGLE_MISMATCH: expected=${info.actual?.expectedPhysicsTriangles ?? 'n/a'} actual=${info.probe?.triangles ?? 'n/a'}`);
    }
  }
  if (rec.caseId === 'skinned') {
    if (info.actual?.bonesPerChar !== 19) reasons.push(`SKINNED_BONE_MISMATCH: ${info.actual?.bonesPerChar ?? 'n/a'} != 19`);
    if (info.actual?.animChannels !== 57) reasons.push(`SKINNED_CHANNEL_MISMATCH: ${info.actual?.animChannels ?? 'n/a'} != 57`);
    if (info.probe?.drawCalls !== info.actual?.expectedSkinnedDrawCalls) {
      reasons.push(`SKINNED_DRAWCALL_MISMATCH: expected=${info.actual?.expectedSkinnedDrawCalls ?? 'n/a'} actual=${info.probe?.drawCalls ?? 'n/a'}`);
    }
    if (info.probe?.triangles !== info.actual?.expectedSkinnedTriangles) {
      reasons.push(`SKINNED_TRIANGLE_MISMATCH: expected=${info.actual?.expectedSkinnedTriangles ?? 'n/a'} actual=${info.probe?.triangles ?? 'n/a'}`);
    }
  }
  if (rec.consoleErrors?.length) reasons.push(`CONSOLE_ERRORS: ${rec.consoleErrors.length}`);
  // Engine limits are reported separately from harness failures.
  const limitPat = /MAX_FRAGMENT_UNIFORM_VECTORS|uniforms count exceeds|too many uniforms|VALIDATE_STATUS/i;
  const oomPat = /Aborted\(OOM\)|out of memory/i;
  const runtimeMessages = [...(rec.consoleErrors || []), state.error || ''];
  if (runtimeMessages.some(e => oomPat.test(e))) {
    rec.engineLimit = 'OUT_OF_MEMORY';
    rec.engineLimitDetail = (runtimeMessages.find(e => oomPat.test(e)) || '').slice(0, 200);
  } else if ((rec.consoleErrors || []).some(e => limitPat.test(e))) {
    rec.engineLimit = 'SHADER_UNIFORM_LIMIT';
    rec.engineLimitDetail = (rec.consoleErrors.find(e => limitPat.test(e)) || '').slice(0, 200);
  }
  if (info.shaderWaitTimedOut) reasons.push('SHADER_WAIT_TIMEOUT');
  return reasons;
}

// Cross-engine checks require equal scene inputs. Submitted work may differ because
// default culling policies are part of the behavior being measured.
function gateCrossEngine(recsAtRung) {
  const reasons = [];
  const warnings = [];
  // A failed peer cannot provide comparable state and must not invalidate
  // independently valid engines at the same rung.
  const ok = recsAtRung.filter(r => r.valid && r.info?.actual);
  if (ok.length < 2) return { reasons, warnings };
  const allEq = (a) => a.every(v => v === a[0]);

  const tris = ok.map(r => r.info.actual.totalTriangles ?? 0);
  const verts = ok.map(r => r.info.actual.vertexCountPerMesh ?? 0);
  const insts = ok.map(r => r.info.actual.instances ?? 0);
  if (!allEq(tris)) reasons.push(`TRIANGLE_INPUT_MISMATCH: ${ok.map((r, i) => `${r.engine}=${tris[i]}`).join(' ')}`);
  if (!allEq(verts)) reasons.push(`VERTEX_INPUT_MISMATCH: ${ok.map((r, i) => `${r.engine}=${verts[i]}`).join(' ')}`);
  if (!allEq(insts)) reasons.push(`INSTANCE_INPUT_MISMATCH: ${ok.map((r, i) => `${r.engine}=${insts[i]}`).join(' ')}`);

  const actualField = {
    lights: 'lights',
    shadows: 'shadowCasters',
    'shadow-maps': 'shadowLights',
    visibility: 'visibilityObjects',
    raycast: 'raycasts',
    skinned: 'skinned',
    physics: 'bodies',
    'overdraw-pbr': 'overdrawLayers',
  }[ok[0].caseId];
  if (actualField) {
    const values = ok.map(r => r.info.actual[actualField]);
    if (values.some(value => !Number.isFinite(value)) || !allEq(values)) {
      reasons.push(`ACTUAL_${actualField.toUpperCase()}_MISMATCH: `
        + ok.map((r, i) => `${r.engine}=${values[i] ?? 'n/a'}`).join(' '));
    }
  }
  if (ok[0].caseId === 'physics') {
    const steps = ok.map(r => r.info.actual.physFixedStep);
    if (steps.some(value => !Number.isFinite(value)) || !allEq(steps)) {
      reasons.push(`PHYSICS_STEP_MISMATCH: ${ok.map((r, i) => `${r.engine}=${steps[i] ?? 'n/a'}`).join(' ')}`);
    }
    const perFrame = ok.map(r => r.info.actual.physStepsPerFrame);
    if (perFrame.some(value => value !== 1) || !allEq(perFrame)) {
      reasons.push(`PHYSICS_STEPS_PER_FRAME_MISMATCH: ${ok.map((r, i) => `${r.engine}=${perFrame[i] ?? 'n/a'}`).join(' ')}`);
    }
    const instanced = ok.map(r => r.info.actual.physicsInstanced);
    if (instanced.some(value => value !== true)) {
      reasons.push(`PHYSICS_RENDER_PATH_MISMATCH: ${ok.map((r, i) => `${r.engine}=${instanced[i] ?? 'n/a'}`).join(' ')}`);
    }
    const sleepingAllowed = ok.map(r => r.info.actual.physicsSleepingAllowed);
    if (sleepingAllowed.some(value => value !== false)) {
      reasons.push(`PHYSICS_SLEEP_POLICY_MISMATCH: ${ok.map((r, i) => `${r.engine}=${sleepingAllowed[i] ?? 'n/a'}`).join(' ')}`);
    }
    const sleepingBodies = ok.map(r => r.info.actual.physicsSleepingBodies);
    if (sleepingBodies.some(value => value !== 0)) {
      reasons.push(`PHYSICS_SLEEPING_BODY_MISMATCH: ${ok.map((r, i) => `${r.engine}=${sleepingBodies[i] ?? 'n/a'}`).join(' ')}`);
    }
  }
  if (ok[0].caseId === 'shadows' || ok[0].caseId === 'shadow-maps') {
    const sizes = ok.map(r => r.info.actual.shadowMapSize);
    if (sizes.some(value => !Number.isFinite(value)) || !allEq(sizes)) {
      reasons.push(`SHADOW_MAP_SIZE_MISMATCH: ${ok.map((r, i) => `${r.engine}=${sizes[i] ?? 'n/a'}`).join(' ')}`);
    }
    const near = ok.map(r => r.info.actual.shadowNear);
    if (near.some(value => !Number.isFinite(value)) || !allEq(near)) {
      reasons.push(`SHADOW_NEAR_MISMATCH: ${ok.map((r, i) => `${r.engine}=${near[i] ?? 'n/a'}`).join(' ')}`);
    }
    const maps = ok.map(r => r.info.actual.shadowMaps);
    if (maps.some(value => !Number.isFinite(value)) || !allEq(maps)) {
      reasons.push(`SHADOW_MAP_COUNT_MISMATCH: ${ok.map((r, i) => `${r.engine}=${maps[i] ?? 'n/a'}`).join(' ')}`);
    }
    const casters = ok.map(r => r.info.actual.shadowCasters);
    if (casters.some(value => !Number.isFinite(value)) || !allEq(casters)) {
      reasons.push(`SHADOW_CASTER_MISMATCH: ${ok.map((r, i) => `${r.engine}=${casters[i] ?? 'n/a'}`).join(' ')}`);
    }
    const policies = ok.map(r => r.info.actual.shadowType);
    if (policies.some(value => !value) || !allEq(policies)) {
      reasons.push(`SHADOW_FILTER_MISMATCH: ${ok.map((r, i) => `${r.engine}=${policies[i] ?? 'n/a'}`).join(' ')}`);
    }
    const geometries = ok.map(r => r.info.actual.shadowCasterGeometry);
    if (geometries.some(value => !value) || !allEq(geometries)) {
      reasons.push(`SHADOW_CASTER_GEOMETRY_MISMATCH: ${ok.map((r, i) => `${r.engine}=${geometries[i] ?? 'n/a'}`).join(' ')}`);
    }
    const trianglesPerCaster = ok.map(r => r.info.actual.shadowTrianglesPerCaster);
    if (trianglesPerCaster.some(value => !Number.isFinite(value)) || !allEq(trianglesPerCaster)) {
      reasons.push(`SHADOW_TRIANGLES_PER_CASTER_MISMATCH: ${ok.map((r, i) => `${r.engine}=${trianglesPerCaster[i] ?? 'n/a'}`).join(' ')}`);
    }
    const storage = ok.map(r => r.info.actual.shadowMapStorage);
    if (storage.some(value => !value) || !allEq(storage)) {
      reasons.push(`SHADOW_MAP_STORAGE_MISMATCH: ${ok.map((r, i) => `${r.engine}=${storage[i] ?? 'n/a'}`).join(' ')}`);
    }
    for (const field of [
      'shadowCasterLayoutSignature',
      'shadowLightLayoutSignature',
      'shadowProjectionSignature',
    ]) {
      const signatures = ok.map(r => r.info.actual[field]);
      if (signatures.some(value => !value) || !allEq(signatures)) {
        reasons.push(`${field.replaceAll(/([A-Z])/g, '_$1').toUpperCase()}_MISMATCH: `
          + ok.map((r, i) => `${r.engine}=${signatures[i] ?? 'n/a'}`).join(' '));
      }
    }
  }
  if (ok[0].caseId === 'visibility') {
    const visible = ok.map(r => r.info.actual.expectedVisibleObjects);
    if (visible.some(value => !Number.isFinite(value)) || !allEq(visible)) {
      reasons.push(`EXPECTED_VISIBLE_MISMATCH: ${ok.map((r, i) => `${r.engine}=${visible[i] ?? 'n/a'}`).join(' ')}`);
    }
  }
  if (ok[0].caseId === 'skinned') {
    for (const field of ['bonesPerChar', 'animChannels', 'expectedSkinnedDrawCalls', 'expectedSkinnedTriangles']) {
      const values = ok.map(r => r.info.actual[field]);
      if (values.some(value => !Number.isFinite(value)) || !allEq(values)) {
        reasons.push(`SKINNED_${field.toUpperCase()}_MISMATCH: ${ok.map((r, i) => `${r.engine}=${values[i] ?? 'n/a'}`).join(' ')}`);
      }
    }
  }
  if (ok[0].caseId === 'drawcalls' || ok[0].caseId === 'lights' || ok[0].caseId === 'lights-forward') {
    const uniqueResources = ok.map(r => r.info.actual.uniqueGeometryResources);
    if (uniqueResources.some(value => value !== 1) || !allEq(uniqueResources)) {
      reasons.push(`GEOMETRY_SHARING_MISMATCH: ${ok.map((r, i) => `${r.engine}=${uniqueResources[i] ?? 'n/a'}`).join(' ')}`);
    }
  }
  if (ok[0].caseId === 'raycast') {
    const targets = ok.map(r => r.info.actual.raycastTargets);
    const hits = ok.map(r => r.info.actual.raycastHits);
    if (targets.some(value => !Number.isFinite(value)) || !allEq(targets)) {
      reasons.push(`RAYCAST_TARGET_MISMATCH: ${ok.map((r, i) => `${r.engine}=${targets[i] ?? 'n/a'}`).join(' ')}`);
    }
    if (hits.some(value => !Number.isFinite(value)) || !allEq(hits)) {
      reasons.push(`RAYCAST_HIT_MISMATCH: ${ok.map((r, i) => `${r.engine}=${hits[i] ?? 'n/a'}`).join(' ')}`);
    }
  }

  // Different default light policies are reported without changing them.
  if (ok[0].caseId === 'lights') {
    const pol = ok.map(r => `${r.engine}=${r.info.actual.lightPolicy}`);
    if (!allEq(ok.map(r => r.info.actual.lightPolicy))) {
      warnings.push(`LIGHT_POLICY_DIFFERS: ${pol.join(' ')}`);
    }
    const fb = ok.filter(r => r.info.framebufferCoverage != null)
                 .map(r => `${r.engine}=${r.info.framebufferCoverage.toFixed(3)}`);
    if (fb.length >= 2) warnings.push(`FRAMEBUFFER_COVERAGE: ${fb.join(' ')}`);
  }
  if (ok[0].caseId === 'lights-forward') {
    const policies = ok.map(r => r.info.actual.lightPolicy);
    if (policies.some(value => !value) || policies.some(value => !/forward/i.test(value))) {
      reasons.push(`NORMALIZED_LIGHT_POLICY_INVALID: ${ok.map((r, i) => `${r.engine}=${policies[i] ?? 'n/a'}`).join(' ')}`);
    }
  }

  // Record submitted-work differences for report interpretation.
  const withProbe = ok.filter(r => r.info.probe);
  if (withProbe.length >= 2) {
    const dc = withProbe.map(r => r.info.probe.drawCalls);
    const pt = withProbe.map(r => r.info.probe.triangles);
    if (!allEq(dc)) {
      const spread = (Math.max(...dc) - Math.min(...dc)) / Math.max(...dc);
      warnings.push(`SUBMITTED_DRAWCALLS_DIFFER(${(spread * 100).toFixed(1)}%): ${withProbe.map((r, i) => `${r.engine}=${dc[i]}`).join(' ')}`);
    }
    if (!allEq(pt)) {
      const spread = (Math.max(...pt) - Math.min(...pt)) / Math.max(...pt);
      warnings.push(`SUBMITTED_TRIANGLES_DIFFER(${(spread * 100).toFixed(1)}%): ${withProbe.map((r, i) => `${r.engine}=${pt[i]}`).join(' ')}`);
    }
  }
  return { reasons, warnings };
}

async function runOne(browser, port, engine, point, durationMs, repeat, shotDir, minFrames) {
  // The harness may extend the run until it reaches this same sample threshold.
  const qs = new URLSearchParams({
    ...point.params, case: point.caseId, duration: durationMs,
    minSteadyFrames: minFrames ?? 0,
    minGpuFrames: CASES[point.caseId]?.gpuTiming ? (minFrames ?? 0) : 0,
    fpsCap: requestedFpsCap,
  });
  const url = `http://127.0.0.1:${port}/${engine.page}?${qs}`;

  // Reuse the browser process, but isolate every run in a new context, page,
  // WebGL context, and engine instance.
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) consoleErrors.push(`http ${r.status()} ${r.url()}`); });

  let info = null, state = null, timedOut = false;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'commit' });
    // Fail quickly when module loading prevents the harness state from appearing.
    await page.waitForFunction(() => window.__HARNESS_STATE__ !== undefined, null, { timeout: 20000 });
    await page.waitForFunction(() => window.__HARNESS_STATE__?.shaderReady === true, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__HARNESS_STATE__?.scenarioCompleted === true, null,
      { timeout: Math.max(durationMs + 120000, durationMs * 4 + 30000) });
    // Screenshots are evidence only and are not used by the gate.
    if (shotDir && repeat === 0) {
      await page.screenshot({ path: join(shotDir, `${point.id}__${engine.key}.png`) });
    }
  } catch (e) {
    timedOut = true;
    consoleErrors.push('TIMEOUT: ' + e.message);
  }
  try {
    info = await page.evaluate(() => window.__HARNESS_INFO__);
    state = await page.evaluate(() => window.__HARNESS_STATE__);
  } catch { /* The page may already be gone. */ }
  await context.close();

  return {
    engine: engine.key, caseId: point.caseId, axis: point.axis, value: point.value,
    pointId: point.id, params: point.params, variant: point.variant ?? null,
    cycle: point.cycle ?? null, repeat,
    wallMs: Date.now() - t0, timedOut, consoleErrors, info, state,
  };
}

// ---------- Environment fingerprint ----------
async function envFingerprint() {
  const browser = await chromium.launch({ headless: HEADLESS, args: CHROME_ARGS });
  const page = await browser.newPage();
  const browserVersion = browser.version();
  const ua = await page.evaluate(() => navigator.userAgent);
  const navigatorInfo = await page.evaluate(() => ({
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    platform: navigator.platform,
  }));
  const power = await page.evaluate(async () => {
    if (!navigator.getBattery) return null;
    try {
      const battery = await navigator.getBattery();
      return {
        charging: battery.charging,
        level: battery.level,
        chargingTime: battery.chargingTime,
        dischargingTime: battery.dischargingTime,
      };
    } catch {
      return null;
    }
  });
  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? { renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) } : null;
  });
  // rAF cadence is diagnostic only; benchmark loops use the configured timer cap.
  const displayIntervalMs = await page.evaluate(() => new Promise(res => {
    const t = []; let last = performance.now(); let n = 0;
    const loop = (now) => { t.push(now - last); last = now; if (++n < 120) requestAnimationFrame(loop); else { t.sort((a, b) => a - b); res(t[Math.floor(t.length / 2)]); } };
    requestAnimationFrame(loop);
  }));
  await browser.close();
  let machine = cpus()[0]?.model || null;
  let os = `${platform()} ${release()}`;
  if (process.platform === 'darwin') {
    try { machine = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim() || machine; } catch {}
    try { os = `macOS ${execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim()}`; } catch {}
  }
  let engineVersions = {};
  let playwrightVersion = null;
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    engineVersions = pkg.dependencies;
    playwrightVersion = pkg.devDependencies?.playwright || null;
  } catch {}
  return {
    ua,
    browserVersion,
    gpu,
    displayIntervalMs,
    navigator: navigatorInfo,
    power,
    machine,
    os,
    engineVersions,
    playwright: playwrightVersion,
    headless: HEADLESS,
    chromiumArgs: CHROME_ARGS,
  };
}

function shuffleForRepeat(input, repeat) {
  const out = [...input];
  const rnd = mulberry32((RUN_CONFIG.orderSeed + repeat * 0x9e3779b9) >>> 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function provenance() {
  const textHash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
  const sourceFiles = [
    'spec/cases.js',
    'spec/contract.js',
    'spec/scene-spec.js',
    'harness/common/runtime.js',
    'harness/common/probe.js',
    'harness/three.html',
    'harness/babylon.html',
    'harness/playcanvas.html',
    'harness/index.html',
    'runner/browser.mjs',
    'runner/collect.mjs',
    'runner/report.mjs',
  ];
  const sourceHasher = createHash('sha256');
  for (const file of sourceFiles) {
    sourceHasher.update(file);
    sourceHasher.update(await readFile(join(ROOT, file)));
  }
  let gitCommit = null;
  let gitDirty = null;
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    gitDirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  } catch {}
  return {
    gitCommit,
    gitDirty,
    packageLockSha256: await textHash(join(ROOT, 'package-lock.json')),
    benchmarkSourceSha256: sourceHasher.digest('hex'),
  };
}

// ---------- Main ----------
const runProvenance = await provenance();
if (args.reference && runProvenance.gitDirty && !args['allow-dirty']) {
  console.error('[collect] reference evidence requires a clean git worktree; commit changes or pass --allow-dirty');
  process.exit(1);
}
const server = await startServer(0);
const port = server.address().port;
const points = buildRunPoints(caseIds, domainFilter);
if (args.values) {
  const values = new Set(String(args.values).split(',').map(Number));
  for (let i = points.length - 1; i >= 0; i--) {
    if (!values.has(points[i].value)) points.splice(i, 1);
  }
}
if (!points.length) { console.error('[collect] no matching run points; check --case and --domain'); process.exit(1); }
const batchId = args.batch || `bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const outDir = join(ROOT, 'results', batchId);
const shotDir = join(outDir, 'screenshots');
await mkdir(shotDir, { recursive: true });
const referencePath = args.reference
  ? join(ROOT, 'evidence', `${batchId.replaceAll('/', '__')}.raw-results.json`)
  : null;
if (referencePath) await mkdir(join(ROOT, 'evidence'), { recursive: true });

console.log(`[collect] batch=${batchId} duration=${RUN_CONFIG.durationMs}ms repeats=${RUN_CONFIG.repeats}`);
for (const d of DOMAIN_ORDER) {
  const ids = [...new Set(points.filter(p => p.domain === d).map(p => p.caseId))];
  if (ids.length) console.log(`[collect] ${DOMAINS[d].title}: ${ids.join(', ')}`);
}
console.log(`[collect] engines=${engines.map(e => e.key).join(',')}`);
console.log(`[collect] run points=${points.length} × engines=${engines.length} × repeats=${RUN_CONFIG.repeats} = ${points.length * engines.length * RUN_CONFIG.repeats} runs\n`);

const env = await envFingerprint();
console.log(`[env] ${env.machine} | ${env.gpu?.renderer}`);
console.log(`[env] browser rAF interval=${env.displayIntervalMs?.toFixed(2)}ms (${(1000 / env.displayIntervalMs).toFixed(0)}Hz)`
  + `; benchmark timer cap=${requestedFpsCap}fps\n`);

const sharedBrowser = await chromium.launch({ headless: HEADLESS, args: CHROME_ARGS });
const records = [];
const basePointIndex = new Map(points.map((point, index) => [point.id, index]));
for (let r = 0; r < RUN_CONFIG.repeats; r++) {
  const repeatPoints = shuffleForRepeat(points, r);
  for (let pointIndex = 0; pointIndex < repeatPoints.length; pointIndex++) {
    const point = repeatPoints[pointIndex];
    const engineOffset = (r + basePointIndex.get(point.id)) % engines.length;
    const engineOrder = engines.map((_, i) => engines[(i + engineOffset) % engines.length]);
    for (let engineOrderPosition = 0; engineOrderPosition < engineOrder.length; engineOrderPosition++) {
      const engine = engineOrder[engineOrderPosition];
      process.stdout.write(`[run] ${point.id.padEnd(24)} ${engine.key.padEnd(11)} r${r} … `);
      const rec = await runOne(sharedBrowser, port, engine, point, RUN_CONFIG.durationMs, r, shotDir, RUN_CONFIG.minFrames);
      rec.minFrames = RUN_CONFIG.minFrames;
      rec.runOrdinal = records.length;
      rec.pointOrderPosition = pointIndex;
      rec.engineOrderPosition = engineOrderPosition;
      rec.gateReasons = gateSingle(rec);
      rec.valid = rec.gateReasons.length === 0;
      records.push(rec);
      const f = rec.info?.frame;
      const cf = rec.info?.cpuFrame;
      const gf = rec.info?.gpuFrame;
      const pr = rec.info?.probe;
      const ext = rec.info?.extendedBeyondDuration ? ` +${((rec.info.actualDurationMs - RUN_CONFIG.durationMs) / 1000).toFixed(1)}s` : '';
      console.log(rec.valid
        ? `${CASES[point.caseId]?.gpuTiming ? `gpuP95=${gf?.p95?.toFixed(1)}ms ` : ''}`
          + `cpuP95=${cf?.p95?.toFixed(1)}ms intervalP95=${f?.p95?.toFixed(1)}ms draw=${pr?.drawCalls} tri=${pr?.triangles} `
          + `(${cf?.frameCount}cpu/${gf?.frameCount ?? 0}gpu${ext})`
        : `INVALID: ${rec.gateReasons.join('; ')}`);
    }
  }
}
await sharedBrowser.close();
server.close();

// Cross-engine gate
const crossReasons = {};
const crossWarnings = {};
for (const point of points) {
  for (let repeat = 0; repeat < RUN_CONFIG.repeats; repeat++) {
    const at = records.filter(r => r.pointId === point.id && r.repeat === repeat);
    const { reasons, warnings } = gateCrossEngine(at);
    const key = `${point.id}#r${repeat}`;
    if (reasons.length) crossReasons[key] = reasons;
    if (warnings.length) crossWarnings[key] = warnings;
    if (reasons.length) {
      for (const rec of at) {
        rec.gateReasons.push(...reasons.map(reason => `CROSS_ENGINE: ${reason}`));
        rec.valid = false;
      }
    }
  }
}

// Capacity calculation
const capacities = {};
for (const caseId of [...new Set(points.map(p => p.caseId))]) {
  const c = CASES[caseId];
  if (!c.axis || c.capacity === false) continue;
  const selectedValues = new Set(points.filter(point => point.caseId === caseId).map(point => point.value));
  if (!c.ladder.every(value => selectedValues.has(value))) continue;
  capacities[caseId] = {};
  for (const engine of engines) {
    const rungs = c.ladder.map((value) => {
      const allAt = records.filter(r => r.caseId === caseId && r.value === value && r.engine === engine.key);
      const lim = allAt.find(r => r.engineLimit);
      const at = allAt.filter(r => r.valid);
      const complete = allAt.length === RUN_CONFIG.repeats && at.length === RUN_CONFIG.repeats;
      if (!complete) {
        return {
          value,
          p95: null,
          complete: false,
          repeats: at.length,
          expectedRepeats: RUN_CONFIG.repeats,
          invalidRepeats: allAt.length - at.length,
          engineLimit: lim ? lim.engineLimit : null,
        };
      }
      // Use the median p95 across repeated runs.
      const p95s = at.map(r => metricForRecord(caseId, r)?.p95)
        .filter(Number.isFinite).sort((a, b) => a - b);
      return {
        value,
        p95: p95s.length ? p95s[Math.floor(p95s.length / 2)] : null,
        complete: p95s.length === RUN_CONFIG.repeats,
        minP95: p95s[0] ?? null,
        maxP95: p95s[p95s.length - 1] ?? null,
        repeats: p95s.length,
        metric: c.primaryMetric || 'cpu',
      };
    });
    capacities[caseId][engine.key] = {
      rungs,
      at60: interpolateCapacity(rungs, VSYNC_BUDGET.fps60),
      at30: interpolateCapacity(rungs, VSYNC_BUDGET.fps30),
    };
  }
}

const out = {
  schemaVersion: 2,
  batchId,
  generatedAt: new Date().toISOString(),
  runConfig: {
    ...RUN_CONFIG,
    fpsCap: requestedFpsCap,
    headless: HEADLESS,
  },
  provenance: runProvenance,
  benchmarkSpec: {
    cases: CASES,
    defaults: DEFAULTS,
    domains: DOMAINS,
    domainOrder: DOMAIN_ORDER,
    contract: CONTRACT,
    vsyncBudget: VSYNC_BUDGET,
  },
  env,
  crossEngineGate: crossReasons,
  crossEngineWarnings: crossWarnings,
  capacities,
  records,
};
const serialized = JSON.stringify(out, null, 2);
await writeFile(join(outDir, 'raw-results.json'), serialized);
if (referencePath) await writeFile(referencePath, serialized);

// ---------- Summary ----------
console.log(`\n===== Summary =====`);
const invalid = records.filter(r => !r.valid);
const limited = records.filter(r => r.engineLimit);
console.log(`Valid ${records.length - invalid.length}/${records.length}`);
if (limited.length) {
  console.log(`\nEngine limits:`);
  for (const r of limited) {
    console.log(`  ${r.pointId} ${r.engine}: ${r.engineLimit}`);
    console.log(`      ${r.engineLimitDetail.replace(/\n+/g, ' ').trim()}`);
  }
}
const plainInvalid = invalid.filter(r => !r.engineLimit);
if (plainInvalid.length) {
  console.log(`\nInvalid runs:`);
  for (const r of plainInvalid) console.log(`  ${r.pointId} ${r.engine} r${r.repeat}: ${r.gateReasons.join('; ')}`);
}
if (Object.keys(crossReasons).length) {
  console.log(`\nCross-engine input mismatches:`);
  for (const [id, rs] of Object.entries(crossReasons)) console.log(`  ${id}: ${rs.join('; ')}`);
} else {
  console.log(`Cross-engine input parity: passed`);
}
if (Object.keys(crossWarnings).length) {
  console.log(`\nSubmitted-work differences caused by default engine policies:`);
  for (const [id, ws] of Object.entries(crossWarnings)) {
    for (const w of ws) console.log(`  ${id}: ${w}`);
  }
}
let lastDomain = null;
for (const [caseId, byEngine] of Object.entries(capacities)) {
  const dom = CASES[caseId].domain;
  if (dom !== lastDomain) { console.log(`\n===== ${DOMAINS[dom].title} =====`); lastDomain = dom; }
  console.log(`\n--- ${caseId} (${CASES[caseId].axis}) ---`);
  for (const [eng, d] of Object.entries(byEngine)) {
    const rungStr = d.rungs.map(r => `${r.value}:${r.p95 == null ? (r.engineLimit ? 'LIMIT' : 'x') : r.p95.toFixed(1)}`).join('  ');
    console.log(`  ${eng.padEnd(11)} ${rungStr}`);
    console.log(`  ${''.padEnd(11)} capacity@60=${d.at60.capacity ?? '-'}(${d.at60.status}) capacity@30=${d.at30.capacity ?? '-'}(${d.at30.status})`);
  }
}
console.log(`\n[collect] wrote results/${batchId}/raw-results.json`);
if (referencePath) console.log(`[collect] wrote reference evidence/${referencePath.split('/').pop()}`);
execFileSync(process.execPath, [join(ROOT, 'runner', 'report.mjs'), batchId], { stdio: 'inherit' });
