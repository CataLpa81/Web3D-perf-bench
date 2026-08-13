# H5 3D Engine Benchmark Conclusions

[简体中文](./CONCLUSION.zh-CN.md)

Engines:

- three.js 0.185.1
- Babylon.js 9.20.0
- PlayCanvas 2.21.3

Environment: Apple M5 Pro, macOS 26.5.2, Headless Chrome 151.0.7922.34,
ANGLE Metal, 1280x720, DPR 1, and a 300 FPS submission cap.

Current raw result:
[`evidence/full-current-2026-08-13.raw-results.json`](./evidence/full-current-2026-08-13.raw-results.json)

Current report:
[`evidence/full-current-2026-08-13.report.html`](./evidence/full-current-2026-08-13.report.html)

## Summary

The matrix does not support a single overall engine winner, but it does show
clear workload-specific differences:

- **three.js** leads the high-draw-call, linear AABB raycast, skeletal animation,
  and tested physics-stack cases.
- **PlayCanvas** has the lowest default visibility-scan cost and competitive
  draw submission. PlayCanvas + Ammo scales poorly at high body counts and
  reaches WASM OOM at 10,000 bodies.
- **Babylon.js** is close to the other engines in GPU shadow workloads, but has
  higher CPU cost for independent meshes, visibility processing, and skeletal
  animation.
- Default-light results primarily describe product policy. three.js processes
  all lights, Babylon.js defaults to four lights per material, and PlayCanvas
  uses clustered lighting.
- Default PBR overdraw results are close, but the shaders differ in features,
  samplers, BRDF behavior, and color processing.

The main measured 60 FPS capacity bounds on this machine are:

| Case | Capacity unit | three.js | Babylon.js | PlayCanvas |
|---|---|---:|---:|---:|
| Visibility objects | objects | **★ 20k+** | **★ 20k+** | **★ 20k+** |
| Draw calls | draws/frame | **★ 10k+** | 5k | **★ 10k+** |
| Rays/frame across 5,000 AABBs | rays/frame | **★ 128+** | **★ 128+** | 32 |
| Skinned characters | characters | **★ 1.2k+** | 600 | 600 |
| Active physics bodies | bodies | **★ 10k+** | 5k | 2k |

`+` means the largest tested rung passed. It is not an estimate of untested load.
In this capacity table, `★` marks the highest verified capacity. Tied maxima
are all marked.

## Interpretation

1. Time columns in detailed performance tables show the median p95 across five
   repeats, in milliseconds. They are not one uniform end-to-end presentation
   frame metric; the exact metric is stated in each column header.
2. CPU cases measure synchronous update, animation/physics work, and render submission.
3. Shadow cases use `max(CPU p95, GPU p95)` and are GPU-limited here.
4. PBR overdraw uses GPU timer p95.
5. Callback interval is diagnostic and is not used as CPU time.
6. A rung is excluded when any configured repeat is invalid.
7. Default-behavior and normalized-workload cases are interpreted separately.
8. Results with CV above 10% or visibly non-monotonic curves do not support
   fine-grained rankings.
9. In detailed performance tables, `**★ value**` marks the lowest valid median p95 in that workload row. Tied
   minima are all marked. It identifies the lowest observed value only; it
   does not imply statistical significance or remove comparability limits in
   default-behavior cases. `Partial` and `OOM` do not qualify.

The result contains 630 runs, of which 625 are valid. Invalid runs are:

- PlayCanvas `lights@64`: 2/5 did not converge;
- Babylon.js `lights-forward@32`: 1/5 did not converge;
- PlayCanvas `physics@10000`: 2/5 reached WASM OOM.

All cross-engine input parity checks pass. All 195 GPU-timed runs have zero
skipped and zero disjoint queries.

---

## 1. Empty Scene

The scene contains only a camera and clear pass, with no draw calls.

| Engine | CPU p95 (ms) |
|---|---:|
| three.js | **★ 0.1** |
| Babylon.js | 0.2 |
| PlayCanvas | 0.2 |

All values are below 0.3ms and close to browser timing resolution. The test
confirms that synchronous empty-scene submission is cheap in all engines, but
the 0.1ms differences are not a meaningful product advantage.

---

## 2. Default Dynamic Lights

The scene is fixed at 300 draws and 1,200,000 triangles. Engine lighting
architecture remains at its default.

| Lights (count) | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 4 | **★ 0.8** | 2.5 | 1.0 |
| 16 | **★ 0.8** | 2.4 | 1.1 |
| 32 | 4.4 | 2.5 | **★ 1.0** |
| 64 | 142.6 | **★ 2.4** | Partial 3/5 |

### Cause

- three.js uses `forward-all-lights`; every point light enters the material path.
- Babylon.js retains `PBRMaterial.maxSimultaneousLights=4`, so higher global
  counts do not represent equivalent per-material lighting work.
- PlayCanvas retains clustered lighting, assigning lights to clusters instead
  of creating a global forward loop of the same length.

three.js at 32 lights ranges from 0.8 to 17.3ms with CV 88%. Its 64-light rung
stabilizes at 128.9-159.4ms. PlayCanvas has two non-converged 64-light runs.
This is evidence of substantial GPU/driver backpressure and runtime-state changes.

The primary metric is CPU submission, not GPU timer duration. The high value
shows severe submission backpressure, but is not pure fragment-shader GPU time.
Because effective lighting work differs, this case does not produce a
cross-engine capacity ranking.

---

## 3. Normalized Forward Lights

The scene remains fixed at 300 draws and 1,200,000 triangles. PlayCanvas
clustered lighting is disabled, and Babylon.js raises its per-material light
limit so every requested point light can affect every material.

| Lights (count) | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 4 | **★ 0.8** | 2.6 | 0.9 |
| 8 | **★ 0.8** | 3.0 | 0.9 |
| 16 | **★ 0.8** | 3.5 | 1.0 |
| 32 | 6.4 | Partial 4/5 | **★ 1.2** |

At 4-16 lights, Babylon.js shows higher and increasing synchronous cost,
consistent with more expensive forward-light/material binding. three.js and
PlayCanvas submission cost remains nearly flat.

The 32-light rung is not suitable for precise ranking:

- three.js ranges from 0.8 to 18.3ms, CV 80%;
- Babylon.js has one invalid repeat and a 2.7-20.2ms range among valid repeats;
- PlayCanvas ranges from 1.1 to 1.2ms.

These are still CPU-submission values, not complete GPU lighting costs. The case
can compare scene update, light binding, and submission backpressure, but it
cannot prove that PlayCanvas renders the 32-light fragment workload in 1.2ms.
A dedicated lighting GPU timer is needed for that conclusion.

---

## 4. One Shadow Map, Increasing Casters

Normalized inputs:

- one 2048x2048 hard shadow map;
- 1,000-20,000 animated 560-triangle spheres;
- hardware instancing;
- exactly three draws;
- aligned map count, projection, layout, and animation.

The table uses the larger CPU/GPU p95.

| Casters (count) | Submitted triangles/frame | three.js CPU/GPU bottleneck p95 (ms) | Babylon.js CPU/GPU bottleneck p95 (ms) | PlayCanvas CPU/GPU bottleneck p95 (ms) |
|---:|---:|---:|---:|---:|
| 1,000 | 1,120,012 | **★ 2.6** | **★ 2.6** | 5.0 |
| 2,500 | 2,800,012 | 4.8 | 4.6 | **★ 3.9** |
| 5,000 | 5,600,012 | 7.0 | 7.4 | **★ 6.3** |
| 10,000 | 11,200,012 | 11.4 | 11.6 | **★ 11.2** |
| 20,000 | 22,400,012 | 20.3 | 18.9 | **★ 18.7** |

At 5,000 casters and above, GPU p95 is close across engines. The 20,000-caster
min-max ranges overlap, so 1-2ms differences do not establish a stable winner.
Shadow depth rasterization, the main pass, and each default material/shadow
shader dominate the result.

At 20,000 casters, median CPU p95 is approximately 2.7ms for three.js, 3.5ms
for Babylon.js, and 5.1ms for PlayCanvas. This part includes rebuilding every
instance matrix and uploading the dynamic buffer:

- three.js uses `Matrix4.compose` and `InstancedMesh.setMatrixAt`;
- Babylon.js uses `Matrix.ComposeToRef` and a thin-instance update;
- PlayCanvas uses `Mat4.setTRS` and uploads the complete array with
  `VertexBuffer.setData`.

Low caster rungs have CV around 30-37%, so fixed GPU cost and clock variation
are larger than engine differences there. The stable 60 FPS bound is 10,000
for three.js and Babylon.js. PlayCanvas is non-monotonic and receives no
capacity value.

---

## 5. Multiple Shadow Maps

The case fixes 1,000 animated casters. Every spotlight adds one independent
2048x2048 shadow pass.

| Maps (count) | Draws/frame | Submitted triangles/frame | three.js CPU/GPU bottleneck p95 (ms) | Babylon.js CPU/GPU bottleneck p95 (ms) | PlayCanvas CPU/GPU bottleneck p95 (ms) |
|---:|---:|---:|---:|---:|---:|
| 1 | 3 | 1,120,012 | **★ 2.6** | **★ 2.6** | 3.1 |
| 2 | 4 | 1,680,012 | **★ 5.4** | **★ 5.4** | 5.7 |
| 4 | 6 | 2,800,012 | 5.2 | 5.1 | **★ 4.6** |
| 8 | 10 | 5,040,012 | 8.0 | 8.5 | **★ 5.2** |

Work should increase with map count because every light rerenders caster depth.
three.js follows that trend most closely, although its two-to-four-map step
still declines slightly. Babylon.js and PlayCanvas are more non-monotonic and
several rungs exceed 10% CV.

All engines remain below the 60 FPS budget at eight maps, but the current
variance does not support claiming that PlayCanvas has a consistently faster
multi-map shadow implementation. Low-load GPU clocks, query timing, default
shadow shaders, and render-target management can dominate these differences.

---

## 6. Visibility and Frustum Culling

Visible objects remain fixed at 100, producing exactly 100 draws and 1,200
submitted triangles. Only out-of-frustum object count increases.

| Total objects (count) | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 1,000 | **★ 0.5** | 1.2 | 0.6 |
| 5,000 | 1.8 | 3.2 | **★ 1.0** |
| 10,000 | 2.8 | 3.8 | **★ 1.7** |
| 20,000 | 3.7 | 7.2 | **★ 2.6** |

With visible submission fixed, the slope mainly reflects scene traversal,
transform/bounds checks, active-object collection, and default frustum culling.
PlayCanvas grows slowest, three.js is second, and Babylon.js reaches 7.2ms at
20,000 objects, about 2.8 times the PlayCanvas value.

The harness uses default `MeshInstance.cull`, `Object3D.frustumCulled`, and
Babylon standard bounding-info culling. The result establishes that Babylon's
default active-mesh/bounds path is more expensive in this scene, but without a
CPU profile it does not identify one internal function as the sole cause.

All engines pass the largest 20,000-object rung at 60 FPS.

---

## 7. Draw Submission

Every rung uses exactly 1,200,000 triangles, one shared geometry resource,
disabled frustum culling, and one independent draw per object.

| Draw calls/frame | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 500 | **★ 1.1** | 2.7 | 1.2 |
| 2,000 | 2.9 | 4.4 | **★ 2.8** |
| 5,000 | 3.3 | 11.8 | **★ 3.2** |
| 10,000 | 8.3 | 22.7 | **★ 6.5** |

Triangle count and geometry sharing are aligned, so the primary differences are
independent mesh/entity bookkeeping, material preparation, state binding, and
WebGL draw submission.

PlayCanvas is lowest at 10,000 draws, at 6.5ms. three.js reaches 8.3ms and is
in the same practical range. Babylon.js reaches 22.7ms and exceeds the 60 FPS
budget. The data demonstrates higher per-mesh/submesh fixed cost in Babylon.js,
but does not assign the complete difference to material checks, active-mesh
evaluation, uniform binding, or any single internal step.

The measured 60 FPS bounds are 10k+ for three.js, 5k for Babylon.js, and 10k+
for PlayCanvas.

---

## 8. Linear AABB Raycast

Every frame linearly scans 5,000 fixed AABBs. Every ray has one deterministic
hit. This is not a BVH, octree, or physics-world raycast.

| Rays/frame | AABB tests/frame | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|---:|
| 1 | 5,000 | **★ 0.2** | 0.3 | 0.8 |
| 8 | 40,000 | **★ 0.9** | 1.4 | 2.9 |
| 32 | 160,000 | **★ 2.8** | 3.0 | 4.3 |
| 128 | 640,000 | **★ 3.2** | 4.9 | 18.0 |

three.js and Babylon.js use slab-style interval tests that update entry/exit
distance per axis and can exit early. PlayCanvas uses its
`_fastIntersectsRay` separating-axis path when no hit point is requested,
including multiple vector operations, absolute values, and a cross product.

The measured costs are consistent with those algorithm paths. At 128 rays,
three.js is 3.2ms, Babylon.js 4.9ms, and PlayCanvas 18.0ms.

The measured 60 FPS bounds are 128+ for three.js, 128+ for Babylon.js, and 32
for PlayCanvas. This applies only to these public linear AABB math APIs.

---

## 9. Default PBR Overdraw

Aligned inputs:

- 8-128 full-screen transparent layers;
- one instanced draw;
- the same quad geometry;
- the same four 512x512 PBR textures;
- alpha 0.1 and disabled depth writes;
- each engine's default lit material.

The table shows GPU p95.

| Layers (count) | three.js GPU p95 (ms) | Babylon.js GPU p95 (ms) | PlayCanvas GPU p95 (ms) |
|---:|---:|---:|---:|
| 8 | 5.3 | **★ 4.5** | 5.8 |
| 32 | **★ 10.1** | 12.5 | **★ 10.1** |
| 64 | 18.1 | **★ 17.8** | 18.0 |
| 128 | 17.4 | **★ 17.1** | 18.7 |

At 64 and 128 layers, results cluster around 17-19ms, and 128 layers do not
continue increasing monotonically. GPU clocking, bandwidth, blending, and
driver scheduling dominate this region; differences below roughly 2ms do not
form a stable shader ranking.

Active samplers also differ:

- three.js: five, including the four material maps and a DFG LUT;
- Babylon.js: five, including an environment BRDF sampler;
- PlayCanvas: seven, including the material maps and clustered-light textures.

Default BRDF, roughness/gloss semantics, environment BRDF, color processing,
and lighting data differ. This case describes default product cost, not
equal-feature or equal-quality shader performance.

---

## 10. Skeletal Animation

All engines load the same CesiumMan asset:

- 19 bones;
- 57 animation channels;
- 4,672 triangles per character;
- one draw per character;
- character culling disabled.

| Characters (count) | Submitted triangles/frame | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|---:|
| 100 | 467,200 | **★ 2.0** | 3.3 | 2.9 |
| 300 | 1,401,600 | **★ 3.5** | 7.6 | 5.3 |
| 600 | 2,803,200 | **★ 7.2** | 14.1 | 10.4 |
| 1,200 | 5,606,400 | **★ 14.9** | 28.5 | 21.8 |

three.js leads every rung, PlayCanvas is in the middle, and Babylon.js has the
highest cost. At 1,200 characters the values are 14.9ms, 21.8ms, and 28.5ms.

Harness update paths are:

- three.js: `SkeletonUtils.clone` and one `AnimationMixer` per character;
- Babylon.js: an independent skeleton and `AnimationGroup` /
  `TargetedAnimation` set per character;
- PlayCanvas: a complete entity hierarchy and `AnimComponent` per character.

The gap expands consistently with character count, indicating differences in
per-character animation sampling, bone/world-matrix propagation, skin-palette
updates, and draw preparation. The benchmark does not include a function-level
profile, so it does not attribute the full gap to one stage.

The measured 60 FPS bounds are 1,200+ for three.js and 600 for both Babylon.js
and PlayCanvas.

---

## 11. Physics Stack

The test compares complete integration stacks:

- three.js + Rapier 0.20.0;
- Babylon.js + Havok 1.3.14;
- PlayCanvas + Ammo.js WASM.

All backends use the same box layout, mass, initial velocity, gravity, ground,
and one fixed 1/60 step per frame. Sleeping is disabled and the final sleeping
body count is zero for every valid run. Rendering is aligned to one instanced
body draw plus one ground draw.

| Bodies (count) | Draws/frame | three.js + Rapier CPU p95 (ms) | Babylon.js + Havok CPU p95 (ms) | PlayCanvas + Ammo CPU p95 (ms) |
|---:|---:|---:|---:|---:|
| 500 | 2 | **★ 2.0** | 2.3 | 3.2 |
| 2,000 | 2 | **★ 2.7** | 4.3 | 11.5 |
| 5,000 | 2 | **★ 6.7** | 10.8 | 31.8 |
| 10,000 | 2 | **★ 14.1** | 22.9 | OOM 2/5 |

three.js + Rapier scales best, Babylon.js + Havok is second, and PlayCanvas +
Ammo slows sharply from 2,000 bodies. PlayCanvas at 5,000 bodies ranges from
22.2 to 38.0ms with CV 20%. At 10,000 bodies, two of five runs reach WASM OOM,
so the rung has no valid aggregate p95.

Each frame includes solver work, position/rotation reads, instance-matrix
construction, complete dynamic-buffer upload, and engine/component transform
synchronization. Rapier, Havok, and Ammo also differ in broadphase, contacts,
solver, memory management, and JS/WASM bindings.

The result therefore ranks the complete stacks listed here. It does not isolate
or rank the bare physics solvers. The measured 60 FPS bounds are 10k+ for
three.js + Rapier, 5k for Babylon.js + Havok, and 2k for PlayCanvas + Ammo.

---

## Reliability Limits

1. Results cover one Apple M5 Pro and Headless Chromium/ANGLE Metal.
2. Android Chrome/WebView, iOS Safari/WKWebView, and Windows are not covered.
3. Light cases do not have GPU timers and are not pure GPU lighting benchmarks.
4. Default lights and default PBR preserve product-policy differences.
5. Shadow-map and several low-load shadow rungs have high CV or non-monotonic curves.
6. Physics measures the engine, physics library, bindings, transform sync, and
   rendering upload as one stack.
7. CPU values below roughly 0.3ms approach browser timing resolution.

An H5 product decision should repeat this matrix on its target Android/iOS
devices, actual WebView/Safari environment, thermal state, and production
material/shader configuration.
