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

// Shared 24-vertex box with per-face normals.
export function buildBox(flipWinding = false) {
  const positions = new Float32Array([
    // +X
    0.5,-0.5,-0.5, 0.5,-0.5,0.5, 0.5,0.5,-0.5, 0.5,0.5,0.5,
    // -X
    -0.5,-0.5,0.5, -0.5,-0.5,-0.5, -0.5,0.5,0.5, -0.5,0.5,-0.5,
    // +Y
    -0.5,0.5,-0.5, 0.5,0.5,-0.5, -0.5,0.5,0.5, 0.5,0.5,0.5,
    // -Y
    -0.5,-0.5,0.5, 0.5,-0.5,0.5, -0.5,-0.5,-0.5, 0.5,-0.5,-0.5,
    // +Z
    0.5,-0.5,0.5, -0.5,-0.5,0.5, 0.5,0.5,0.5, -0.5,0.5,0.5,
    // -Z
    -0.5,-0.5,-0.5, 0.5,-0.5,-0.5, -0.5,0.5,-0.5, 0.5,0.5,-0.5,
  ]);
  const normals = new Float32Array([
    1,0,0, 1,0,0, 1,0,0, 1,0,0,
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,
    0,1,0, 0,1,0, 0,1,0, 0,1,0,
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
    0,0,1, 0,0,1, 0,0,1, 0,0,1,
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
  ]);
  const uvs = new Float32Array([
    0,0, 1,0, 0,1, 1,1, 0,0, 1,0, 0,1, 1,1,
    0,0, 1,0, 0,1, 1,1, 0,0, 1,0, 0,1, 1,1,
    0,0, 1,0, 0,1, 1,1, 0,0, 1,0, 0,1, 1,1,
  ]);
  const base = [
    0,2,1, 2,3,1, 4,6,5, 6,7,5, 8,10,9, 10,11,9,
    12,14,13, 14,15,13, 16,18,17, 18,19,17, 20,22,21, 22,23,21,
  ];
  const indices = new Uint32Array(base);
  if (flipWinding) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t;
    }
  }
  return { positions, normals, uvs, indices, vertexCount: 24, indexCount: 36, triangleCount: 12 };
}

// Shared UV sphere used by the shadow benchmark. At 20x15 segments this
// produces 560 triangles per instance without increasing draw-call count.
export function buildUvSphere(widthSegments = 20, heightSegments = 15, flipWinding = false) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const grid = [];

  for (let y = 0; y <= heightSegments; y++) {
    const row = [];
    const v = y / heightSegments;
    const phi = v * Math.PI;
    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;
      const px = -Math.cos(theta) * Math.sin(phi);
      const py = Math.cos(phi);
      const pz = Math.sin(theta) * Math.sin(phi);
      row.push(positions.length / 3);
      positions.push(px, py, pz);
      normals.push(px, py, pz);
      uvs.push(u, 1 - v);
    }
    grid.push(row);
  }

  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = grid[y][x + 1];
      const b = grid[y][x];
      const c = grid[y + 1][x];
      const d = grid[y + 1][x + 1];
      if (y !== 0) indices.push(a, b, d);
      if (y !== heightSegments - 1) indices.push(b, c, d);
    }
  }

  if (flipWinding) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    widthSegments,
    heightSegments,
  };
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

export function buildShadowLayout(count, opts = {}) {
  const items = buildObjectLayout(count, {
    seed: opts.seed ?? 0x51ad,
    fieldRadius: opts.fieldRadius ?? 18,
    scale: opts.scale ?? 0.8,
  });
  for (const item of items) item.y = 0.8 + (item.i % 7) * 0.9;
  return { items, count, groundSize: 52 };
}

export function buildShadowLightLayout(count, opts = {}) {
  const radius = opts.radius ?? 18;
  const height = opts.height ?? 32;
  const targetHeight = opts.targetHeight ?? 3;
  const lights = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = height;
    const z = Math.sin(angle) * radius;
    const dx = -x;
    const dy = targetHeight - y;
    const dz = -z;
    const len = Math.hypot(dx, dy, dz);
    lights.push({
      i, x, y, z,
      tx: 0, ty: targetHeight, tz: 0,
      dx: dx / len, dy: dy / len, dz: dz / len,
    });
  }
  return lights;
}

function numericSignature(rows) {
  let hash = 2166136261;
  for (const row of rows) {
    for (const value of row) {
      hash ^= Math.round(value * 1e6);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function shadowCasterLayoutSignature(layout) {
  return numericSignature(layout.items.map(item => [
    item.i, item.x, item.y, item.z, item.rotationY, item.scale, item.phase,
  ]));
}

export function shadowLightLayoutSignature(lights) {
  return numericSignature(lights.map(light => [
    light.i, light.x, light.y, light.z,
    light.tx, light.ty, light.tz,
    light.dx, light.dy, light.dz,
  ]));
}

// Keep a deterministic fraction in view while the remainder stays far outside the fixed frustum.
export function buildVisibilityLayout(count, visibleFraction = 0.1) {
  const visibleCount = Math.max(1, Math.round(count * visibleFraction));
  const items = [];
  const addVolume = (n, visible, centerX) => {
    const side = Math.ceil(Math.cbrt(n));
    const spacing = visible ? 1.45 : 1.1;
    for (let i = 0; i < n; i++) {
      const x = i % side;
      const z = Math.floor(i / side) % side;
      const y = Math.floor(i / (side * side));
      items.push({
        i: items.length,
        x: centerX + (x - (side - 1) / 2) * spacing,
        y: 0.5 + y * spacing,
        z: (z - (side - 1) / 2) * spacing,
        rotationY: 0,
        scale: visible ? 0.8 : 0.6,
        visible,
      });
    }
  };
  addVolume(visibleCount, true, 0);
  addVolume(count - visibleCount, false, 260);
  return { items, count, visibleCount, hiddenCount: count - visibleCount, visibleFraction };
}

// Rays descend through unique grid cells, producing one AABB hit per query.
export function buildRaycastLayout(targetCount, rayCount) {
  const side = Math.ceil(Math.sqrt(targetCount));
  const spacing = 1.5;
  const targets = [];
  for (let i = 0; i < targetCount; i++) {
    targets.push({
      i,
      x: (i % side - (side - 1) / 2) * spacing,
      y: 0.5,
      z: (Math.floor(i / side) - (side - 1) / 2) * spacing,
      hx: 0.4, hy: 0.5, hz: 0.4,
    });
  }
  const rays = [];
  for (let i = 0; i < rayCount; i++) {
    const targetIndex = Math.min(targetCount - 1, Math.floor((i + 0.5) * targetCount / rayCount));
    const t = targets[targetIndex];
    rays.push({ i, targetIndex, ox: t.x, oy: 10, oz: t.z, dx: 0, dy: -1, dz: 0 });
  }
  return { targets, rays, targetCount, rayCount, expectedHits: rayCount };
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
