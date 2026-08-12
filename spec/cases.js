// Benchmark matrix and load ladders.
// Each case declares its domain, variable axis, ladder, fixed parameters, and rationale.
// capacity@60/30 estimates the largest load whose p95 stays inside the frame budget.
export const VSYNC_BUDGET = { fps60: 1000 / 60, fps30: 1000 / 30 };

export const DOMAINS = {
  baseline: {
    title: 'Baseline',
    note: 'Empty scene with only a camera and clear pass.',
  },
  render: {
    title: 'Rendering',
    note: 'Rendering bottlenecks split into lighting, shadows, visibility, draw submission, and PBR pixel cost.',
  },
  interaction: {
    title: 'Interaction',
    note: 'CPU-side scene queries commonly used by selection, weapons, navigation, and gameplay.',
  },
  animation: {
    title: 'Animation',
    note: 'Combined animation sampling, bone-matrix updates, and skinning cost.',
  },
  physics: {
    title: 'Physics',
    note: 'Complete renderer plus recommended third-party physics-library stacks.',
  },
};
export const DOMAIN_ORDER = ['baseline', 'render', 'interaction', 'animation', 'physics'];

// Shared scene defaults. Each case overrides the parameters it controls.
export const DEFAULTS = {
  objects: 0,
  triangles: 0,
  lights: 0,
  coverage: 0,
  shadowCasters: 0,
  shadowLights: 0,
  shadowMapSize: 0,
  visibilityObjects: 0,
  visibleFraction: 0,
  raycasts: 0,
  raycastTargets: 0,
  skinned: 0,
  bodies: 0,
  maxWarmupMs: 0,
  maxDurationMs: 0,
  animate: 1,
};

export const CASES = {
  empty: {
    domain: 'baseline',
    axis: null,
    ladder: [0],
    fixed: { objects: 0, triangles: 0, animate: 0 },
    note: 'Empty scene with only a camera and clear pass.',
  },

  lights: {
    domain: 'render',
    axis: 'lights',
    ladder: [4, 16, 32, 64],
    fixed: { objects: 300, triangles: 1_200_000, animate: 1 },
    note: 'Preserves each default lighting architecture: three.js forward lighting, '
        + 'Babylon.js maxSimultaneousLights=4, and PlayCanvas clustered lighting.',
  },

  shadows: {
    domain: 'render',
    axis: 'shadowCasters',
    ladder: [1000, 2500, 5000, 10000, 20000],
    gpuTiming: true,
    fixed: { objects: 0, triangles: 0, lights: 0, shadowLights: 1, shadowMapSize: 2048, animate: 1 },
    note: 'One instanced draw of 1,000-20,000 moving 560-triangle sphere casters under one aligned hard-shadow spotlight and 2048x2048 map.',
  },

  'shadow-maps': {
    domain: 'render',
    axis: 'shadowLights',
    ladder: [1, 2, 4, 8],
    gpuTiming: true,
    fixed: { objects: 0, triangles: 0, lights: 0, shadowCasters: 1000, shadowMapSize: 2048, animate: 1 },
    note: 'One thousand moving 560-triangle instanced casters under 1-8 aligned hard-shadow spotlights; the 8-map rung submits 5.04 million triangles.',
  },

  visibility: {
    domain: 'render',
    axis: 'visibilityObjects',
    ladder: [1000, 5000, 10000, 20000],
    fixed: { objects: 0, triangles: 0, visibleFraction: 0.1, lights: 1, animate: 0 },
    note: 'Shared box meshes with 10% inside a fixed camera frustum and 90% outside it.',
  },

  drawcalls: {
    domain: 'render',
    axis: 'objects',
    ladder: [500, 2000, 5000, 10000],
    fixed: { triangles: 1_200_000, lights: 1, animate: 1 },
    note: 'Keeps total geometry near 1.2M triangles while increasing independent mesh count.',
  },

  raycast: {
    domain: 'interaction',
    axis: 'raycasts',
    ladder: [1, 8, 32, 128],
    fixed: { objects: 0, triangles: 0, raycastTargets: 5000, lights: 0, animate: 0 },
    note: 'Per-frame linear AABB ray queries using each engine math API; every ray has one deterministic hit.',
  },

  'overdraw-pbr': {
    domain: 'render',
    axis: 'coverage',
    ladder: [8, 32, 64, 128],
    capacity: false,
    gpuTiming: true,
    primaryMetric: 'gpu',
    fixed: { objects: 0, lights: 0, animate: 1 },
    note: 'Full-screen transparent layers with alpha 0.1, deterministic motion, and the same '
        + 'four 512x512 PBR maps. Uses each engine default lit PBR material and GPU p95.',
  },

  skinned: {
    domain: 'animation',
    axis: 'skinned',
    ladder: [100, 300, 600, 1200],
    fixed: { objects: 0, triangles: 0, lights: 1, animate: 1 },
    note: 'CesiumMan: 19 bones, 4,672 triangles, 57 animation channels, and one texture.',
  },

  physics: {
    domain: 'physics',
    axis: 'bodies',
    ladder: [500, 2000, 5000, 10000],
    // Keep sampling inside the active falling and collision phase.
    fixed: { objects: 0, triangles: 0, lights: 1, animate: 1,
             maxWarmupMs: 800, maxDurationMs: 3500 },
    note: 'Falling box stacks using three.js + Rapier, Babylon.js + Havok, and PlayCanvas + Ammo.',
  },
};

// Return case IDs for a domain.
export function casesInDomain(domain) {
  return Object.keys(CASES).filter(k => CASES[k].domain === domain);
}

// Expand cases into runnable points.
export function buildRunPoints(caseIds = null, domains = null) {
  let ids = caseIds && caseIds.length ? caseIds : Object.keys(CASES);
  if (domains && domains.length) {
    const set = new Set(domains);
    for (const d of set) if (!DOMAINS[d]) throw new Error(`unknown domain: ${d}`);
    ids = ids.filter(k => set.has(CASES[k]?.domain));
  }
  const points = [];
  for (const caseId of ids) {
    const c = CASES[caseId];
    if (!c) throw new Error(`unknown case: ${caseId}`);
    for (const value of c.ladder) {
      const params = { ...DEFAULTS, ...c.fixed };
      if (c.axis) params[c.axis] = value;
      points.push({
        caseId,
        domain: c.domain,
        axis: c.axis,
        value,
        id: c.axis ? `${caseId}@${value}` : caseId,
        params,
      });
    }
  }
  return points;
}

// Interpolate the load where p95 reaches the budget on a log(value) axis.
export function interpolateCapacity(rungs, budgetMs) {
  const pts = rungs
    .filter(r => Number.isFinite(r.value) && Number.isFinite(r.p95) && r.value > 0)
    .sort((a, b) => a.value - b.value);
  if (!pts.length) return { capacity: null, status: 'nodata' };

  const pass = (r) => r.p95 <= budgetMs;
  if (!pass(pts[0])) return { capacity: null, status: 'belowLadder', firstRung: pts[0].value };
  if (pass(pts[pts.length - 1])) return { capacity: pts[pts.length - 1].value, status: 'saturated' };

  // Interpolate between the final passing point and the first failing point.
  for (let i = 0; i < pts.length - 1; i++) {
    if (pass(pts[i]) && !pass(pts[i + 1])) {
      const a = pts[i], b = pts[i + 1];
      const la = Math.log(a.value), lb = Math.log(b.value);
      const t = (budgetMs - a.p95) / (b.p95 - a.p95);
      const clamped = Math.max(0, Math.min(1, t));
      return { capacity: Math.round(Math.exp(la + (lb - la) * clamped)), status: 'interpolated', between: [a.value, b.value] };
    }
  }
  return { capacity: null, status: 'nonmonotonic' };
}
