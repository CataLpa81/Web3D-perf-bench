# 默认行为性能对比：three.js、Babylon.js 与 PlayCanvas

[English](./CONCLUSION.md)

引擎版本：three.js 0.185.1、Babylon.js 9.20.0、PlayCanvas 2.21.3  
测试环境：Apple M5 Pro、Headless Chrome 151、ANGLE Metal、1280x720、DPR 1、关闭垂直同步、
300 FPS 上限  
常规采样：每个测试点 3 秒、1 次重复、至少 90 个稳态样本  
可见性、射线检测和阴影归因采样：每个测试点 6 秒、5 次重复

> 主要对比保留各引擎默认行为，对齐的是场景输入，而不是最终画面。
> 下文提到的 shader 修改仅用于性能归因实验。

## 结论

**three.js 的综合表现最强。在基础开销、高 draw call 负载、骨骼动画和本次测试的物理栈中，
它通常最快或接近最快。它最明显的弱点是大量动态灯光；PlayCanvas 依靠 clustered lighting
在该场景下扩展得更好，同时具有最低的可见性裁剪开销。three.js 的 AABB 射线相交实现最快。
PlayCanvas 的默认 PBR fragment shader 也更便宜，但其功能和画质路径更简单，因此这属于材质
设计取舍，不能视为 three.js 的性能缺陷。Babylon.js 表现出更高的单 mesh、动画和 active-mesh
评估开销。**

## 关键数据

下表使用各场景所列最高有效负载点的 p95 帧时间，数值越低越好。

| 场景 | three.js | Babylon.js | PlayCanvas | 结果 |
|---|---:|---:|---:|---|
| 空场景 | **5.1ms** | **5.1ms** | 5.3ms | 基本持平 |
| 64 个动态点光源 | 160.6ms | **6.8ms*** | 16.6ms | three.js 扩展性较差 |
| 10,000 draw calls | **12.1ms** | 26.3ms | 12.5ms | three.js 与 PlayCanvas 领先 |
| 20,000 个可见性对象 | 8.2ms | 15.3ms | **7.8ms** | PlayCanvas 领先 |
| 5,000 个 AABB 上执行 128 条射线 | **9.2ms** | 10.6ms | 20.7ms | three.js 领先 |
| 1,200 个蒙皮角色 | **18.5ms** | 32.6ms | 26.8ms | three.js 领先 |
| 5,000 个动态刚体 | **13.5ms** | 15.3ms | 34.7ms | three.js + Rapier 领先 |

\* Babylon.js 默认 `maxSimultaneousLights=4`，因此 64 个灯光不会全部作用于同一个材质。

在 PBR fragment 成本归因测试中，相对于统一的四纹理 shader，three.js 默认 PBR 成本为
**3.64 倍**，PlayCanvas 为 **2.15 倍**。这反映了默认材质复杂度的差异，不能证明
PlayCanvas 在功能和输出质量相同的条件下更快。

---

# 详细结果

除非另有说明，下列表格均为 p95 帧时间，单位为毫秒。

## 1. 空场景

| 引擎 | p50 | p95 | p99 | 平均 FPS |
|---|---:|---:|---:|---:|
| three.js | 4.6 | **5.1** | 5.4 | 216.8 |
| Babylon.js | 4.6 | **5.1** | 5.5 | 215.2 |
| PlayCanvas | 4.7 | 5.3 | 5.6 | 209.6 |

三个引擎基本持平。约 5ms 的下限包含浏览器定时器与调度开销。

## 2. 动态点光源

场景包含 300 个 mesh，每帧提交约 121.5 万个三角形。

| 灯光数 | three.js | Babylon.js | PlayCanvas |
|---:|---:|---:|---:|
| 4 | **5.7** | 6.6 | 5.9 |
| 16 | **5.7** | 6.6 | 6.1 |
| 32 | 16.6 | 6.5 | **6.1** |
| 64 | 160.6 | **6.8** | 16.6 |

### 原因

- **three.js** 使用逐灯光 forward shading。灯光数量进入 shader program 定义，
  fragment shader 会处理所有活动灯光。
- **Babylon.js** 默认 `maxSimultaneousLights=4`，限制了单个材质可受影响的灯光数量。
  其结果保持平稳，不代表实际计算了全部 64 个灯光。
- **PlayCanvas** 使用 clustered lighting，fragment 仅处理影响当前 cluster 的灯光。

大量动态灯光是本次测试中 three.js 最明显的弱点。在 4 至 16 个灯光时，three.js 仍具有竞争力。

## 3. Draw Calls

随着独立 mesh 数量增加，总几何量保持在约 120 万个三角形。

| Draw calls | three.js | Babylon.js | PlayCanvas |
|---:|---:|---:|---:|
| 500 | **6.0** | 6.5 | 6.1 |
| 2,000 | 6.7 | 9.0 | **6.5** |
| 5,000 | 8.5 | 15.7 | **8.2** |
| 10,000 | **12.1** | 26.3 | 12.5 |

three.js 与 PlayCanvas 的结果接近。在 10,000 draw calls 时，两者仍处于 60 FPS 帧预算内。
CPU profiling 显示，Babylon.js 约 37.6% 的 CPU 时间消耗在逐 SubMesh 材质检查、灯光绑定
和 uniform 准备上。

## 4. 可见性裁剪

20,000 个对象中有 10% 可见时，three.js 的 p95 为 8.2ms，Babylon.js 为 15.3ms，
PlayCanvas 为 7.8ms。三个引擎均提交相同的 2,000 个可见 draw。PlayCanvas 扫描紧凑的
mesh-instance 列表；three.js 递归遍历 Object3D 树；Babylon.js 对每个候选对象评估
ready 状态、enabled 状态、LOD、激活、包围体、SubMesh 和材质。

将 Babylon.js 改为仅使用包围球裁剪后结果为 15.1ms，而调用 `freezeActiveMeshes()` 后，
p95 从 15.2ms 降至 7.8ms。其主要成本来自 active-mesh 评估，而不是最后的视锥相交计算。

## 5. AABB 射线检测

每帧使用 128 条射线线性查询 5,000 个 AABB 时，three.js 的 p95 为 9.2ms，Babylon.js
为 10.6ms，PlayCanvas 为 20.7ms。排名来自数学 API：three.js 和 Babylon.js 使用标量
slab 算法，PlayCanvas 使用包含更多向量运算的 separating-axis 路径。

独立的 V8 对照测试分别测得 3.30ms、5.66ms 和 15.44ms，确认了相同的性能顺序。
该结果仅适用于线性 AABB 测试，不代表场景 BVH 或物理世界 raycast 的性能。

## 6. 动态阴影实例更新

单 shadow map 的高压力测试使用 20,000 个动态 instance，每个 instance 560 个三角形，
每帧提交 2,240 万个三角形、3 个 draw calls，并完整上传 1.28MB instance matrix 数据。

独立于 renderer 的对照测试生成相同的 20,000 个矩阵时，three.js 耗时 0.71ms，
Babylon.js 为 0.98ms，PlayCanvas 为 1.49ms。

three.js 使用专用的 axis-angle 路径；Babylon.js 还会对旋转轴做归一化；
PlayCanvas 使用通用的 Euler-to-quaternion 路径。关闭动画后，每帧矩阵生成和完整
instance buffer 上传会被移除，而 draw call 数不变。这说明这些操作是高 caster 数量下
帧成本的重要组成部分。

## 7. 骨骼动画

所有引擎加载同一个 CesiumMan GLB：19 根骨骼、4,672 个三角形和 57 个动画通道。
角色的动画相位按索引错开。

| 角色数 | three.js | Babylon.js | PlayCanvas |
|---:|---:|---:|---:|
| 100 | **6.4** | 7.2 | 7.3 |
| 300 | **8.2** | 13.0 | 10.2 |
| 600 | **11.8** | 19.8 | 15.9 |
| 1,200 | **18.5** | 32.6 | 26.8 |

三个引擎提交的 draw call 和三角形数量差异小于 0.7%。

| 引擎 | 默认动画更新路径 |
|---|---|
| three.js | 扁平 typed array 与直接的函数式插值 |
| Babylon.js | 每个通道一个 `RuntimeAnimation`，通过对象调用和 setter 回写 |
| PlayCanvas | 骨骼是完整 Entity，会传播 dirty 状态、层级和包围体更新 |

独立的静态角色对照测试得到：

| 1,200 个角色时的指标 | three.js | Babylon.js | PlayCanvas |
|---|---:|---:|---:|
| 播放动画 | 13.5 | 27.1 | 21.8 |
| 相同模型，静态 | 9.6 | 9.7 | 7.7 |
| 仅动画增量 | **3.9** | 17.4 | 14.1 |

两组测试均表明，three.js 默认动画更新路径明显更轻。

## 8. 默认 PBR Fragment 成本

场景使用 128 个独立运动的全屏透明层、固定 `alpha=0.1`、关闭 depth write、相同的
albedo/normal/roughness/metalness 纹理、一个方向光、一个 instanced draw call，
并保持 100% 几何覆盖率。

由于异步 WebGL 提交会使跨页面绝对时间受到命令队列深度和 GPU 频率影响，归因测试采用
同一 WebGL context 内交替运行的成对材质。

| 引擎 | 默认 PBR / 统一四纹理 shader |
|---|---:|
| three.js | 3.64x |
| PlayCanvas | 2.15x |

该比值表明，在相同四次纹理读取之外，three.js 执行了更多材质计算。

### 原因

PlayCanvas 默认使用成本更低的 normalized Blinn-Phong specular 路径和 Schlick Fresnel。
three.js 包含 multiscatter GGX、DFG LUT 读取、能量补偿、geometric-roughness 导数
以及更准确的 sRGB 输出。

仅将 PlayCanvas 的 specular 模型从默认实现切换到 GGX，平均 GPU 时间由 8.18ms
增加至 8.61ms，约增加 5.2%。因此，差异来自完整 shader 路径，而不只是 BRDF 名称。

成对的 three.js 消融实验得到：

| three.js 归因修改 | 平均 GPU 时间变化 |
|---|---:|
| 移除 direct multiscattering 和两次 DFG LUT 读取 | -12.0% |
| 同时将 direct lighting 替换为 Blinn-Phong | 累计 -15.0% |
| 仅禁用 geometric-roughness 导数 | -8.9% |
| 使用简化 gamma 输出 | 约 -5% |
| 合并全部修改 | **-32.7%**；p95 -35.8% |

PlayCanvas 的默认材质成本更低，因为其 PBR 操作更少且更简单。three.js 在 multiscattering、
能量补偿、geometric roughness 和色彩处理上进行了更多计算。本节仅解释默认材质差异，
不对同画质性能进行排名。Babylon.js 未能产生稳定的成对归因样本。

## 9. 物理栈

对比的完整技术栈为 three.js + Rapier、Babylon.js + Havok 和 PlayCanvas + Ammo。
初始位置、尺寸、质量、速度、重力、地面和固定 1/60 步进均已对齐。

| 刚体数 | three.js + Rapier | Babylon.js + Havok | PlayCanvas + Ammo |
|---:|---:|---:|---:|
| 500 | 8.5 | **8.3** | 9.0 |
| 2,000 | 10.9 | **10.7** | 13.7 |
| 5,000 | **13.5** | 15.3 | 34.7 |
| 10,000 | **29.4** | 样本不足；观测值 49.5 | 样本不足；观测值 257.5 |

500、2,000 和 5,000 刚体测试点均执行了约 180 次物理 substep。

这是完整技术栈对比，不是隔离的物理库测试。5,000 个刚体时，three.js 和 Babylon.js
均提交 2 个 draw calls，PlayCanvas 提交 1,462 个，并裁剪了更多对象。因此渲染和物理集成
都会影响最终结果。

---

# 补充发现

## 运行时改变灯光数量可能触发 Shader 重新编译

| 操作 | three.js | Babylon.js | PlayCanvas |
|---|---|---|---|
| 增加一个点光源 | 观察到一次额外 program compile/link | 活动灯光数变化时一次 | 未观察到 clustered 点光源重新编译 |
| 再增加五个 | 观察到更多重新编译 | 达到默认四灯限制后停止 | 未观察到 clustered 点光源重新编译 |

three.js 会将灯光数量加入 program cache key。运行时改变灯光总数可能造成 shader 编译卡顿。
需要稳定帧时间时，更适合使用灯光池。

## three.js 也存在高灯光数量 Shader 上限

使用 256 个点光源的上限实验产生：

```text
FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)
```

具体限制取决于设备和材质，但默认 forward-light 路径无法支持不受限制的实时灯光数量。

## 启动与内存

| 指标 | three.js | Babylon.js | PlayCanvas |
|---|---:|---:|---:|
| 300 个对象时的启动时间 | **41ms** | 1,138ms* | 95ms |
| 空场景 JS heap | **11MB** | 32MB | 18MB |
| 10,000 个对象的 JS heap | **38MB** | 190MB | 73MB |
| 估算的单对象增量 | **2.6KB** | 15.9KB | 4.9KB |

\* Babylon.js 启动样本包含等待异步 shader 编译的时间，不应被理解为所有 Babylon.js
应用都具有固定的同等启动成本。

## 实现注意事项

| 主题 | 发现 |
|---|---|
| PlayCanvas render loop | `app.start()` 会调度自己的 rAF；使用外部循环时必须避免重复渲染 |
| Babylon.js shader | 编译是异步的，应等待 `scene.whenReadyAsync()` |
| Babylon.js winding | 在右手坐标模式下，共享 geometry 必须反转 winding |
| PlayCanvas + Ammo | WASM build 必须导出 `addFunction`，随后调用 `onLibraryLoaded()` |
| 静态动画对照 | Babylon.js 和 PlayCanvas 动画由引擎驱动，必须显式停止 |

---

# 局限

1. 大多数测试点使用 3 秒窗口且仅重复一次。正式选型应在目标设备上使用更长时间并重复测试。
2. 300 FPS 是上限而非保证值。定时器开销会掩盖轻负载下非常小的差异。
3. 物理测试对比的是完整技术栈，无法单独排名 renderer 或物理库。
4. 场景输入已对齐，但最终画面没有完全对齐。默认灯光限制和裁剪会改变实际视觉工作量。
5. Babylon.js 和 PlayCanvas 的 10,000 刚体测试点样本不足，因此不参与排名。
6. PBR fragment 归因使用同一 context 内的归一化比值。跨页面绝对 GPU 时间会受到命令队列
   和动态 GPU 频率影响。
7. 绝对数值仅适用于文中列出的硬件、浏览器和引擎版本。
