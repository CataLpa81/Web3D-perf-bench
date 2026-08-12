# Default-Behavior Performance: three.js, Babylon.js, and PlayCanvas

Engine versions: three.js 0.185.1, Babylon.js 9.20.0, PlayCanvas 2.21.3  
Environment: Apple M5 Pro, Headless Chrome 151, ANGLE Metal, 1280x720, DPR 1, vsync disabled,
300 FPS ceiling  
Regular sampling: 3 seconds per point, one repeat, at least 90 steady-state samples
Visibility, raycast, and shadow attribution sampling: 6 seconds per point, five repeats

> Main comparisons preserve engine defaults and align scene inputs rather than final images.
> Shader modifications mentioned below were attribution experiments only.

## Conclusion

**three.js delivered the strongest overall result. It was fastest or close to fastest in baseline
overhead, high draw-call workloads, skeletal animation, and the tested physics stack. Its clear
weakness was a large number of dynamic lights. PlayCanvas scaled better there through clustered
lighting and had the lowest visibility-culling overhead. three.js had the fastest AABB ray
implementation. PlayCanvas also has a cheaper default PBR fragment shader, but it provides a
simpler feature and quality path, so that difference is a material-design tradeoff rather than a
three.js performance weakness. Babylon.js showed higher per-mesh, animation, and active-mesh
evaluation overhead.**

## Key Data

The table uses p95 frame time at the highest valid point shown. Lower is better.

| Scenario | three.js | Babylon.js | PlayCanvas | Result |
|---|---:|---:|---:|---|
| Empty scene | **5.1ms** | **5.1ms** | 5.3ms | Effectively tied |
| 64 dynamic point lights | 160.6ms | **6.8ms*** | 16.6ms | three.js scales poorly |
| 10,000 draw calls | **12.1ms** | 26.3ms | 12.5ms | three.js and PlayCanvas lead |
| 20,000 visibility objects | 8.2ms | 15.3ms | **7.8ms** | PlayCanvas leads |
| 128 rays across 5,000 AABBs | **9.2ms** | 10.6ms | 20.7ms | three.js leads |
| 1,200 skinned characters | **18.5ms** | 32.6ms | 26.8ms | three.js leads |
| 5,000 dynamic bodies | **13.5ms** | 15.3ms | 34.7ms | three.js + Rapier leads |

\* Babylon.js defaults to `maxSimultaneousLights=4`, so all 64 lights do not affect one material.

For the PBR fragment-cost attribution test, default PBR cost relative to a shared four-texture
shader was **3.64x** in three.js and **2.15x** in PlayCanvas. This describes different default
material complexity. It does not establish that PlayCanvas is faster at equal features and output.

---

# Detailed Results

Unless stated otherwise, tables show p95 frame time in milliseconds.

## 1. Empty Scene

| Engine | p50 | p95 | p99 | Average FPS |
|---|---:|---:|---:|---:|
| three.js | 4.6 | **5.1** | 5.4 | 216.8 |
| Babylon.js | 4.6 | **5.1** | 5.5 | 215.2 |
| PlayCanvas | 4.7 | 5.3 | 5.6 | 209.6 |

The engines were effectively tied. The roughly 5ms floor includes browser timer and scheduling cost.

## 2. Dynamic Point Lights

The scene contains 300 meshes and about 1.215 million submitted triangles.

| Lights | three.js | Babylon.js | PlayCanvas |
|---:|---:|---:|---:|
| 4 | **5.7** | 6.6 | 5.9 |
| 16 | **5.7** | 6.6 | 6.1 |
| 32 | 16.6 | 6.5 | **6.1** |
| 64 | 160.6 | **6.8** | 16.6 |

### Cause

- **three.js** uses forward per-light shading. Light count enters the shader program definition,
  and the fragment shader processes every active light.
- **Babylon.js** defaults to `maxSimultaneousLights=4`, limiting how many lights affect one material.
  Its flat result does not mean that all 64 lights were evaluated.
- **PlayCanvas** uses clustered lighting, so fragments only process lights affecting their cluster.

Large dynamic-light counts are the clearest three.js weakness in this benchmark. At 4 to 16 lights,
three.js remained competitive.

## 3. Draw Calls

Total geometry stays near 1.2 million triangles while independent mesh count increases.

| Draw calls | three.js | Babylon.js | PlayCanvas |
|---:|---:|---:|---:|
| 500 | **6.0** | 6.5 | 6.1 |
| 2,000 | 6.7 | 9.0 | **6.5** |
| 5,000 | 8.5 | 15.7 | **8.2** |
| 10,000 | **12.1** | 26.3 | 12.5 |

three.js and PlayCanvas stayed close. At 10,000 draw calls both remained within a 60 FPS frame
budget. CPU profiling attributed about 37.6% of Babylon.js CPU time to per-SubMesh material checks,
light binding, and uniform preparation.

## 4. Visibility Culling

At 20,000 objects with 10% visible, p95 was 8.2ms in three.js, 15.3ms in Babylon.js, and 7.8ms in
PlayCanvas. All engines submitted the same 2,000 visible draws. PlayCanvas scans a compact
mesh-instance list; three.js recursively traverses its object tree; Babylon.js evaluates readiness,
enabled state, LOD, activation, bounds, submeshes, and materials for each candidate.

Changing Babylon.js to sphere-only culling produced 15.1ms, while `freezeActiveMeshes()` reduced
p95 from 15.2ms to 7.8ms. Its primary cost is active-mesh evaluation rather than the final frustum
intersection test.

## 5. AABB Raycast

At 128 rays across 5,000 AABBs per frame, p95 was 9.2ms in three.js, 10.6ms in Babylon.js, and
20.7ms in PlayCanvas. The ranking comes from the math APIs: three.js and Babylon.js use scalar slab
algorithms, while PlayCanvas uses a separating-axis path with more vector operations.

A V8 control measured 3.30ms, 5.66ms, and 15.44ms respectively, confirming the same ordering. This
result applies to linear AABB tests, not scene BVHs or physics-world raycasts.

## 6. Dynamic Shadow Instance Updates

The high-pressure single-map case uses 20,000 moving instances, 560 triangles per instance,
22.4 million submitted triangles, three draw calls, and a full 1.28MB instance-matrix upload per
frame.

A renderer-independent control generated the same 20,000 matrices in 0.71ms for three.js, 0.98ms
for Babylon.js, and 1.49ms for PlayCanvas.

three.js uses a specialized axis-angle path, Babylon.js additionally normalizes the rotation axis,
and PlayCanvas uses a general Euler-to-quaternion path. Disabling animation removes matrix
generation and the full instance-buffer upload while draw calls remain unchanged, confirming that
these operations are a material part of the high-caster frame cost.

## 7. Skeletal Animation

All engines load the same CesiumMan GLB: 19 bones, 4,672 triangles, and 57 animation channels.
Character phases are offset by index.

| Characters | three.js | Babylon.js | PlayCanvas |
|---:|---:|---:|---:|
| 100 | **6.4** | 7.2 | 7.3 |
| 300 | **8.2** | 13.0 | 10.2 |
| 600 | **11.8** | 19.8 | 15.9 |
| 1,200 | **18.5** | 32.6 | 26.8 |

Submitted draw calls and triangles differed by less than 0.7%.

| Engine | Default animation update path |
|---|---|
| three.js | Flat typed arrays and direct functional interpolation |
| Babylon.js | One `RuntimeAnimation` per channel with object calls and setter write-back |
| PlayCanvas | Bones are full entities that propagate dirty state, hierarchy, and bounds updates |

A separate static-character control produced:

| Metric at 1,200 characters | three.js | Babylon.js | PlayCanvas |
|---|---:|---:|---:|
| Playing animation | 13.5 | 27.1 | 21.8 |
| Same models, static | 9.6 | 9.7 | 7.7 |
| Animation-only delta | **3.9** | 17.4 | 14.1 |

Both tests indicate that the default three.js animation update path is substantially lighter.

## 8. Default PBR Fragment Cost

The scene uses 128 independently moving full-screen transparent layers, fixed `alpha=0.1`, disabled
depth writes, the same albedo/normal/roughness/metalness maps, one directional light, one instanced
draw call, and 100% geometric coverage.

Because asynchronous WebGL submission makes cross-page absolute timing sensitive to queue depth and
GPU frequency, attribution used paired materials alternating inside the same WebGL context.

| Engine | Default PBR / shared four-texture shader |
|---|---:|
| three.js | 3.64x |
| PlayCanvas | 2.15x |

The ratio shows that three.js performs more material work beyond the same four texture reads.

### Cause

PlayCanvas defaults to a cheaper normalized Blinn-Phong specular path with Schlick Fresnel.
three.js includes multiscatter GGX, DFG LUT reads, energy compensation, geometric-roughness
derivatives, and more accurate sRGB output.

Switching only PlayCanvas specular from its default model to GGX increased mean GPU time from
8.18ms to 8.61ms, about 5.2%. The difference therefore comes from the complete shader path rather
than the BRDF name alone.

Paired three.js ablations produced:

| three.js attribution change | Mean GPU-time change |
|---|---:|
| Remove direct multiscattering and two DFG LUT reads | -12.0% |
| Also replace direct lighting with Blinn-Phong | -15.0% cumulative |
| Disable geometric-roughness derivatives only | -8.9% |
| Use simplified gamma output | About -5% |
| Combine all changes | **-32.7%**; p95 -35.8% |

PlayCanvas has a cheaper default material because it implements fewer and simpler PBR operations.
three.js spends more on multiscattering, energy compensation, geometric roughness, and color
processing. This section explains default-material differences and does not rank equal-quality
performance. Babylon.js did not produce a stable paired attribution sample.

## 9. Physics Stack

The compared stacks are three.js + Rapier, Babylon.js + Havok, and PlayCanvas + Ammo. Initial
positions, sizes, masses, velocities, gravity, ground, and fixed 1/60 stepping are aligned.

| Bodies | three.js + Rapier | Babylon.js + Havok | PlayCanvas + Ammo |
|---:|---:|---:|---:|
| 500 | 8.5 | **8.3** | 9.0 |
| 2,000 | 10.9 | **10.7** | 13.7 |
| 5,000 | **13.5** | 15.3 | 34.7 |
| 10,000 | **29.4** | Insufficient samples; observed 49.5 | Insufficient samples; observed 257.5 |

The 500, 2,000, and 5,000-body points each executed about 180 physics substeps.

This is a complete-stack comparison, not an isolated physics-library test. At 5,000 bodies,
three.js and Babylon.js submitted two draw calls while PlayCanvas submitted 1,462 and culled more
objects. Rendering and physics integration both contribute to the result.

---

# Additional Findings

## Runtime Light Changes Can Recompile Shaders

| Operation | three.js | Babylon.js | PlayCanvas |
|---|---|---|---|
| Add one point light | One additional program compile/link observed | One while active-light count changes | No clustered point-light recompile observed |
| Add five more | Additional recompiles observed | Stops after the default four-light limit | No clustered point-light recompile observed |

three.js includes light count in its program cache key. Changing total runtime light count can cause
shader compilation stalls. A light pool is preferable when frame consistency matters.

## three.js Also Has a High-Light Shader Limit

An upper-bound experiment with 256 point lights produced:

```text
FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)
```

The exact limit depends on device and material, but unrestricted real-time light counts do not fit
the default forward-light path.

## Startup and Memory

| Metric | three.js | Babylon.js | PlayCanvas |
|---|---:|---:|---:|
| Startup with 300 objects | **41ms** | 1,138ms* | 95ms |
| Empty-scene JS heap | **11MB** | 32MB | 18MB |
| 10,000-object JS heap | **38MB** | 190MB | 73MB |
| Estimated per-object delta | **2.6KB** | 15.9KB | 4.9KB |

\* The Babylon.js startup sample includes waiting for asynchronous shader compilation and should not
be interpreted as a fixed startup cost for every Babylon.js application.

## Implementation Notes

| Topic | Finding |
|---|---|
| PlayCanvas render loop | `app.start()` schedules its own rAF; an external loop must avoid double rendering |
| Babylon.js shaders | Compilation is asynchronous; wait for `scene.whenReadyAsync()` |
| Babylon.js winding | Shared geometry must reverse winding in right-handed mode |
| PlayCanvas + Ammo | The WASM build must export `addFunction`, followed by `onLibraryLoaded()` |
| Static animation controls | Babylon.js and PlayCanvas animations are engine-driven and must be stopped explicitly |

---

# Limitations

1. Most points used a three-second window and one repeat. Final selection should use longer,
   repeated runs on target devices.
2. The 300 FPS value is a ceiling, not a guaranteed rate. Timer overhead hides very small
   differences in light workloads.
3. The physics case compares complete stacks and cannot rank renderers or physics libraries alone.
4. Scene input is aligned, but final images are not. Default light limits and culling change the
   actual visual work.
5. The 10,000-body Babylon.js and PlayCanvas points had insufficient samples and are not ranked.
6. PBR fragment attribution uses same-context normalized ratios. Cross-page absolute GPU timing is
   affected by command queues and dynamic GPU frequency.
7. Absolute values apply only to the listed hardware, browser, and engine versions.
