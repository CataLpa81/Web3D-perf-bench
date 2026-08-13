// Generate a compact, self-contained HTML report.
//
// Usage: node runner/report.mjs [batchId]
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolateCapacity } from '../spec/cases.js';

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
if (data.schemaVersion !== 2 || !data.benchmarkSpec) {
  console.error(`[report] results/${batchId}/raw-results.json does not match the required result schema`);
  process.exit(1);
}

const ENGINES = ['three', 'babylon', 'playcanvas'];
const CASE_MATRIX = data.benchmarkSpec.cases;
const DOMAIN_MATRIX = data.benchmarkSpec.domains;
const DOMAIN_SEQUENCE = data.benchmarkSpec.domainOrder;
const BUDGETS = data.benchmarkSpec.vsyncBudget;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '–' : n.toFixed(d));
const bigNum = (n) => {
  if (n == null) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k';
  return String(n);
};

function metricOf(caseId, record) {
  const mode = CASE_MATRIX[caseId]?.primaryMetric || 'cpu';
  if (mode === 'gpu') return record.info?.gpuFrame || null;
  if (mode === 'bottleneck') {
    const cpu = record.info?.cpuFrame || record.info?.frame;
    const gpu = record.info?.gpuFrame;
    if (!cpu || !gpu) return null;
    return {
      p50: Math.max(cpu.p50 ?? 0, gpu.p50 ?? 0),
      p95: Math.max(cpu.p95 ?? 0, gpu.p95 ?? 0),
      p99: Math.max(cpu.p99 ?? 0, gpu.p99 ?? 0),
      mean: Math.max(cpu.mean ?? 0, gpu.mean ?? 0),
      frameCount: Math.min(cpu.frameCount || 0, gpu.frameCount || 0),
      source: (gpu.p95 ?? 0) >= (cpu.p95 ?? 0) ? 'gpu' : 'cpu',
    };
  }
  return record.info?.cpuFrame || record.info?.frame || null;
}

// Aggregate p95 across repeated runs and retain the median record for diagnostics.
function pick(caseId, value, engine) {
  const rs = data.records.filter(r => r.caseId === caseId && r.value === value && r.engine === engine);
  if (!rs.length) return null;
  const limited = rs.find(r => r.engineLimit);
  const mode = CASE_MATRIX[caseId]?.primaryMetric || 'cpu';
  const valid = rs.filter(r => r.valid && metricOf(caseId, r)?.p95 != null);
  const invalid = rs.filter(r => !r.valid || metricOf(caseId, r)?.p95 == null);
  if (invalid.length) {
    const failures = [...new Set(invalid.flatMap(r => r.gateReasons || []))].join('; ');
    const inferredLimit = invalid.some(r => /Aborted\(OOM\)|out of memory/i.test(
      [r.state?.error, ...(r.consoleErrors || [])].filter(Boolean).join(' ')))
      ? 'OUT_OF_MEMORY'
      : null;
    return {
      limit: limited?.engineLimit || inferredLimit,
      invalid: failures || 'One or more repeats are invalid.',
      partial: valid.length > 0,
      repeats: valid.length,
      expectedRepeats: rs.length,
    };
  }
  if (!valid.length) {
    return { limit: limited?.engineLimit || null, invalid: rs[0].gateReasons?.join('; ') || null };
  }
  const byP95 = [...valid].sort((a, b) => metricOf(caseId, a).p95 - metricOf(caseId, b).p95);
  const mid = byP95[Math.floor(byP95.length / 2)];
  const metric = metricOf(caseId, mid);
  const p95s = byP95.map(r => metricOf(caseId, r).p95);
  const meanP95 = p95s.reduce((sum, value_) => sum + value_, 0) / p95s.length;
  const variance = p95s.reduce((sum, value_) => sum + (value_ - meanP95) ** 2, 0) / p95s.length;
  return {
    p95: metric.p95, p50: metric.p50, p99: metric.p99,
    minP95: p95s[0], maxP95: p95s[p95s.length - 1],
    cv: meanP95 ? Math.sqrt(variance) / meanP95 : null,
    fps: metric.mean ? 1000 / metric.mean : null,
    frames: metric.frameCount,
    metric: mode,
    bottleneckSource: metric.source || null,
    drawCalls: mid.info.probe?.drawCalls, triangles: mid.info.probe?.triangles,
    policy: mid.info.actual?.lightPolicy, repeats: valid.length,
    cpuP95: mid.info.cpuFrame?.p95 ?? null,
    gpuP95: mid.info.gpuFrame?.p95 ?? null,
    intervalP95: mid.info.frame?.p95 ?? null,
  };
}

function p95Cell(rec) {
  if (!rec) return '<td class="na">–</td>';
  if (rec.limit) {
    const count = rec.expectedRepeats ? ` (${rec.repeats}/${rec.expectedRepeats} valid)` : '';
    return `<td class="lim" title="${esc(rec.invalid || rec.limit)}">${esc(rec.limit)}${count}</td>`;
  }
  if (rec.partial) {
    return `<td class="na" title="${esc(rec.invalid || '')}">Partial ${rec.repeats}/${rec.expectedRepeats}</td>`;
  }
  if (rec.p95 == null) return `<td class="na" title="${esc(rec.invalid || '')}">Invalid</td>`;
  const cls = rec.p95 <= BUDGETS.fps60 ? 'ok' : (rec.p95 <= BUDGETS.fps30 ? 'warn' : 'bad');
  const range = rec.repeats > 1
    ? `<br><span class="dim">${fmt(rec.minP95)}–${fmt(rec.maxP95)} · CV ${fmt((rec.cv || 0) * 100, 0)}%</span>`
    : '';
  const source = rec.bottleneckSource ? `<br><span class="dim">limited by ${rec.bottleneckSource}</span>` : '';
  return `<td class="${cls}">${fmt(rec.p95)}${range}${source}</td>`;
}

const DOMAIN_META = {
  ...DOMAIN_MATRIX,
  unknown: { title: 'Unclassified cases', note: 'Case metadata is unavailable.' },
};
const ORDER = [...DOMAIN_SEQUENCE, 'unknown'];
const domainOf = (caseId) => (CASE_MATRIX[caseId]?.domain && DOMAIN_MATRIX[CASE_MATRIX[caseId].domain]) ? CASE_MATRIX[caseId].domain : 'unknown';

// Sort by domain, then by declaration order.
const declOrder = Object.keys(CASE_MATRIX);
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
    const c = CASE_MATRIX[caseId];
    const cap = data.capacities[caseId];
    const cell = (eng, key) => {
      const budget = key === 'at60' ? BUDGETS.fps60 : BUDGETS.fps30;
      const d = cap[eng]?.rungs
        ? interpolateCapacity(cap[eng].rungs.map(rung => ({
            ...rung,
            complete: rung.complete ?? rung.repeats === data.runConfig?.repeats,
          })), budget)
        : cap[eng]?.[key];
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
  const c = CASE_MATRIX[caseId];
  const ladder = c?.ladder
    || [...new Set(data.records.filter(r => r.caseId === caseId).map(r => r.value))].sort((a, b) => a - b);
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
  let extra = '';
  if (caseId === 'lights') {
    const pol = ENGINES.map(e => {
      const r = ladder.map(v => pick(caseId, v, e)).find(x => x?.policy);
      return `<li><b>${e}</b>: ${esc(r?.policy || '–')}</li>`;
    }).join('');
    extra = `<div class="note warnbox">
      <b>Do not quote the timing table without this context.</b>
      The engines use different default lighting policies, so the number of lights that reach the pixel shader differs:
      <ul>${pol}</ul>
      This case describes product defaults and is excluded from capacity ranking. Use <code>lights-forward</code>
      for a parity-gated forward-light workload.
    </div>`;
  }
  const fixed = c?.fixed ? Object.entries(c.fixed).map(([k, v]) => `${k}=${v}`).join(' · ') : '';
  const metricLabel = c?.primaryMetric === 'gpu'
    ? 'GPU'
    : (c?.primaryMetric === 'bottleneck' ? 'CPU/GPU bottleneck' : 'CPU tick');
  const dom = domainOf(caseId);
  (sectionsByDomain[dom] ??= []).push(`<section>
    <h3>${esc(caseId)} <span class="ax">variable: ${esc(c?.axis || '—')} · ${esc(c?.suite || 'normalized-workload')}</span></h3>
    <p class="note">${esc(c?.note || '')}</p>
    ${fixed ? `<p class="fixed">Fixed: ${esc(fixed)}</p>` : ''}
    <table>
      <thead>
        <tr><th rowspan="2">${esc(c?.axis || 'Load')}</th><th colspan="3">${metricLabel} p95 (ms)</th><th colspan="3">Throughput equivalent</th><th rowspan="2">Submitted/frame</th></tr>
        <tr>${ENGINES.map(e => `<th>${e}</th>`).join('')}${ENGINES.map(e => `<th class="dim">${e}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">Repeated runs show min–max and coefficient of variation. Timer callback interval is diagnostic only.</p>
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
const unstableItems = [];
for (const caseId of caseIds) {
  const ladder = [...new Set(data.records.filter(r => r.caseId === caseId).map(r => r.value))];
  for (const value of ladder) {
    for (const engine of ENGINES) {
      const rec = pick(caseId, value, engine);
      if (rec?.repeats > 1 && rec.cv > 0.1) {
        unstableItems.push(`<li><b>${esc(engine)}</b> at ${esc(caseId)}@${esc(value)}: CV ${fmt(rec.cv * 100, 1)}%</li>`);
      }
    }
  }
}

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
<p class="meta">commit <code>${esc(data.provenance?.gitCommit || 'not recorded')}</code>
  · dirty ${esc(data.provenance?.gitDirty ?? 'unknown')} · schema ${esc(data.schemaVersion)}</p>

<div class="caveat">
<b>Scope: normalized workloads and default-behavior workloads are separate.</b>
Normalized cases parity-gate submitted work and relevant render settings. Default-behavior cases preserve
engine policy differences and are excluded from cross-engine capacity rankings.
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
<p class="note"><b>Capacity</b> is the highest tested load whose selected p95 metric remains within budget.
No value is interpolated between sparse rungs. A trailing <b>+</b> means every tested rung passed.</p>
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
and should only occur in default-behavior cases.</p>
<p class="note"><b>The default PBR fragment case is excluded from capacity ranking.</b>
Default shaders differ in features and visual quality; this case reports their GPU cost under heavy pixel coverage
and alpha blending.</p>
${domainSections}

<h2>Findings</h2>
${limitItems ? `<h3>Engine limits</h3><p class="note">The engine could not execute these load levels.</p><ul>${limitItems}</ul>` : ''}
${blockedItems ? `<h3>Runs blocked by the parity gate</h3><ul>${blockedItems}</ul>` : ''}
${unstableItems.length ? `<h3>High repeat variance</h3><p class="note">CV above 10%; treat local rankings as unstable.</p><ul>${unstableItems.join('')}</ul>` : ''}
${!limitItems && !blockedItems && !unstableItems.length ? '<p class="note">No engine limits, parity-gate failures, or high-variance points were recorded.</p>' : ''}

<h2>Method</h2>
<ul>
<li><b>Shared source of truth:</b> all harnesses use the same geometry and layouts from <code>spec/</code>, with a seeded PRNG and no <code>Math.random</code>.</li>
<li><b>Measured submission:</b> draw calls and triangles come from a WebGL probe rather than engine-reported statistics.</li>
<li><b>Blocking parity gate:</b> real GPU, backbuffer size, equal inputs, sample count, visible output, and GPU timer validity must all pass.</li>
<li><b>GPU timing:</b> GPU-timed cases use asynchronous backpressure with <code>EXT_disjoint_timer_query_webgl2</code>; the next frame waits for the current query result, and unsupported, insufficient, skipped, or disjoint samples are invalid.</li>
<li><b>CPU timing:</b> CPU p95 measures the synchronous update-and-render submission call; timer callback intervals are diagnostic only.</li>
<li><b>Steady state:</b> sampling starts after a minimum warmup and three converged CPU-p95 windows; heavy cases may extend to reach the sample floor.</li>
<li><b>Run order:</b> load points are deterministically shuffled per repeat and engine order is counterbalanced.</li>
<li><b>Provenance:</b> schema-v2 results embed the complete case matrix, contract, commit, lockfile hash, and browser environment.</li>
<li><b>Run isolation:</b> every run receives a new browser context, page, WebGL context, and engine instance.</li>
<li><b>Headless with vsync disabled:</b> the GPU gate rejects software rendering, and disabling vsync exposes frame times above display refresh.</li>
</ul>

</body></html>`;

await writeFile(join(outDir, 'report.html'), html);
console.log(`[report] results/${batchId}/report.html`);
