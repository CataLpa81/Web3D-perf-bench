// Generate a compact, self-contained HTML report.
//
// Usage: node runner/report.mjs [batchId]
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, DOMAINS, DOMAIN_ORDER, VSYNC_BUDGET } from '../spec/cases.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const batchArg = process.argv[2];
const resultsDir = join(ROOT, 'results');
let batchId = batchArg;
if (!batchId) {
  // Prefer an actionable error over an ENOENT stack when no batch exists.
  let dirs = [];
  try {
    dirs = (await readdir(resultsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch { /* Report the same message for a missing or empty directory. */ }
  if (!dirs.length) {
    console.error('[report] no result batches found. Run npm run collect:quick first.');
    process.exit(1);
  }
  batchId = dirs[dirs.length - 1];
}
const outDir = join(resultsDir, batchId);
let data;
try {
  data = JSON.parse(await readFile(join(outDir, 'raw-results.json'), 'utf8'));
} catch {
  console.error(`[report] cannot read results/${batchId}/raw-results.json`);
  process.exit(1);
}

const ENGINES = ['three', 'babylon', 'playcanvas'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '–' : n.toFixed(d));
const bigNum = (n) => {
  if (n == null) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k';
  return String(n);
};

// Select the median-p95 record across repeated runs.
function pick(caseId, value, engine) {
  const rs = data.records.filter(r => r.caseId === caseId && r.value === value && r.engine === engine);
  if (!rs.length) return null;
  const limited = rs.find(r => r.engineLimit);
  const usesGpuTimer = CASES[caseId]?.primaryMetric === 'gpu';
  const metricOf = (r) => usesGpuTimer ? r.info?.gpuFrame : r.info?.frame;
  const valid = rs.filter(r => r.valid && metricOf(r)?.p95 != null);
  if (!valid.length) {
    return { limit: limited?.engineLimit || null, invalid: rs[0].gateReasons?.join('; ') || null };
  }
  const byP95 = [...valid].sort((a, b) => metricOf(a).p95 - metricOf(b).p95);
  const mid = byP95[Math.floor(byP95.length / 2)];
  const metric = metricOf(mid);
  return {
    p95: metric.p95, p50: metric.p50, p99: metric.p99,
    fps: usesGpuTimer ? (metric.mean ? 1000 / metric.mean : null) : mid.info.frame.avgFps,
    frames: metric.frameCount,
    metric: usesGpuTimer ? 'gpu' : 'cpu',
    drawCalls: mid.info.probe?.drawCalls, triangles: mid.info.probe?.triangles,
    litRatio: mid.info.framebufferCoverage,
    policy: mid.info.actual?.lightPolicy, repeats: valid.length,
    gpuP95: !usesGpuTimer && CASES[caseId]?.gpuTiming ? mid.info.gpuFrame?.p95 : null,
  };
}

function p95Cell(rec) {
  if (!rec) return '<td class="na">–</td>';
  if (rec.limit) return `<td class="lim" title="${esc(rec.limit)}">Engine limit</td>`;
  if (rec.p95 == null) return `<td class="na" title="${esc(rec.invalid || '')}">Invalid</td>`;
  const cls = rec.p95 <= VSYNC_BUDGET.fps60 ? 'ok' : (rec.p95 <= VSYNC_BUDGET.fps30 ? 'warn' : 'bad');
  const gpu = rec.gpuP95 == null ? '' : `<br><span class="dim">GPU ${fmt(rec.gpuP95)}</span>`;
  return `<td class="${cls}">${fmt(rec.p95)}${gpu}</td>`;
}

// Preserve records from older matrices under an explicit unknown domain.
const DOMAIN_META = {
  ...DOMAINS,
  unknown: { title: 'Unknown cases', note: 'These records are not present in the current case matrix.' },
};
const ORDER = [...DOMAIN_ORDER, 'unknown'];
const domainOf = (caseId) => (CASES[caseId]?.domain && DOMAINS[CASES[caseId].domain]) ? CASES[caseId].domain : 'unknown';

// Sort by domain, then by declaration order.
const declOrder = Object.keys(CASES);
const caseIds = [...new Set(data.records.map(r => r.caseId))]
  .sort((a, b) => {
    const da = ORDER.indexOf(domainOf(a)), db = ORDER.indexOf(domainOf(b));
    if (da !== db) return da - db;
    const ia = declOrder.indexOf(a), ib = declOrder.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
const domainsPresent = ORDER.filter(d => caseIds.some(id => domainOf(id) === d));

// ---------- Capacity summary ----------
let capRows = '';
for (const dom of domainsPresent) {
  const ids = caseIds.filter(id => domainOf(id) === dom && data.capacities?.[id]);
  if (!ids.length) continue;
  capRows += `<tr class="grp"><td colspan="8">${esc(DOMAIN_META[dom].title)}</td></tr>`;
  for (const caseId of ids) {
    const c = CASES[caseId];
    const cap = data.capacities[caseId];
    const cell = (eng, key) => {
      const d = cap[eng]?.[key];
      if (!d) return '<td class="na">–</td>';
      const sat = d.status === 'saturated';
      const txt = d.capacity == null ? 'Not reached' : bigNum(d.capacity) + (sat ? '+' : '');
      const title = sat ? 'All tested rungs stayed within budget; the true limit is above the matrix.' : d.status;
      return `<td class="${sat ? 'sat' : ''}" title="${esc(title)}">${txt}</td>`;
    };
    capRows += `<tr><td class="cs">${esc(caseId)}</td><td class="ax">${esc(c?.axis ?? '—')}</td>`
      + ENGINES.map(e => cell(e, 'at60')).join('')
      + ENGINES.map(e => cell(e, 'at30')).join('') + '</tr>';
  }
}

// ---------- Per-case details ----------
const sectionsByDomain = {};
for (const caseId of caseIds) {
  const c = CASES[caseId];
  const ladder = c?.ladder || [...new Set(data.records.filter(r => r.caseId === caseId).map(r => r.value))];
  let rows = '';
  for (const v of ladder) {
    const recs = ENGINES.map(e => pick(caseId, v, e));
    if (recs.every(r => !r)) continue;
    // Highlight differences in submitted draw calls.
    const dcs = recs.map(r => r?.drawCalls).filter(n => n != null);
    const dcSame = dcs.length > 1 && dcs.every(n => n === dcs[0]);
    const submitted = dcs.length
      ? (dcSame ? `${bigNum(dcs[0])} draw` : ENGINES.map((e, i) => recs[i]?.drawCalls != null ? `${e[0]}:${bigNum(recs[i].drawCalls)}` : '').filter(Boolean).join(' '))
      : '–';
    rows += `<tr><td class="v">${bigNum(v)}</td>`
      + recs.map(p95Cell).join('')
      + recs.map(r => `<td class="dim">${r?.fps == null ? '–' : fmt(r.fps, 0)}</td>`).join('')
      + `<td class="dim ${dcSame ? '' : 'diff'}">${esc(submitted)}</td></tr>`;
  }
  // Lighting needs evidence about how many lights actually affect pixels.
  let extra = '';
  if (caseId === 'lights') {
    let lr = '';
    for (const v of ladder) {
      const recs = ENGINES.map(e => pick(caseId, v, e));
      lr += `<tr><td class="v">${v}</td>`
        + recs.map(r => `<td class="dim">${r?.litRatio == null ? '–' : fmt(r.litRatio, 3)}</td>`).join('')
        + '</tr>';
    }
    const pol = ENGINES.map(e => {
      const r = ladder.map(v => pick(caseId, v, e)).find(x => x?.policy);
      return `<li><b>${e}</b>: ${esc(r?.policy || '–')}</li>`;
    }).join('');
    extra = `<div class="note warnbox">
      <b>Do not quote the timing table without this context.</b>
      The engines use different default lighting policies, so the number of lights that reach the pixel shader differs:
      <ul>${pol}</ul>
      The table below shows the lit-pixel ratio. Babylon changes little from 4 to 64 lights because its default
      material only evaluates four simultaneous lights. The additional lights are ignored, so the lower cost is
      not an equal-work performance advantage.
    </div>
    <table class="lit"><thead><tr><th>Lights</th>${ENGINES.map(e => `<th>${e}</th>`).join('')}</tr></thead><tbody>${lr}</tbody></table>`;
  }
  const fixed = c?.fixed ? Object.entries(c.fixed).map(([k, v]) => `${k}=${v}`).join(' · ') : '';
  const usesGpuTimer = c?.primaryMetric === 'gpu';
  const dom = domainOf(caseId);
  (sectionsByDomain[dom] ??= []).push(`<section>
    <h3>${esc(caseId)} <span class="ax">variable: ${esc(c?.axis || '—')}</span></h3>
    <p class="note">${esc(c?.note || '')}</p>
    ${fixed ? `<p class="fixed">Fixed: ${esc(fixed)}</p>` : ''}
    <table>
      <thead>
        <tr><th rowspan="2">${esc(c?.axis || 'Load')}</th><th colspan="3">${usesGpuTimer ? 'GPU p95' : 'Frame p95'} (ms)</th><th colspan="3">${usesGpuTimer ? 'GPU-equivalent FPS' : 'Average FPS'}</th><th rowspan="2">Submitted/frame</th></tr>
        <tr>${ENGINES.map(e => `<th>${e}</th>`).join('')}${ENGINES.map(e => `<th class="dim">${e}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${c?.gpuTiming && !usesGpuTimer ? '<p class="note">GPU p95 is shown below the end-to-end frame p95 in each timing cell.</p>' : ''}
    ${extra}
  </section>`);
}

const domainSections = domainsPresent.map(dom => `
<h2>${esc(DOMAIN_META[dom].title)}</h2>
<p class="note">${esc(DOMAIN_META[dom].note)}</p>
${(sectionsByDomain[dom] || []).join('')}`).join('');

// ---------- Findings ----------
const limits = data.records.filter(r => r.engineLimit);
const seenLimit = new Set();
let limitItems = '';
for (const r of limits) {
  const k = `${r.engine}|${r.engineLimit}`;
  if (seenLimit.has(k)) continue;
  seenLimit.add(k);
  limitItems += `<li><b>${esc(r.engine)}</b> at ${esc(r.pointId)}: ${esc(r.engineLimit)}
    <br><code>${esc((r.engineLimitDetail || '').replace(/\s+/g, ' ').slice(0, 160))}</code></li>`;
}
const blocked = data.records.filter(r => !r.valid && !r.engineLimit);
const blockedItems = [...new Set(blocked.map(r => `${r.engine} @ ${r.pointId}: ${r.gateReasons?.join('; ')}`))]
  .map(t => `<li>${esc(t)}</li>`).join('');

const env = data.env || {};
const invalidCount = data.records.filter(r => !r.valid).length;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>three.js / Babylon.js / PlayCanvas Benchmark — ${esc(batchId)}</title>
<style>
:root{--fg:#1a1a1a;--dim:#666;--line:#e2e2e2;--ok:#0a7a3d;--warn:#a86400;--bad:#c0392b}
*{box-sizing:border-box}
body{font:14px/1.6 -apple-system,"Helvetica Neue",Arial,sans-serif;color:var(--fg);max-width:1080px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:36px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--fg)}
h3{font-size:15px;margin:26px 0 6px}h3 .ax{font-weight:400;font-size:12px;color:var(--dim)}
table{border-collapse:collapse;width:100%;margin:10px 0;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:5px 9px;text-align:right}
th{background:#fafafa;font-weight:600;text-align:center;font-size:12px}
td.cs,td.ax,td.v{text-align:left}td.v{font-weight:600}
td.ok{color:var(--ok)}td.warn{color:var(--warn)}td.bad{color:var(--bad);font-weight:600}
td.na,td.lim{color:var(--dim);font-size:12px;text-align:center}
td.lim{color:var(--bad)}
td.dim{color:var(--dim);font-size:12px}
td.diff{color:var(--warn)}
td.sat{color:var(--dim)}
tr.grp td{text-align:left;background:#f2f4f7;font-weight:600;font-size:12px;letter-spacing:.04em}
.meta{color:var(--dim);font-size:12px;margin:0 0 2px}
.note{color:var(--dim);font-size:12px;margin:4px 0}
.fixed{font-size:12px;color:var(--dim);margin:2px 0 6px}
.warnbox{border-left:3px solid var(--warn);background:#fffdf7;padding:9px 12px;margin:12px 0;color:var(--fg)}
.warnbox ul{margin:5px 0;padding-left:20px}
.caveat{border-left:3px solid var(--bad);background:#fdf6f5;padding:10px 13px;margin:14px 0}
table.lit{width:auto}table.lit th,table.lit td{padding:3px 12px}
code{font:11px ui-monospace,Menlo,monospace;color:var(--dim)}
ul{padding-left:22px}li{margin:3px 0}
.legend{font-size:11px;color:var(--dim);margin-top:6px}
</style></head><body>

<h1>three.js / Babylon.js / PlayCanvas Benchmark</h1>
<p class="meta">Batch <code>${esc(batchId)}</code>
  · ${data.runConfig?.durationMs / 1000}s per run × ${data.runConfig?.repeats} repeat
  · valid ${data.records.length - invalidCount}/${data.records.length}</p>
<p class="meta">${esc(env.machine || '')} · ${esc(env.gpu?.renderer || '')}</p>
<p class="meta">three ${esc(env.engineVersions?.three)} · Babylon ${esc(env.engineVersions?.babylonjs)} · PlayCanvas ${esc(env.engineVersions?.playcanvas)}</p>

<div class="caveat">
<b>Scope: compare default engine behavior without aligning visual output.</b>
Each engine keeps its default rendering strategy, including tone mapping, color space, lighting architecture,
simultaneous-light limits, and culling. The harness aligns <b>scene inputs</b> such as object count, triangle count,
light count, and coverage multiplier. Visual differences are part of the result.
</div>

<h2>Scope</h2>
<p class="note">Cases are grouped by common game-engine bottlenecks. Each case varies one primary input.</p>
<table>
<thead><tr><th>Domain</th><th>Cases</th><th>Measured bottleneck</th></tr></thead>
<tbody>${domainsPresent.map(dom => `<tr>
  <td class="cs"><b>${esc(DOMAIN_META[dom].title)}</b></td>
  <td class="cs">${caseIds.filter(id => domainOf(id) === dom).map(esc).join(' · ')}</td>
  <td class="cs dim">${esc(DOMAIN_META[dom].note)}</td></tr>`).join('')}</tbody>
</table>

<h2>Capacity Summary</h2>
<p class="note"><b>Capacity</b> is the highest load whose p95 frame time remains within budget, using logarithmic
interpolation between adjacent rungs. A trailing <b>+</b> means every tested rung stayed within budget.</p>
<table>
<thead>
<tr><th rowspan="2">Case</th><th rowspan="2">Variable</th><th colspan="3">capacity@60 (≤16.6ms)</th><th colspan="3">capacity@30 (≤33.3ms)</th></tr>
<tr>${ENGINES.map(e => `<th>${e}</th>`).join('')}${ENGINES.map(e => `<th>${e}</th>`).join('')}</tr>
</thead>
<tbody>${capRows}</tbody>
</table>

<p class="legend">p95 colors: <span style="color:var(--ok)">green ≤16.6ms (60 FPS)</span> ·
<span style="color:var(--warn)">orange ≤33.3ms (30 FPS)</span> ·
<span style="color:var(--bad)">red exceeds the 30 FPS budget</span>.
"Submitted/frame" is measured by the WebGL probe rather than engine statistics. Orange values differ across engines,
usually because of default culling behavior.</p>
<p class="note"><b>The default PBR fragment case is excluded from capacity ranking.</b>
Default shaders differ in features and visual quality; this case reports their GPU cost under heavy pixel coverage
and alpha blending.</p>
${domainSections}

<h2>Findings</h2>
${limitItems ? `<h3>Engine limits</h3><p class="note">The engine could not execute these load levels.</p><ul>${limitItems}</ul>` : ''}
${blockedItems ? `<h3>Runs blocked by the parity gate</h3><ul>${blockedItems}</ul>` : ''}
${!limitItems && !blockedItems ? '<p class="note">No engine limits or parity-gate failures were recorded.</p>' : ''}

<h2>Method</h2>
<ul>
<li><b>Shared source of truth:</b> all harnesses use the same geometry and layouts from <code>spec/</code>, with a seeded PRNG and no <code>Math.random</code>.</li>
<li><b>Measured submission:</b> draw calls and triangles come from a WebGL probe rather than engine-reported statistics.</li>
<li><b>Blocking parity gate:</b> real GPU, backbuffer size, equal inputs, sample count, visible output, and GPU timer validity must all pass.</li>
<li><b>GPU timing:</b> the PBR pixel case uses <code>EXT_disjoint_timer_query_webgl2</code>; unsupported, insufficient, or disjoint samples are invalid.</li>
<li><b>Steady state:</b> sampling starts after sliding-window p95 convergence; heavy cases may extend to reach the sample floor.</li>
<li><b>Run isolation:</b> every run receives a new browser context, page, WebGL context, and engine instance.</li>
<li><b>Headless with vsync disabled:</b> the GPU gate rejects software rendering, and disabling vsync exposes frame times above display refresh.</li>
</ul>

</body></html>`;

await writeFile(join(outDir, 'report.html'), html);
console.log(`[report] results/${batchId}/report.html`);
