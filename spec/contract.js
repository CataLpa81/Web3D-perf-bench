// Shared scene contract. These values describe scene input and camera placement,
// not engine rendering strategy. Tone mapping, color processing, lighting architecture,
// material behavior, and culling remain engine defaults.
export const CONTRACT = {
  viewport: { w: 1280, h: 720 },
  devicePixelRatio: 1,
  antialias: true,
  frameRateCap: 300,
  camera: {
    fov: 60,
    near: 0.1,
    far: 1000,
  },
  clearColor: { r: 0x05 / 255, g: 0x06 / 255, b: 0x0a / 255, a: 1 },
  // Shared orbit path.
  cameraPath: {
    radius: 34,
    height: 14,
    periodMs: 12000,
    target: { x: 0, y: 4, z: 0 },
  },

  // Pull the physics camera back so the full stack remains visible.
  physicsCamera: { radius: 78, height: 42, target: { x: 0, y: 16, z: 0 } },
  visibilityCamera: { x: 0, y: 18, z: 42, target: { x: 0, y: 5, z: 0 } },

  shadow: {
    near: 1,
    far: 80,
    lightRadius: 18,
    lightHeight: 32,
    targetHeight: 3,
    coneHalfAngleDeg: 55,
    intensity: 25,
    casterWidthSegments: 20,
    casterHeightSegments: 15,
  },

  // Constant directional fill light. The brighter PBR value keeps transparent layers visible.
  baseLight: {
    direction: { x: -0.4, y: -1, z: -0.35 },
    intensity: 1.0,
    shadowFillIntensity: 0.35,
    pbrPixelIntensity: 5.0,
    color: { r: 1, g: 1, b: 1 },
  },

};

// Shared camera pose for elapsed time in milliseconds.
export function cameraAt(tMs, preset) {
  if (preset === 'visibility') {
    const p = CONTRACT.visibilityCamera;
    return { x: p.x, y: p.y, z: p.z, tx: p.target.x, ty: p.target.y, tz: p.target.z };
  }
  const p = preset === 'physics'
    ? { ...CONTRACT.cameraPath, ...CONTRACT.physicsCamera }
    : CONTRACT.cameraPath;
  const ang = (tMs / p.periodMs) * Math.PI * 2;
  return {
    x: Math.cos(ang) * p.radius,
    y: p.height,
    z: Math.sin(ang) * p.radius,
    tx: p.target.x, ty: p.target.y, tz: p.target.z,
  };
}

// Deterministic PRNG shared by all engines and runs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
