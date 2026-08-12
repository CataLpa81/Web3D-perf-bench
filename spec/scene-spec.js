// Shared geometry and deterministic layouts for parity validation.
import { mulberry32 } from './contract.js';

// A segmented grid controls triangles per mesh. Babylon right-handed mode reverses winding.
export function buildGrid(seg, flipWinding = false) {
  const vw = seg + 1;
  const positions = new Float32Array(vw * vw * 3);
  const normals = new Float32Array(vw * vw * 3);
  const uvs = new Float32Array(vw * vw * 2);
  const indices = new Uint32Array(seg * seg * 6);
  let p = 0;
  for (let y = 0; y < vw; y++) {
    for (let x = 0; x < vw; x++, p++) {
      const fx = x / seg, fy = y / seg;
      positions[p * 3 + 0] = (fx - 0.5) * 2;
      positions[p * 3 + 1] = Math.sin(x * 0.6) * Math.cos(y * 0.6) * 0.25;
      positions[p * 3 + 2] = (fy - 0.5) * 2;
      normals[p * 3 + 0] = 0; normals[p * 3 + 1] = 1; normals[p * 3 + 2] = 0;
      uvs[p * 2 + 0] = fx; uvs[p * 2 + 1] = fy;
    }
  }
  let k = 0;
  for (let y = 0; y < seg; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * vw + x, b = a + 1, c = a + vw, d = c + 1;
      if (flipWinding) {
        indices[k++] = b; indices[k++] = c; indices[k++] = a;
        indices[k++] = d; indices[k++] = c; indices[k++] = b;
      } else {
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }
  }
  return {
    seg, positions, normals, uvs, indices,
    vertexCount: vw * vw,
    indexCount: seg * seg * 6,
    triangleCount: seg * seg * 2,
  };
}

// Shared two-triangle quad for the PBR pixel test.
export function buildQuad(flipWinding = false) {
  const positions = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  const indices = flipWinding
    ? new Uint32Array([2, 1, 0, 3, 1, 2])
    : new Uint32Array([0, 1, 2, 2, 1, 3]);
  return { positions, normals, uvs, indices, vertexCount: 4, indexCount: 6, triangleCount: 2 };
}

// Resolve grid segmentation from target total triangles and mesh count.
export function segForTriangles(totalTris, meshCount) {
  const perMesh = totalTris / meshCount;
  const seg = Math.max(1, Math.round(Math.sqrt(perMesh / 2)));
  return seg;
}

// The same count and seed produce identical transforms.
export function buildObjectLayout(count, opts = {}) {
  const seed = opts.seed ?? 0x9e37;
  const fieldRadius = opts.fieldRadius ?? 24;
  const scale = opts.scale ?? 2.0;
  const rnd = mulberry32(seed);
  const items = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * fieldRadius;
    items.push({
      i,
      x: Math.cos(a) * r,
      y: 0.5 + rnd() * 3,
      z: Math.sin(a) * r,
      rotationY: rnd() * Math.PI * 2,
      scale: scale * (0.7 + rnd() * 0.6),
      phase: rnd() * Math.PI * 2,
    });
  }
  return items;
}

export function buildLightLayout(count, opts = {}) {
  const rnd = mulberry32(opts.seed ?? 0x1337);
  const fieldRadius = opts.fieldRadius ?? 24;
  const lights = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const orbit = 6 + rnd() * fieldRadius;
    lights.push({
      i,
      x: Math.cos(a) * orbit,
      y: 3 + rnd() * 9,
      z: Math.sin(a) * orbit,
      orbit,
      phase: rnd() * Math.PI * 2,
      r: 0.6 + rnd() * 0.4,
      g: 0.6 + rnd() * 0.4,
      b: 0.6 + rnd() * 0.4,
      intensity: 1.0,
      range: 18,
    });
  }
  return lights;
}

// ambientCG Metal063, CC0, resized to 512x512.
export const OVERDRAW_PBR_TEXTURES = {
  albedo: '/assets/pbr/albedo.jpg',
  normal: '/assets/pbr/normal.jpg',
  roughness: '/assets/pbr/roughness.jpg',
  metalness: '/assets/pbr/metalness.jpg',
};
export const OVERDRAW_ALPHA = 0.1;

// Each transparent layer follows an independent deterministic path while remaining full-screen.
export function buildOverdrawLayout(layers, opts = {}) {
  const fovDeg = opts.fovDeg ?? 60;
  const aspect = opts.aspect ?? (1280 / 720);
  const near = opts.near ?? 2;
  const gap = opts.gap ?? 0.01;
  const rnd = mulberry32(opts.seed ?? 0x0d3a);
  const items = [];
  for (let i = 0; i < layers; i++) {
    const distance = near + i * gap;
    const h = 2 * distance * Math.tan((fovDeg * Math.PI / 180) / 2);
    const w = h * aspect;
    // A 1.4x quad remains full-screen across the full motion range.
    const angle = rnd() * Math.PI * 2;
    const offset = Math.sqrt(rnd()) * 0.05;
    items.push({
      i,
      x: Math.cos(angle) * w * offset,
      y: Math.sin(angle) * h * offset,
      z: -distance,
      sideW: w * 1.4, sideH: h * 1.4,
      side: w * 1.4,
      motionAmpX: w * (0.025 + rnd() * 0.055),
      motionAmpY: h * (0.025 + rnd() * 0.055),
      motionSpeedX: 0.00024 + rnd() * 0.00042,
      motionSpeedY: 0.00027 + rnd() * 0.00047,
      motionPhaseX: rnd() * Math.PI * 2,
      motionPhaseY: rnd() * Math.PI * 2,
    });
  }
  // Normal alpha blending requires back-to-front submission.
  items.reverse();
  const maxDistance = near + (layers - 1) * gap;
  return {
    items,
    layers,
    quadCount: layers,
    expectedPixelBlends: layers,
    near, gap, maxDistance,
  };
}

// Layered falling boxes create sustained collision and stacking work.
export function buildPhysicsLayout(count, opts = {}) {
  const rnd = mulberry32(opts.seed ?? 0x9b0d);
  const size = opts.size ?? 0.8;
  const perRow = opts.perRow ?? 10;
  const spacing = size * 1.6;
  // Keep bodies active throughout the sampling window.
  const layerGap = spacing * 3.0;
  const baseHeight = opts.baseHeight ?? 8;
  const items = [];
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / (perRow * perRow));
    const inLayer = i % (perRow * perRow);
    const col = inLayer % perRow;
    const row = Math.floor(inLayer / perRow);
    items.push({
      i,
      x: (col - perRow / 2) * spacing + (rnd() - 0.5) * size * 0.15,
      y: baseHeight + layer * layerGap,
      z: (row - perRow / 2) * spacing + (rnd() - 0.5) * size * 0.15,
      size,
      mass: 1,
      vx: (rnd() - 0.5) * 2.5,
      vz: (rnd() - 0.5) * 2.5,
    });
  }
  return { items, size, count, groundSize: perRow * spacing * 2.2, layerGap, baseHeight };
}
