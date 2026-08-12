If you are working on, or want to build, Web3D-related features, this project will be very helpful to you.

This project benchmarks and compares the performance of three common Web3D engines, helping you fully understand
their strengths and weaknesses from a performance perspective, as well as the common pitfalls.

Whether you are a Web3D developer, a product manager, or someone who wants to vibe code some 3D content, this is
a project you should not miss.

# Web 3D Engine Benchmark

The project provides a reproducible comparison of the default behavior of
[three.js](https://threejs.org/), [Babylon.js](https://www.babylonjs.com/), and
[PlayCanvas](https://playcanvas.com/).

The benchmark uses common game workloads without engine-specific optimization. Scene inputs are aligned, while
each engine keeps its default lighting, material, culling, color, and object-management behavior.

Read the current interpretation of the results in **[CONCLUSION.md](./CONCLUSION.md)**.

## Test Cases

| Case | Workload | Metric |
|---|---|---|
| `empty` | Engine and render-loop baseline | CPU p95 |
| `lights` | 4–64 dynamic point lights | CPU p95 |
| `shadows` | 1,000–20,000 moving 560-triangle instances under one spotlight shadow map; up to 22.4M submitted triangles | Frame and GPU p95 |
| `shadow-maps` | 1–8 independent 2048² shadow maps over 1,000 moving instances; up to 5.04M submitted triangles | Frame and GPU p95 |
| `visibility` | 1,000–20,000 objects with 10% inside the camera frustum | CPU p95 |
| `drawcalls` | 500–10,000 individual meshes | CPU p95 |
| `overdraw-pbr` | 8–128 full-screen transparent PBR layers | GPU p95 |
| `raycast` | 1–128 linear AABB ray queries across 5,000 targets per frame | CPU p95 |
| `skinned` | 100–1,200 animated characters | CPU p95 |
| `physics` | 500–10,000 dynamic rigid bodies | CPU p95 |

## Run a Benchmark

Requirements: Node.js 20+, WebGL 2, and a real GPU on macOS, Linux, or Windows.

```bash
npm ci
npx playwright install chromium

# Short run for inspecting trends
npm run collect:quick
```

The command runs all cases against all three engines and automatically creates:

- `raw-results.json`: environment, records, gates, and capacities
- `screenshots/`: one capture for each engine and test point
- `report.html`: self-contained HTML summary

Files are written to a timestamped directory under `results/`. Open its `report.html` directly in a browser.

```bash
# Regenerate a report when needed
npm run report -- <batchId>
```

Useful filters:

```bash
node runner/collect.mjs --case=lights,drawcalls
node runner/collect.mjs --domain=render
node runner/collect.mjs --engine=three
node runner/collect.mjs --case=empty --headed
node runner/collect.mjs --case=shadows,visibility,raycast --duration=6000 --repeats=5
```

Each point defaults to one 3-second sample and may run longer when a heavy workload needs more samples.
Use `--duration`, `--repeats`, and `--min-frames` for longer repeated batches. Engine order rotates
between repeats to reduce fixed-order bias.

## Manual Inspection

```bash
npm run bench
```

This opens the test bench in Chromium with vsync disabled and a 300 FPS ceiling. Use it to inspect scene
construction and engine behavior; automated collection should be used for recorded results.

## Method

- Canvas: 1280×720, DPR 1, antialiasing enabled.
- Every test point receives a fresh page, WebGL context, and engine instance.
- Seeded layouts and shared geometry make scene inputs verifiable.
- A blocking parity gate rejects software rendering, unequal inputs, blank output, and invalid samples.
- Draw calls and triangles are measured at the WebGL API instead of using engine statistics.
- Shadow caster/light layout signatures, projection inputs, independent map storage, map size, and submitted work are parity-gated.
- Shadow cases use a normalized forward path with one independent hard-shadow 2D map per spotlight; PlayCanvas clustered shadow atlasing is disabled for these cases.
- Culling inputs, ray count, ray target count, and deterministic ray hits are parity-gated.
- The PBR pixel test uses `EXT_disjoint_timer_query_webgl2` and is excluded from capacity rankings because the
  default materials provide different features and output quality.
- Physics compares complete stacks: three.js + Rapier, Babylon.js + Havok, and PlayCanvas + Ammo.

The benchmark matrix is defined in [`spec/cases.js`](./spec/cases.js), and shared constraints are defined in
[`spec/contract.js`](./spec/contract.js).

Run `npm run check` before contributing.

## License

See [`harness/assets/CREDITS.md`](./harness/assets/CREDITS.md) for third-party assets and licenses.
Project code is available under the [MIT License](./LICENSE).
