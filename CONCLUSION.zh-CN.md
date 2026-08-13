# H5 3D 引擎性能测试结论

[English](./CONCLUSION.md)

测试对象：

- three.js 0.185.1
- Babylon.js 9.20.0
- PlayCanvas 2.21.3

测试环境：Apple M5 Pro、macOS 26.5.2、Headless Chrome 151.0.7922.34、
ANGLE Metal、1280x720、DPR 1、300 FPS 提交上限。

当前全量原始结果：
[`evidence/full-current-2026-08-13.raw-results.json`](./evidence/full-current-2026-08-13.raw-results.json)

当前报告：
[`evidence/full-current-2026-08-13.report.html`](./evidence/full-current-2026-08-13.report.html)

## 总结

这个测试不能得出单一的“综合最强引擎”，但可以得出清晰的 workload 结论：

- **three.js** 在高 draw call、线性 AABB raycast、骨骼动画和当前物理栈中表现最好。
- **PlayCanvas** 的默认可见性扫描成本最低，高 draw call 也很有竞争力；但
  PlayCanvas + Ammo 在高刚体数量下扩展较慢，10,000 bodies 出现 WASM OOM。
- **Babylon.js** 的 shadow GPU 结果与另外两个引擎接近，但独立 mesh 提交、
  可见性处理和骨骼动画的 CPU 成本更高。
- 默认灯光结果主要反映产品策略：three.js 处理全部灯光，Babylon.js 默认每材质
  最多处理 4 盏灯，PlayCanvas 使用 clustered lighting，不能直接据此排名。
- 默认 PBR overdraw 的 GPU 结果整体接近，但三个默认 shader 的功能、采样器和
  颜色处理不同，只能解释默认材质成本。

在当前设备上的主要 60 FPS 实测容量边界为：

| Case | 容量单位 | three.js | Babylon.js | PlayCanvas |
|---|---|---:|---:|---:|
| Visibility objects | objects | **★ 20k+** | **★ 20k+** | **★ 20k+** |
| Draw calls | draws/frame | **★ 10k+** | 5k | **★ 10k+** |
| Rays/frame，对 5,000 AABB | rays/frame | **★ 128+** | **★ 128+** | 32 |
| Skinned characters | characters | **★ 1.2k+** | 600 | 600 |
| Active physics bodies | bodies | **★ 10k+** | 5k | 2k |

`+` 表示最大测试档位仍通过，不代表未测试负载也一定通过。
本容量表中的 `★` 表示当前已验证容量最高；并列最高会同时标记。

## 结果解释规则

1. 性能明细表的时间列为 5 次重复运行的 p95 中位数，单位为毫秒；这些时间并非
   统一意义上的端到端屏幕帧时间，具体指标以列名为准。
2. CPU case 测量同步 update、动画/物理更新和 render submission。
3. Shadow case 使用 `max(CPU p95, GPU p95)`；当前结果主要由 GPU 限制。
4. PBR overdraw 使用 GPU timer p95。
5. 回调间隔不作为 CPU 指标。
6. 任意 repeat 无效时，该负载档位不参与 p95 或容量计算。
7. 默认行为 case 与统一工作量 case 分开解释。
8. CV 超过 10% 或结果明显非单调时，不进行细粒度排名。
9. 性能明细表中的 `**★ 数值**` 表示该负载行最低的有效 p95 中位数；并列最低会同时
   标记。它只表示当前实测数值最低，不代表差异一定具有统计显著性，也不改变
   默认行为 case 的可比性限制。`Partial` 和 `OOM` 不参与最佳值标记。

全量结果包含 630 次运行，其中 625 次有效。无效项为：

- PlayCanvas `lights@64`：2/5 未收敛；
- Babylon.js `lights-forward@32`：1/5 未收敛；
- PlayCanvas `physics@10000`：2/5 WASM OOM。

所有跨引擎输入 parity 检查通过。195 个 GPU-timed run 均无 skipped query
或 disjoint query。

---

## 1. Empty Scene

场景只有 camera 和 clear pass，没有 draw call。

| Engine | CPU p95 (ms) |
|---|---:|
| three.js | **★ 0.1** |
| Babylon.js | 0.2 |
| PlayCanvas | 0.2 |

### 差异和原因

三个结果都低于 0.3ms，已接近 `performance.now()` 的计时粒度和浏览器运行噪声。
这里能确认三个引擎的空场景同步提交开销都很低，不能把 0.1ms 的差值解释成有意义的
产品优势。

---

## 2. Default Dynamic Lights

场景固定为 300 draw、1,200,000 triangles，并移动 point lights。
此 case 保留引擎默认灯光架构。

| Lights (count) | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 4 | **★ 0.8** | 2.5 | 1.0 |
| 16 | **★ 0.8** | 2.4 | 1.1 |
| 32 | 4.4 | 2.5 | **★ 1.0** |
| 64 | 142.6 | **★ 2.4** | Partial 3/5 |

### 差异和原因

- three.js 使用 `forward-all-lights`，材质 shader 会包含全部 point lights。
- Babylon.js 的 `PBRMaterial.maxSimultaneousLights` 保持默认值 4，因此 16、32、
  64 盏灯并不会全部作用于一个材质。其曲线保持平坦符合该限制。
- PlayCanvas 保持 clustered lighting，灯光先分配到 cluster，材质不会直接形成
  与全局灯光总数相同长度的 forward light loop。

three.js 在 32 lights 的结果为 0.8-17.3ms，CV 88%；64 lights 才稳定在
128.9-159.4ms。PlayCanvas 64 lights 有两次无法达到稳态。这说明高灯光档位存在
明显的 GPU/driver backpressure 和运行态变化。

这个 case 的主指标是 CPU submission，不是 GPU timer，因此 64 lights 的大值说明
同步提交路径受到严重反压，但不能被解释成纯 fragment shader GPU 时间。
由于三种默认策略处理的实际灯光工作不同，本 case 不生成跨引擎容量排名。

---

## 3. Normalized Forward Lights

场景同样固定为 300 draw、1,200,000 triangles。PlayCanvas 关闭 clustered lighting，
Babylon.js 将 `maxSimultaneousLights` 提高到请求灯光数加 directional light，
使全部 point lights 能作用于每个材质。

| Lights (count) | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 4 | **★ 0.8** | 2.6 | 0.9 |
| 8 | **★ 0.8** | 3.0 | 0.9 |
| 16 | **★ 0.8** | 3.5 | 1.0 |
| 32 | 6.4 | Partial 4/5 | **★ 1.2** |

### 差异和原因

4-16 lights 的稳定数据说明 Babylon.js 的 forward light/material binding 路径具有
更高的同步 CPU 成本，并随灯光数增加；three.js 和 PlayCanvas 的同步提交成本变化较小。

32 lights 不能用于精确排名：

- three.js 范围为 0.8-18.3ms，CV 80%；
- Babylon.js 有一次未收敛，其余四次范围为 2.7-20.2ms；
- PlayCanvas 为 1.1-1.2ms。

这些结果仍然是 CPU submission，而不是完整的 GPU lighting cost。它可以比较
scene update、材质/light binding 和提交反压，但不能证明 PlayCanvas 的 32-light
fragment shader 只需要 1.2ms。要专门评价光照像素成本，应给本 case 增加 GPU timer。

---

## 4. Single Shadow Map / Increasing Casters

统一条件：

- 1 个 2048x2048 hard shadow map；
- 1,000-20,000 个动态 UV sphere；
- 每个 sphere 560 triangles；
- 硬件 instancing；
- 精确 3 draw；
- 相同 shadow near/far、spot cone、布局和动画。

表格使用 CPU/GPU 中较大的 p95。

| Casters (count) | Submitted triangles/frame | three.js CPU/GPU bottleneck p95 (ms) | Babylon.js CPU/GPU bottleneck p95 (ms) | PlayCanvas CPU/GPU bottleneck p95 (ms) |
|---:|---:|---:|---:|---:|
| 1,000 | 1,120,012 | **★ 2.6** | **★ 2.6** | 5.0 |
| 2,500 | 2,800,012 | 4.8 | 4.6 | **★ 3.9** |
| 5,000 | 5,600,012 | 7.0 | 7.4 | **★ 6.3** |
| 10,000 | 11,200,012 | 11.4 | 11.6 | **★ 11.2** |
| 20,000 | 22,400,012 | 20.3 | 18.9 | **★ 18.7** |

### 差异和原因

5,000 casters 以上，三个引擎的 GPU p95 很接近，10,000 档都约为 11ms。
20,000 档的 min-max 范围也互相重叠，因此不能把 1-2ms 差值解释为稳定排名。

GPU raster、shadow depth pass、main pass 和默认材质 shader 是主要成本。CPU p95
在 20,000 casters 时分别约为：

- three.js 2.7ms；
- Babylon.js 3.5ms；
- PlayCanvas 5.1ms。

这部分 CPU 差异与每帧生成全部 instance matrix 并上传 buffer 的路径有关：

- three.js 使用 `Matrix4.compose` 和 `InstancedMesh.setMatrixAt`；
- Babylon.js 使用 `Matrix.ComposeToRef` 并更新 thin-instance buffer；
- PlayCanvas 使用 `Mat4.setTRS`，写入完整数组后调用 `VertexBuffer.setData`。

低 caster 档位 CV 达到 30%-37%，GPU 固定开销和频率变化大于引擎间差值。
three.js 和 Babylon.js 的稳定 60 FPS 边界为 10,000；PlayCanvas 曲线非单调，
因此报告不为它生成容量值。

---

## 5. Multiple Shadow Maps

固定 1,000 个动态 caster，每增加一个 spotlight 就增加一个独立 2048x2048
shadow pass。

| Shadow maps (count) | Draws/frame | Submitted triangles/frame | three.js CPU/GPU bottleneck p95 (ms) | Babylon.js CPU/GPU bottleneck p95 (ms) | PlayCanvas CPU/GPU bottleneck p95 (ms) |
|---:|---:|---:|---:|---:|---:|
| 1 | 3 | 1,120,012 | **★ 2.6** | **★ 2.6** | 3.1 |
| 2 | 4 | 1,680,012 | **★ 5.4** | **★ 5.4** | 5.7 |
| 4 | 6 | 2,800,012 | 5.2 | 5.1 | **★ 4.6** |
| 8 | 10 | 5,040,012 | 8.0 | 8.5 | **★ 5.2** |

### 差异和原因

理论工作量会随 shadow map 数增加，因为每盏灯都重新渲染 caster depth。
three.js 的总体曲线最接近这一趋势，但 2 到 4 maps 仍有轻微回落。
Babylon.js 和 PlayCanvas 的曲线更明显非单调，并且多个档位 CV 超过 10%。

因此可以确认三个引擎在 8 maps 时都低于 60 FPS budget，但不能根据当前数据
声称 PlayCanvas 的多 shadow-map 实现稳定快于另外两个引擎。低负载 GPU 频率、
query 时序、默认 shadow shader 和 render-target 管理都会影响这些小差值。

---

## 6. Visibility / Frustum Culling

可见对象始终固定为 100，因此每帧始终为 100 draw、1,200 submitted triangles。
变量只增加视锥外对象数量。

| Total objects (count) | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 1,000 | **★ 0.5** | 1.2 | 0.6 |
| 5,000 | 1.8 | 3.2 | **★ 1.0** |
| 10,000 | 2.8 | 3.8 | **★ 1.7** |
| 20,000 | 3.7 | 7.2 | **★ 2.6** |

### 差异和原因

因为可见 draw 数固定，曲线主要反映 scene traversal、world transform/bounds 检查、
active object 收集和默认 frustum culling 的每对象 CPU 成本。

- PlayCanvas 的增长最慢，在 20,000 objects 时为 2.6ms。
- three.js 为 3.7ms，处于中间。
- Babylon.js 为 7.2ms，约为 PlayCanvas 的 2.8 倍。

Harness 分别使用默认 `MeshInstance.cull`、`Object3D.frustumCulled` 和 Babylon
standard bounding-info culling。结果证明 Babylon.js 默认 active-mesh/bounds
处理路径在此场景中成本更高，但本测试没有 CPU profile，不能再归因到某一个内部函数。

三个引擎在最大 20,000 objects 档位都满足 60 FPS budget。

---

## 7. Draw Submission

所有档位固定为精确 1,200,000 triangles，复用一个 geometry resource，
关闭 frustum culling，并让对象数等于实际 draw call 数。

| Draw calls/frame | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|
| 500 | **★ 1.1** | 2.7 | 1.2 |
| 2,000 | 2.9 | 4.4 | **★ 2.8** |
| 5,000 | 3.3 | 11.8 | **★ 3.2** |
| 10,000 | 8.3 | 22.7 | **★ 6.5** |

### 差异和原因

由于 triangle 总数和 geometry sharing 已对齐，主要变量是独立 mesh/entity 的
scene bookkeeping、材质准备、draw state 绑定和 WebGL draw submission。

- PlayCanvas 在 10,000 draws 时最低，为 6.5ms。
- three.js 为 8.3ms，与 PlayCanvas 同属一个性能区间。
- Babylon.js 为 22.7ms，超过 60 FPS budget。

Babylon.js 使用共享 Geometry 的独立 Mesh clones，PlayCanvas 使用独立 Entity 和
MeshInstance，three.js 使用独立 Mesh。数据表明 Babylon.js 的每 mesh/submesh
提交固定成本更高；没有 profiler 数据时，不应把全部差值指定给 material check、
active-mesh evaluation 或 uniform binding 中的某一个步骤。

60 FPS 实测边界：three.js 10k+、Babylon.js 5k、PlayCanvas 10k+。

---

## 8. Linear AABB Raycast

每帧对固定 5,000 个 AABB 进行线性扫描，每条 ray 都有一个确定命中。
这不是 BVH、octree 或 physics-world raycast。

| Rays/frame | AABB tests/frame | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|---:|
| 1 | 5,000 | **★ 0.2** | 0.3 | 0.8 |
| 8 | 40,000 | **★ 0.9** | 1.4 | 2.9 |
| 32 | 160,000 | **★ 2.8** | 3.0 | 4.3 |
| 128 | 640,000 | **★ 3.2** | 4.9 | 18.0 |

### 差异和原因

three.js 和 Babylon.js 的实现使用 slab-style interval test，逐轴更新 ray 的
进入/离开区间并尽早退出。PlayCanvas 在未请求 intersection point 时使用
`_fastIntersectsRay` separating-axis 路径，其中包含多次 Vec3 运算、绝对值和
cross product。

当前数据与这两个算法路径的运算量差异一致：

- three.js 在 128 rays 时为 3.2ms；
- Babylon.js 为 4.9ms；
- PlayCanvas 为 18.0ms。

60 FPS 实测边界：three.js 128+、Babylon.js 128+、PlayCanvas 32。
这个结论只适用于当前公开 math API 的线性 AABB 测试。

---

## 9. Default PBR Overdraw

统一输入：

- 8-128 个全屏透明 layer；
- 一个 instanced draw；
- 相同 quad geometry；
- 相同四张 512x512 albedo/normal/roughness/metalness textures；
- alpha 0.1、depth write disabled；
- 使用各引擎默认 lit material。

表格为 GPU p95。

| Layers (count) | three.js GPU p95 (ms) | Babylon.js GPU p95 (ms) | PlayCanvas GPU p95 (ms) |
|---:|---:|---:|---:|
| 8 | 5.3 | **★ 4.5** | 5.8 |
| 32 | **★ 10.1** | 12.5 | **★ 10.1** |
| 64 | 18.1 | **★ 17.8** | 18.0 |
| 128 | 17.4 | **★ 17.1** | 18.7 |

### 差异和原因

64 和 128 layers 时三个结果集中在 17-19ms，且 128 layers 没有继续单调增长。
这说明当前 GPU 已进入频率、带宽、blend 或 driver scheduling 主导的区域；
不能把小于约 2ms 的差值解释成稳定 shader 排名。

实际 active samplers 也不同：

- three.js：5 个，包括四张材质图和 DFG LUT；
- Babylon.js：5 个，包括 environment BRDF sampler；
- PlayCanvas：7 个，包括四张材质图和 clustered-lighting textures。

三个默认材质的 BRDF、roughness/gloss 语义、环境 BRDF、颜色处理和灯光数据结构均不同。
因此本 case 描述默认产品成本，不代表相同画质或相同 shader 功能下的性能。

---

## 10. Skeletal Animation

所有引擎加载同一 CesiumMan：

- 19 bones；
- 57 animation channels；
- 每角色 4,672 triangles；
- 每角色一个 draw；
- 禁用角色 frustum culling。

| Characters (count) | Submitted triangles/frame | three.js CPU p95 (ms) | Babylon.js CPU p95 (ms) | PlayCanvas CPU p95 (ms) |
|---:|---:|---:|---:|---:|
| 100 | 467,200 | **★ 2.0** | 3.3 | 2.9 |
| 300 | 1,401,600 | **★ 3.5** | 7.6 | 5.3 |
| 600 | 2,803,200 | **★ 7.2** | 14.1 | 10.4 |
| 1,200 | 5,606,400 | **★ 14.9** | 28.5 | 21.8 |

### 差异和原因

three.js 在全部档位领先，PlayCanvas 居中，Babylon.js 同角色数下成本最高。
1,200 characters 时：

- three.js 14.9ms；
- PlayCanvas 21.8ms；
- Babylon.js 28.5ms。

Harness 使用的默认动画路径分别为：

- three.js：`SkeletonUtils.clone`、每角色一个 `AnimationMixer`；
- Babylon.js：每角色实例化独立 skeleton 和 `AnimationGroup` /
  `TargetedAnimation`；
- PlayCanvas：每角色实例化完整 Entity hierarchy，并由 `AnimComponent`
  更新动画和 bone entities。

曲线随角色数持续扩大，说明差异主要来自每角色 animation sampling、bone/world
matrix propagation、skin palette 更新和 draw preparation 的固定成本。
该 case 没有做函数级 profile，因此不能把全部差值归因到其中单一阶段。

60 FPS 实测边界：three.js 1,200+、Babylon.js 600、PlayCanvas 600。

---

## 11. Physics Stack

比较的是完整集成栈：

- three.js + Rapier 0.20.0；
- Babylon.js + Havok 1.3.14；
- PlayCanvas + Ammo.js WASM。

所有后端使用相同 box layout、mass、initial velocity、gravity、ground 和 1/60 fixed
step。刚体休眠全部禁用；每个有效 run 结束时 sleeping bodies 为 0。
渲染统一为一个 instanced body draw 加一个 ground draw。

| Bodies (count) | Draws/frame | three.js + Rapier CPU p95 (ms) | Babylon.js + Havok CPU p95 (ms) | PlayCanvas + Ammo CPU p95 (ms) |
|---:|---:|---:|---:|---:|
| 500 | 2 | **★ 2.0** | 2.3 | 3.2 |
| 2,000 | 2 | **★ 2.7** | 4.3 | 11.5 |
| 5,000 | 2 | **★ 6.7** | 10.8 | 31.8 |
| 10,000 | 2 | **★ 14.1** | 22.9 | OOM 2/5 |

### 差异和原因

three.js + Rapier 的扩展曲线最好，Babylon.js + Havok 居中，PlayCanvas + Ammo
从 2,000 bodies 开始明显变慢。

PlayCanvas 5,000 bodies 的范围为 22.2-38.0ms，CV 20%，说明该负载还存在较大
运行波动。10,000 bodies 的 5 次重复中有 2 次 WASM OOM，该档位无有效 p95。

每帧除 solver 外还包括：

- 从每个刚体读取 position/rotation；
- 生成 instance matrices；
- 上传完整动态 instance buffer；
- engine/component 的 transform synchronization。

Rapier、Havok 和 Ammo 的 broadphase、contact solver、内存管理及 JS/WASM binding
不同；三个引擎的 physics integration 也不同。因此本结果只能评价这里列出的完整栈，
不能单独证明 Rapier、Havok 或 Ammo 裸 solver 的排名。

60 FPS 实测边界：three.js + Rapier 10k+、Babylon.js + Havok 5k、
PlayCanvas + Ammo 2k。

---

## 可靠性限制

1. 当前结果只覆盖一台 Apple M5 Pro 和 Headless Chromium/ANGLE Metal。
2. 没有覆盖 Android WebView、Android Chrome、iOS Safari/WKWebView 或 Windows。
3. Lights case 没有 GPU timer，不能作为纯 GPU lighting benchmark。
4. Default lights 和 default PBR 保留产品策略差异，不是同画质比较。
5. Shadow-maps 和部分低负载 shadow 数据具有较高 CV 或非单调曲线。
6. Physics 是引擎、物理库、binding、transform sync 和渲染上传的完整栈。
7. 小于约 0.3ms 的 CPU 数值接近浏览器计时分辨率。

面向 H5 产品选型时，至少还应在目标 Android/iOS 设备、实际 WebView/Safari、
热状态和产品 shader/material 配置下重复相同矩阵。
