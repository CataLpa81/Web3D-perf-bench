// Shared URL parsing, state, timing, convergence, and reporting.
import { CONTRACT } from '../../spec/contract.js';
import { DEFAULTS } from '../../spec/cases.js';
import { resetProbe, readProbe } from './probe.js';

export function readParams(search = location.search) {
  const p = new URLSearchParams(search);
  const num = (k, d) => { const v = p.get(k); return v == null ? d : Number(v); };
  const requestedFpsCap = num('fpsCap', CONTRACT.frameRateCap);
  const params = {};
  for (const k of Object.keys(DEFAULTS)) params[k] = num(k, DEFAULTS[k]);
  return {
    ...params,
    caseId: p.get('case') || 'empty',
    // Khronos CesiumMan sample: 19 bones, 4,672 triangles, 57 channels.
    model: p.get('model') || 'CesiumMan.glb',
    durationMs: num('duration', 8000),
    // Keep a common ceiling after disabling vsync.
    fpsCap: requestedFpsCap > 0
      ? Math.min(requestedFpsCap, CONTRACT.frameRateCap)
      : CONTRACT.frameRateCap,
    // Continue beyond the base duration until the sample target or ceiling is reached.
    minSteadyFrames: num('minSteadyFrames', 0),
    minGpuFrames: num('minGpuFrames', 0),
    maxDurationMs: num('maxDurationMs', 0),
    // Sliding-window convergence replaces a fixed warmup.
    steadyWindow: num('steadyWindow', 60),
    steadyTolerance: num('steadyTolerance', 0.05),
    maxWarmupMs: num('maxWarmupMs', 0) || 8000,
  };
}

// The collector uses these flags to control the run lifecycle.
export function createHarness(framework) {
  const state = {
    framework,
    assetsLoaded: false,
    shaderReady: false,
    firstFrameRendered: false,
    steadyReached: false,
    interactive: false,
    scenarioStarted: false,
    scenarioCompleted: false,
    error: null,
  };
  const info = {
    framework,
    engineVersion: null,
    // Requested and actual scene inputs.
    requested: {},
    actual: {},
    // One-frame WebGL probe.
    probe: null,
    // Environment.
    renderWidth: null, renderHeight: null,
    gpu: null,
    // Engine-reported statistics are diagnostic only.
    engineReported: {},
    // Snapshot of relevant engine defaults.
    defaults: {},
    timings: {},
  };
  window.__HARNESS_STATE__ = state;
  window.__HARNESS_INFO__ = info;
  return { state, info };
}

// Wall-clock accumulator with a fixed physics step and catch-up limit.
export function createFixedStepClock({
  stepSeconds = 1 / 60,
  maxFrameSeconds = 0.25,
  maxStepsPerFrame = 10,
} = {}) {
  let accumulator = 0;
  let totalSteps = 0;
  return {
    advance(dtMs, step) {
      accumulator += Math.min(maxFrameSeconds, Math.max(0, dtMs) / 1000);
      let steps = 0;
      while (accumulator >= stepSeconds && steps < maxStepsPerFrame) {
        step(stepSeconds);
        accumulator -= stepSeconds;
        steps++;
        totalSteps++;
      }
      return steps;
    },
    get totalSteps() { return totalSteps; },
  };
}

// Estimate the ratio of pixels that differ from the clear color.
export function measureFramebufferCoverage(canvas, clearColor) {
  try {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
            || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return null;
    // Read the default framebuffer even if the engine leaves an FBO bound.
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    // Subsample the readback.
    const step = 4;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const br = Math.round((clearColor?.r ?? 0) * 255);
    const bg = Math.round((clearColor?.g ?? 0) * 255);
    const bb = Math.round((clearColor?.b ?? 0) * 255);
    let lit = 0, total = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        total++;
        // Detect a draw, not perceived brightness.
        if (Math.abs(px[i] - br) > 3 || Math.abs(px[i + 1] - bg) > 3 || Math.abs(px[i + 2] - bb) > 3) lit++;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    return total ? lit / total : null;
  } catch (e) {
    return null;
  }
}

export function detectGpu() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, renderer: null, reason: 'no-webgl' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
    const soft = /swiftshader|software|llvmpipe|angle \(google/i.test(String(renderer || ''));
    return { ok: !!renderer && !soft, renderer, vendor, software: soft };
  } catch (e) {
    return { ok: false, renderer: null, reason: String(e) };
  }
}

function summarizeTimings(samples) {
  const pctile = (p) => {
    if (!samples.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    frameCount: samples.length,
    p50: pctile(50),
    p95: pctile(95),
    p99: pctile(99),
    max: samples.length ? Math.max(...samples) : null,
    mean: samples.length ? sum / samples.length : null,
  };
}

// GPU timing for asynchronous WebGL work.
export function createGpuTimer(gl, { maxPending = 64 } = {}) {
  const ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2');
  const supported = !!(ext && gl.createQuery && gl.beginQuery && gl.endQuery);
  const pending = [];
  const samples = [];
  const live = [];
  let active = null;
  let disjointEvents = 0;
  let skippedFrames = 0;

  function discardPending() {
    for (const item of pending) gl.deleteQuery(item.query);
    pending.length = 0;
  }

  function poll() {
    if (!supported) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      disjointEvents++;
      discardPending();
      return;
    }
    while (pending.length) {
      const item = pending[0];
      if (!gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      const ns = gl.getQueryParameter(item.query, gl.QUERY_RESULT);
      gl.deleteQuery(item.query);
      const ms = ns / 1e6;
      if (!(ms >= 0 && Number.isFinite(ms))) continue;
      live.push(ms);
      if (live.length > 120) live.shift();
      if (item.steady) samples.push(ms);
    }
  }

  return {
    supported,
    get sampleCount() {
      poll();
      return samples.length;
    },
    begin(steady = false) {
      if (!supported) return false;
      poll();
      if (active || pending.length >= maxPending) {
        skippedFrames++;
        return false;
      }
      const query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      active = { query, steady };
      return true;
    },
    end() {
      if (!supported || !active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
      poll();
    },
    result() {
      poll();
      return {
        supported,
        ...summarizeTimings(samples),
        disjointEvents,
        skippedFrames,
        pendingQueries: pending.length,
      };
    },
    liveResult() {
      poll();
      return { supported, ...summarizeTimings(live) };
    },
  };
}

export function inspectActiveSamplers(gl) {
  try {
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!program) return [];
    const samplerTypes = new Set([
      gl.SAMPLER_2D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW,
      gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_ARRAY_SHADOW,
      gl.INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D,
    ].filter(Number.isFinite));
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    const names = [];
    for (let i = 0; i < count; i++) {
      const uniform = gl.getActiveUniform(program, i);
      if (uniform && samplerTypes.has(uniform.type)) names.push(uniform.name);
    }
    return names;
  } catch {
    return [];
  }
}

// Frame recording and sliding-window convergence.
function createFrameRecorder(opts) {
  const { steadyWindow, steadyTolerance, maxWarmupMs } = opts;
  const all = [];
  const steady = [];
  let lastWindowP95 = null;
  let steadyReached = false;
  let steadyAtMs = null;
  let elapsed = 0;

  function pctile(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }

  return {
    push(dtMs) {
      // Reject burst callbacks and suspended-page outliers.
      if (!(dtMs >= 0.4 && dtMs < 5000)) return;
      all.push(dtMs);
      elapsed += dtMs;
      if (steadyReached) { steady.push(dtMs); return; }
      // Check convergence after each full window.
      if (all.length % steadyWindow === 0) {
        const w = all.slice(-steadyWindow);
        const p95 = pctile(w, 95);
        if (lastWindowP95 != null) {
          const change = Math.abs(p95 - lastWindowP95) / lastWindowP95;
          if (change < steadyTolerance) {
            steadyReached = true; steadyAtMs = elapsed;
          }
        }
        lastWindowP95 = p95;
      }
      // Force steady state after the warmup ceiling.
      if (!steadyReached && elapsed > maxWarmupMs) { steadyReached = true; steadyAtMs = elapsed; }
    },
    get steadyReached() { return steadyReached; },
    get steadyFrameCount() { return steady.length; },
    get elapsedMs() { return elapsed; },
    result() {
      const use = steady.length >= 30 ? steady : all;
      const sum = use.reduce((a, b) => a + b, 0);
      const mean = use.length ? sum / use.length : null;
      const varr = use.length ? use.reduce((a, b) => a + (b - mean) ** 2, 0) / use.length : null;
      const v60 = 1000 / 60;
      return {
        frameCount: use.length,
        totalFrameCount: all.length,
        usedSteadyWindow: steady.length >= 30,
        steadyAtMs,
        p50: pctile(use, 50), p95: pctile(use, 95), p99: pctile(use, 99),
        max: use.length ? Math.max(...use) : null,
        avgFps: mean ? 1000 / mean : null,
        stddev: varr != null ? Math.sqrt(varr) : null,
        framesOver2Vsync: use.filter(f => f > v60 * 2).length / (use.length || 1),
        framesOver4Vsync: use.filter(f => f > v60 * 4).length,
      };
    },
  };
}

// Shared update and render loop.
export function runLoop({
  state, info, params, engineTick, gpuTimer = null, onFinish,
}) {
  const rec = createFrameRecorder(params);
  if (gpuTimer) info.gpuFrame = gpuTimer.result();
  let startT = null, last = null, frames = 0;
  let probeArmed = false, probeCaptured = false;
  // Live manual-bench statistics are separate from recorded steady-state samples.
  const live = [];
  let liveAt = 0;
  window.__LIVE__ = { p95: null, p50: null, fps: null, frames: 0 };

  function frame(now) {
    if (startT === null) { startT = now; last = now; }
    const t = now - startT;
    const dt = now - last;
    last = now;
    if (frames > 0) {
      rec.push(dt);
      live.push(dt);
      if (live.length > 120) live.shift();
      if (now - liveAt > 500 && live.length > 10) {
        liveAt = now;
        const srt = [...live].sort((a, b) => a - b);
        const mean = live.reduce((a, b) => a + b, 0) / live.length;
        window.__LIVE__ = {
          p95: srt[Math.floor(0.95 * srt.length)],
          p50: srt[Math.floor(0.5 * srt.length)],
          fps: 1000 / mean,
          frames,
        };
        const gpuLive = gpuTimer?.liveResult();
        if (gpuLive?.supported) {
          window.__LIVE__.gpuP50 = gpuLive.p50;
          window.__LIVE__.gpuP95 = gpuLive.p95;
          window.__LIVE__.gpuFrames = gpuLive.frameCount;
        }
      }
    }

    // Capture one clean probe frame after convergence.
    if (rec.steadyReached && !probeCaptured) {
      if (!probeArmed) { resetProbe(); probeArmed = true; }
      else { info.probe = readProbe(); probeCaptured = true; state.steadyReached = true; }
    }

    try {
      gpuTimer?.begin(rec.steadyReached);
      engineTick(t, dt);
      gpuTimer?.end();
    } catch (e) {
      state.error = String(e && e.message || e);
      state.scenarioCompleted = true;
      return;
    }
    frames++;

    if (frames === 1) {
      state.firstFrameRendered = true;
      state.interactive = true;
      state.scenarioStarted = true;
      info.timings.firstFrameMs = performance.now();
    }

    // Finish after both duration and sample targets, or at the hard ceiling.
    const maxMs = params.maxDurationMs || params.durationMs * 4;
    const enoughCpuSamples = rec.steadyFrameCount >= (params.minSteadyFrames || 0);
    const enoughGpuSamples = !gpuTimer?.supported
      || gpuTimer.sampleCount >= (params.minGpuFrames || 0);
    const enoughSamples = enoughCpuSamples && enoughGpuSamples;
    const hitCeiling = t >= maxMs;
    if ((t >= params.durationMs && enoughSamples) || hitCeiling) {
      info.extendedBeyondDuration = t > params.durationMs * 1.05;
      info.hitDurationCeiling = hitCeiling && !enoughSamples;
      info.actualDurationMs = t;
      info.frame = rec.result();
      if (gpuTimer) info.gpuFrame = gpuTimer.result();
      info.timings.endMs = performance.now();
      // Always return a probe result.
      if (!probeCaptured) { resetProbe(); engineTick(t, 0); info.probe = readProbe(); }
      onFinish && onFinish();
      state.scenarioCompleted = true;
      return;
    }
    schedule();
  }

  // Use timers when capped because rAF can remain display-limited despite Chromium flags.
  function schedule() {
    if (!params.fpsCap) { requestAnimationFrame(frame); return; }
    const target = 1000 / params.fpsCap;
    const elapsed = performance.now() - (last ?? performance.now());
    const wait = Math.max(0, target - elapsed);
    setTimeout(() => frame(performance.now()), wait);
  }
  schedule();
}

export { CONTRACT };
