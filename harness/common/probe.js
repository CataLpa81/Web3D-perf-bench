// WebGL draw-call probe used by the parity gate.
// Import this module before an engine creates its WebGL context.
const S = { drawCalls: 0, triangles: 0, instances: 0, byMode: {}, installed: false };

const MODE_TRIANGLES = 0x0004;
const MODE_TRIANGLE_STRIP = 0x0005;
const MODE_TRIANGLE_FAN = 0x0006;

function triCount(mode, count) {
  if (mode === MODE_TRIANGLES) return count / 3;
  if (mode === MODE_TRIANGLE_STRIP || mode === MODE_TRIANGLE_FAN) return Math.max(0, count - 2);
  return 0;
}

function install() {
  if (S.installed) return;
  const protos = [];
  if (typeof WebGL2RenderingContext !== 'undefined') protos.push(WebGL2RenderingContext.prototype);
  if (typeof WebGLRenderingContext !== 'undefined') protos.push(WebGLRenderingContext.prototype);
  for (const p of protos) {
    const de = p.drawElements, da = p.drawArrays;
    const dei = p.drawElementsInstanced, dai = p.drawArraysInstanced;
    if (de) p.drawElements = function (mode, count, type, offset) {
      S.drawCalls++; S.instances++; S.triangles += triCount(mode, count);
      S.byMode[mode] = (S.byMode[mode] || 0) + 1;
      return de.call(this, mode, count, type, offset);
    };
    if (da) p.drawArrays = function (mode, first, count) {
      S.drawCalls++; S.instances++; S.triangles += triCount(mode, count);
      S.byMode[mode] = (S.byMode[mode] || 0) + 1;
      return da.call(this, mode, first, count);
    };
    if (dei) p.drawElementsInstanced = function (mode, count, type, offset, primcount) {
      S.drawCalls++; S.instances += primcount; S.triangles += triCount(mode, count) * primcount;
      S.byMode[mode] = (S.byMode[mode] || 0) + 1;
      return dei.call(this, mode, count, type, offset, primcount);
    };
    if (dai) p.drawArraysInstanced = function (mode, first, count, primcount) {
      S.drawCalls++; S.instances += primcount; S.triangles += triCount(mode, count) * primcount;
      S.byMode[mode] = (S.byMode[mode] || 0) + 1;
      return dai.call(this, mode, first, count, primcount);
    };
  }
  S.installed = true;
}
install();

export function resetProbe() {
  S.drawCalls = 0; S.triangles = 0; S.instances = 0; S.byMode = {};
}

// Read one clean frame after resetting the counters.
export function readProbe() {
  return {
    drawCalls: S.drawCalls,
    triangles: S.triangles,
    instances: S.instances,
    byMode: { ...S.byMode },
  };
}
