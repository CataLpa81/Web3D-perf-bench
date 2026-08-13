# Web 3D Engine Benchmark

This project provides a reproducible, workload-specific comparison of
[three.js](https://threejs.org/), [Babylon.js](https://www.babylonjs.com/), and
[PlayCanvas](https://playcanvas.com/). Results are evidence for the recorded
hardware/browser configuration, not universal engine rankings.

The benchmark separates two kinds of evidence:

- **Normalized workloads** align submitted work and relevant render settings.
- **Default-behavior workloads** preserve engine defaults and are not used for cross-engine capacity rankings.

Read the benchmark conclusions in **[English](./CONCLUSION.md)** or
**[简体中文](./CONCLUSION.zh-CN.md)**.

## Test Cases

| Case | Workload | Metric |
|---|---|---|
| `empty` | Engine and render-loop baseline | CPU tick p95 |
| `lights` | Default lighting behavior with 4–64 point lights | CPU tick p95; no capacity ranking |
| `lights-forward` | 4–32 lights affecting every material through forward lighting | CPU tick p95 |
| `shadows` | 1,000–20,000 moving 560-triangle instances under one spotlight shadow map | CPU/GPU bottleneck p95 |
| `shadow-maps` | 1–8 independent 2048² shadow maps over 1,000 moving instances | CPU/GPU bottleneck p95 |
| `visibility` | 100 visible objects plus 900–19,900 out-of-frustum objects | CPU tick p95 |
| `drawcalls` | 500–10,000 visible meshes sharing one geometry; exactly 1.2M triangles | CPU tick p95 |
| `overdraw-pbr` | 8–128 full-screen transparent PBR layers | GPU p95 |
| `raycast` | 1–128 linear AABB ray queries across 5,000 targets per frame | CPU p95 |
| `skinned` | 100–1,200 animated characters | CPU p95 |
| `physics` | 500–10,000 bodies, sleeping disabled, one fixed step/frame, aligned instanced rendering | CPU tick p95 |

## Run a Benchmark

Requirements: Node.js 20+, WebGL 2, and a real GPU on macOS, Linux, or Windows.

```bash
npm ci
npx playwright install chromium

# Short, single-repeat run for development only
npm run collect:quick

# Reference-quality defaults: 6 seconds, 5 repeats, 180 steady samples
npm run collect

# Also write a provenance-complete artifact under evidence/
npm run collect:reference
```

Reference collection requires a clean worktree. `--allow-dirty` is intended for diagnostic runs; do not publish
those artifacts as reference evidence.

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

Reference runs default to 6 seconds, five repeats, and at least 180 steady CPU/GPU samples.
Load points are deterministically shuffled for every repeat, and engine order is counterbalanced.
`collect:quick` is intentionally shorter and must not be used for published rankings.

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
- A blocking parity gate rejects software rendering, WebGL 1, backbuffer/AA mismatches, unequal inputs,
  incorrect submitted work, blank output, non-converged or insufficient steady-state samples, and invalid GPU timing.
- Draw calls and triangles are measured at the WebGL API instead of using engine statistics.
- Shadow caster/light layouts, actual projection near plane, allocated map count/size, storage, and submitted work are parity-gated.
- Shadow cases use a normalized forward path with one independent hard-shadow 2D map per spotlight; PlayCanvas clustered shadow atlasing is disabled for these cases.
- Visibility holds rendered draws fixed at 100 while only the culled population changes.
- Draw-call cases use a single shared geometry in every engine and disable frustum culling.
- Physics executes exactly one 1/60 step per rendered frame and uses the same two-draw instanced presentation.
- The PBR pixel test uses `EXT_disjoint_timer_query_webgl2` and is excluded from capacity rankings because the
  default materials provide different features and output quality.
- GPU-timed frames apply asynchronous query backpressure: the next frame is scheduled only after the current
  timer result is available, preventing an unbounded command queue or selective loss of slow GPU samples.
- Physics compares complete stacks: three.js + Rapier, Babylon.js + Havok, and PlayCanvas + Ammo.
- CPU timing measures the synchronous update/render-submission call. Callback interval is diagnostic only.
- Capacity uses CPU p95 for CPU workloads and `max(CPU p95, GPU p95)` for GPU-timed workloads.
- Capacity reports tested bounds only; it never interpolates between sparse rungs.
- Schema-v2 raw results embed the complete case matrix, contract, git commit, lockfile hash, browser flags,
  environment, repeat variance, and run order.

The benchmark matrix is defined in [`spec/cases.js`](./spec/cases.js), and shared constraints are defined in
[`spec/contract.js`](./spec/contract.js).

Run `npm run check` before contributing.

## License

See [`harness/assets/CREDITS.md`](./harness/assets/CREDITS.md) for third-party assets and licenses.
Project code is available under the [MIT License](./LICENSE).
