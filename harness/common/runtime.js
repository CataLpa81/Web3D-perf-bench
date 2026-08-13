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
    steadyWindow: num('steadyWindow', 30),
    steadyWindows: num('steadyWindows', 3),
    steadyTolerance: num('steadyTolerance', 0.05),
    steadyAbsoluteToleranceMs: num('steadyAbsoluteToleranceMs', 0.2),
    minWarmupMs: num('minWarmupMs', 2000),
    maxWarmupMs: num('maxWarmupMs', 0) || 30000,
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

export function detectGpu(context = null) {
  try {
    const c = context ? null : document.createElement('canvas');
    const gl = context || c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, renderer: null, reason: 'no-webgl' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
    const soft = /swiftshader|software|llvmpipe|angle \(google/i.test(String(renderer || ''));
    return {
      ok: !!renderer && !soft,
      renderer,
      vendor,
      software: soft,
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      antialias: gl.getContextAttributes?.().antialias ?? null,
    };
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
export function createGpuTimer(gl, { maxPending = 8 } = {}) {
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
    async waitForPending() {
      if (!supported) return;
      while (pending.length) {
        poll();
        if (!pending.length) break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
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

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function createTimingRecorder() {
  const all = [];
  const steady = [];
  let rejected = 0;

  return {
    push(value, isSteady) {
      if (!(value >= 0 && value < 5000)) {
        rejected++;
        return;
      }
      all.push(value);
      if (isSteady) steady.push(value);
    },
    get steadyFrameCount() { return steady.length; },
    result(steadyAtMs) {
      const use = steady.length >= 30 ? steady : all;
      const sum = use.reduce((a, b) => a + b, 0);
      const mean = use.length ? sum / use.length : null;
      const varr = use.length ? use.reduce((a, b) => a + (b - mean) ** 2, 0) / use.length : null;
      const v60 = 1000 / 60;
      return {
        frameCount: use.length,
        totalFrameCount: all.length,
        steadyFrameCount: steady.length,
        usedSteadyWindow: steady.length >= 30,
        steadyAtMs,
        p50: percentile(use, 50), p95: percentile(use, 95), p99: percentile(use, 99),
        max: use.length ? Math.max(...use) : null,
        mean,
        avgFps: mean ? 1000 / mean : null,
        stddev: varr != null ? Math.sqrt(varr) : null,
        rejectedSamples: rejected,
        framesOver2Vsync: use.filter(f => f > v60 * 2).length / (use.length || 1),
        framesOver4Vsync: use.filter(f => f > v60 * 4).length,
      };
    },
  };
}

function createSteadyDetector(opts) {
  const {
    steadyWindow,
    steadyWindows,
    steadyTolerance,
    steadyAbsoluteToleranceMs,
    minWarmupMs,
    maxWarmupMs,
  } = opts;
  const samples = [];
  const windowP95s = [];
  let elapsedMs = 0;
  let steadyReached = false;
  let converged = false;
  let forced = false;
  let steadyAtMs = null;

  return {
    push(cpuMs, intervalMs) {
      if (steadyReached) return;
      elapsedMs += Math.max(0, intervalMs);
      if (Number.isFinite(cpuMs)) samples.push(cpuMs);
      if (samples.length > 0 && samples.length % steadyWindow === 0) {
        windowP95s.push(percentile(samples.slice(-steadyWindow), 95));
        if (windowP95s.length > steadyWindows) windowP95s.shift();
        if (elapsedMs >= minWarmupMs && windowP95s.length === steadyWindows) {
          const lo = Math.min(...windowP95s);
          const hi = Math.max(...windowP95s);
          if (lo > 0 && (hi - lo) <= Math.max(lo * steadyTolerance, steadyAbsoluteToleranceMs)) {
            steadyReached = true;
            converged = true;
            steadyAtMs = elapsedMs;
          }
        }
      }
      if (!steadyReached && elapsedMs >= maxWarmupMs) {
        steadyReached = true;
        forced = true;
        steadyAtMs = elapsedMs;
      }
    },
    get reached() { return steadyReached; },
    get converged() { return converged; },
    get forced() { return forced; },
    get steadyAtMs() { return steadyAtMs; },
    get elapsedMs() { return elapsedMs; },
    get windowP95s() { return [...windowP95s]; },
  };
}

// Shared update and render loop.
export function runLoop({
  state, info, params, engineTick, gpuTimer = null, onFinish,
}) {
  const intervalRec = createTimingRecorder();
  const cpuRec = createTimingRecorder();
  const steadyDetector = createSteadyDetector(params);
  if (gpuTimer) info.gpuFrame = gpuTimer.result();
  let startT = null, last = null, frames = 0;
  let probeArmed = false, probeCaptured = false;
  // Live manual-bench statistics are separate from recorded steady-state samples.
  const live = [];
  let liveAt = 0;
  window.__LIVE__ = { p95: null, p50: null, fps: null, frames: 0 };

  async function frame(now) {
    if (startT === null) { startT = now; last = now; }
    const t = now - startT;
    const dt = now - last;
    last = now;
    const wasSteady = steadyDetector.reached;

    if (wasSteady && !probeCaptured) {
      if (!probeArmed) { resetProbe(); probeArmed = true; }
      else { info.probe = readProbe(); probeCaptured = true; state.steadyReached = true; }
    }

    let cpuMs;
    try {
      gpuTimer?.begin(wasSteady);
      const cpuStart = performance.now();
      engineTick(t, dt);
      cpuMs = performance.now() - cpuStart;
      gpuTimer?.end();
      await gpuTimer?.waitForPending();
    } catch (e) {
      state.error = String(e && e.message || e);
      state.scenarioCompleted = true;
      return;
    }
    if (frames > 0) {
      steadyDetector.push(cpuMs, dt);
      intervalRec.push(dt, wasSteady);
      cpuRec.push(cpuMs, wasSteady);
      live.push(cpuMs);
      if (live.length > 120) live.shift();
      if (now - liveAt > 500 && live.length > 10) {
        liveAt = now;
        const mean = live.reduce((a, b) => a + b, 0) / live.length;
        window.__LIVE__ = {
          p95: percentile(live, 95),
          p50: percentile(live, 50),
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
    frames++;

    if (frames === 1) {
      state.firstFrameRendered = true;
      state.interactive = true;
      state.scenarioStarted = true;
      info.timings.firstFrameMs = performance.now();
    }

    // Finish after both duration and sample targets, or at the hard ceiling.
    const maxMs = params.maxDurationMs || Math.max(params.durationMs * 4, 120000);
    const enoughCpuSamples = cpuRec.steadyFrameCount >= (params.minSteadyFrames || 0);
    const enoughGpuSamples = !gpuTimer?.supported
      || gpuTimer.sampleCount >= (params.minGpuFrames || 0);
    const enoughSamples = enoughCpuSamples && enoughGpuSamples;
    const hitCeiling = t >= maxMs;
    if ((t >= params.durationMs && enoughSamples) || hitCeiling) {
      info.extendedBeyondDuration = t > params.durationMs * 1.05;
      info.hitDurationCeiling = hitCeiling && !enoughSamples;
      info.actualDurationMs = t;
      info.frame = intervalRec.result(steadyDetector.steadyAtMs);
      info.cpuFrame = cpuRec.result(steadyDetector.steadyAtMs);
      info.steadyConverged = steadyDetector.converged;
      info.steadyForced = steadyDetector.forced;
      info.steadyWindowsP95 = steadyDetector.windowP95s;
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
