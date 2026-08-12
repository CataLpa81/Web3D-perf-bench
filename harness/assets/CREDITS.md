# Test Asset Credits

## Skinned Character

`CesiumMan.glb` comes from Khronos glTF-Sample-Assets:
https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan

| File | Bones | Vertices | Triangles | Animation | Textures | License |
|---|---:|---:|---:|---:|---:|---|
| `CesiumMan.glb` | 19 | 3,273 | 4,672 | 1 clip, 57 channels | 1 | CC BY 4.0, Cesium |

All three engines load the same file bytes.

## PBR Textures

The albedo, normal, roughness, and metalness maps under `pbr/` are derived from ambientCG
Metal063 and resized to 512x512. ambientCG assets are CC0 1.0:
https://ambientcg.com/view?id=Metal063

## Physics

| File | Purpose |
|---|---|
| `ammo.wasm.js` and `ammo.wasm.wasm` | Ammo.js WASM build used by PlayCanvas rigidbody components |
| `AMMO-LICENSE.txt` | Ammo.js zlib-style license |

This Ammo.js build exports Emscripten `addFunction`, which is required by the PlayCanvas rigidbody
integration. Source: https://github.com/kripken/ammo.js

Rapier and Havok are loaded directly from npm dependencies.
