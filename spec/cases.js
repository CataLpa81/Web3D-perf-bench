// Benchmark matrix and load ladders.
// Each case declares its domain, variable axis, ladder, fixed parameters, and rationale.
// capacity@60/30 reports tested bounds. It does not interpolate between sparse rungs.
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
  visibleCount: 0,
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
    suite: 'default-behavior',
    axis: 'lights',
    ladder: [4, 16, 32, 64],
    capacity: false,
    fixed: { objects: 300, triangles: 1_200_000, animate: 1 },
    note: 'Preserves each default lighting architecture: three.js forward lighting, '
        + 'Babylon.js maxSimultaneousLights=4, and PlayCanvas clustered lighting.',
  },

  'lights-forward': {
    domain: 'render',
    suite: 'normalized-workload',
    axis: 'lights',
    ladder: [4, 8, 16, 32],
    fixed: { objects: 300, triangles: 1_200_000, animate: 1 },
    note: 'All requested point lights affect every material using a non-clustered forward path.',
  },

  shadows: {
    domain: 'render',
    suite: 'normalized-workload',
    axis: 'shadowCasters',
    ladder: [1000, 2500, 5000, 10000, 20000],
    gpuTiming: true,
    primaryMetric: 'bottleneck',
    fixed: { objects: 0, triangles: 0, lights: 0, shadowLights: 1, shadowMapSize: 2048, animate: 1 },
    note: 'One instanced draw of 1,000-20,000 moving 560-triangle sphere casters under one aligned hard-shadow spotlight and 2048x2048 map.',
  },

  'shadow-maps': {
    domain: 'render',
    suite: 'normalized-workload',
    axis: 'shadowLights',
    ladder: [1, 2, 4, 8],
    gpuTiming: true,
    primaryMetric: 'bottleneck',
    fixed: { objects: 0, triangles: 0, lights: 0, shadowCasters: 1000, shadowMapSize: 2048, animate: 1 },
    note: 'One thousand moving 560-triangle instanced casters under 1-8 aligned hard-shadow spotlights; the 8-map rung submits 5.04 million triangles.',
  },

  visibility: {
    domain: 'render',
    axis: 'visibilityObjects',
    ladder: [1000, 5000, 10000, 20000],
    fixed: { objects: 0, triangles: 0, visibleCount: 100, lights: 1, animate: 0 },
    note: 'Keeps 100 visible boxes fixed while increasing only out-of-frustum objects.',
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
    suite: 'default-behavior',
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
    // Sleeping is disabled in every backend so the solver workload cannot decay during sampling.
    fixed: { objects: 0, triangles: 0, lights: 1, animate: 1,
             maxWarmupMs: 30000, maxDurationMs: 120000 },
    note: 'Box stacks with sleeping disabled, one fixed step per frame, and aligned one-draw instanced rendering.',
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

// Return the largest tested passing rung and the adjacent failing bound.
export function interpolateCapacity(rungs, budgetMs) {
  const all = rungs
    .filter(r => Number.isFinite(r.value) && r.value > 0)
    .sort((a, b) => a.value - b.value);
  const pts = [];
  let invalidRung = null;
  for (const rung of all) {
    if (rung.complete === false || !Number.isFinite(rung.p95)) {
      invalidRung = rung;
      break;
    }
    pts.push(rung);
  }
  if (!pts.length) {
    return invalidRung
      ? { capacity: null, status: 'invalid-rung', firstInvalidRung: invalidRung.value }
      : { capacity: null, status: 'nodata' };
  }

  const pass = (r) => r.p95 <= budgetMs;
  if (!pass(pts[0])) return { capacity: null, status: 'belowLadder', firstRung: pts[0].value };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].p95 < pts[i - 1].p95 * 0.95) {
      return { capacity: null, status: 'nonmonotonic' };
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (pass(pts[i]) && !pass(pts[i + 1])) {
      return {
        capacity: pts[i].value,
        status: 'bounded',
        between: [pts[i].value, pts[i + 1].value],
      };
    }
  }
  if (invalidRung) {
    const prior = pts[pts.length - 1];
    return pass(prior)
      ? {
          capacity: prior.value,
          status: 'bounded-invalid',
          between: [prior.value, invalidRung.value],
        }
      : { capacity: null, status: 'invalid-rung', firstInvalidRung: invalidRung.value };
  }
  if (pass(pts[pts.length - 1])) return { capacity: pts[pts.length - 1].value, status: 'saturated' };
  return { capacity: null, status: 'nodata' };
}
