'use strict';

// CSV columns produced by gpu-monitor.sh, in order.
const SERIES_DEF = [
  { key: 'temperature.gpu',  label: 'Temp (\u00b0C)',    color: '#d62728', scale: 'c',   unit: '\u00b0C' },
  { key: 'utilization.gpu',  label: 'Utilization (%)',   color: '#1f77b4', scale: 'pct', unit: '%'     },
  { key: 'memory.used',      label: 'Memory (MiB)',      color: '#9467bd', scale: 'mem', unit: 'MiB'  },
  { key: 'power.draw',       label: 'Power (W)',         color: '#ff7f0e', scale: 'w',   unit: 'W'     },
  { key: 'clocks.gr',        label: 'Graphics clock (MHz)', color: '#2ca02c', scale: 'clk', unit: 'MHz' },
  { key: 'clocks.mem',       label: 'Memory clock (MHz)',  color: '#8c564b', scale: 'clk', unit: 'MHz' },
];

const statusEl = document.getElementById('status');
const rangePickerEl = document.getElementById('range-picker');
const rangeListEl = document.getElementById('range-list');
const statsEl = document.getElementById('stats');
const chartEl = document.getElementById('chart');

let plot = null;
let manifest = [];
let picker = null;
// Selected date ranges as {start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'}.
let ranges = [];

// Raw merged data of the currently loaded day(s); stats always use this.
let rawData = null;
// Currently active display step in ms (null = raw 1s samples).
let currentStepMs = null;
// A data swap is pending on the next commit; set by refreshStep.
let stepSwapQueued = false;
// Base status text for the current load (day count, total samples).
let baseStatus = '';

// Display step ladder: RAW(1s) -> 5s -> 15s -> 1m -> 5m -> 15m -> 1h.
const STEP_LADDER = [1000, 5000, 15000, 60000, 300000, 900000, 3600000];

function setStatus(text, isError) {
  isError = Boolean(isError);
  statusEl.textContent = text;
  statusEl.classList.toggle('error', Boolean(isError));
}

function parseTimestamp(ts) {
  // Two historical formats from nvidia-smi:
  //   ISO-8601 with offset: "2026-07-28T17:02:17-04:00" (July 28-30 logs)
  //   Space-separated local: "2026-09-16 14:23:01.123" (Aug 3 onward)
  const s = ts.trim();
  if (s.includes('T')) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? NaN : t;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/.exec(s);
  if (!m) return NaN;
  const ms = m[7] ? Number(m[7]) : 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime();
}

function parseValue(v) {
  const t = v.trim();
  if (t === '' || t === 'N/A' || t === '[N/A]' || t === '[Not Supported]') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { times: [], cols: [] };

  const headers = lines[0].split(',').map((h) => h.trim());
  const idx = {};
  for (let i = 0; i < headers.length; i++) idx[headers[i]] = i;

  for (const s of SERIES_DEF) {
    if (!(s.key in idx)) {
      throw new Error(`CSV is missing column "${s.key}"`);
    }
  }

  const times = [];
  const cols = SERIES_DEF.map(() => []);
  const ti = idx['time'];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const t = parseTimestamp(cells[ti] || '');
    if (!Number.isFinite(t)) continue;
    times.push(t);
    SERIES_DEF.forEach((s, j) => {
      cols[j].push(parseValue(cells[idx[s.key]] || ''));
    });
  }
  return { times, cols };
}

function mergeDays(days) {
  const sorted = [...days].sort((a, b) => a.times[0] - b.times[0]);
  const times = [];
  const cols = SERIES_DEF.map(() => []);
  for (const d of sorted) {
    for (let i = 0; i < d.times.length; i++) times.push(d.times[i]);
    d.cols.forEach((c, j) => { cols[j].push(...c); });
  }
  return { times, cols };
}

// Average raw samples into fixed-size buckets. Buckets align to step
// boundaries and cover every bucket in the loaded span; buckets without
// samples yield null so off/freeze gaps stay visible.
function aggregate(data, stepMs) {
  if (!data || data.times.length === 0) return { times: [], cols: SERIES_DEF.map(() => []) };

  const times = [];
  const cols = SERIES_DEF.map(() => []);

  const firstBucket = data.times[0] - (data.times[0] % stepMs);
  const lastBucket = data.times[data.times.length - 1] - (data.times[data.times.length - 1] % stepMs);

  const sums = SERIES_DEF.map(() => 0);
  const counts = SERIES_DEF.map(() => 0);
  let i = 0;
  const n = data.times.length;

  for (let b = firstBucket; b <= lastBucket; b += stepMs) {
    while (i < n && data.times[i] < b + stepMs) {
      for (let j = 0; j < SERIES_DEF.length; j++) {
        const v = data.cols[j][i];
        if (v != null) {
          sums[j] += v;
          counts[j]++;
        }
      }
      i++;
    }
    times.push(b + stepMs / 2); // bucket center
    for (let j = 0; j < SERIES_DEF.length; j++) {
      cols[j].push(counts[j] > 0 ? sums[j] / counts[j] : null);
      sums[j] = 0;
      counts[j] = 0;
    }
  }
  return { times, cols };
}

function displayData() {
  if (currentStepMs == null) return rawData;
  return aggregate(rawData, currentStepMs);
}

// Smallest display step keeping visible samples at <= ~2 per pixel of width.
// Returns null when raw 1s data already fits (raw display).
function pickStep(visibleMs, chartWidthPx) {
  const totalMs = rawData ? rawData.times[rawData.times.length - 1] - rawData.times[0] : 0;
  const span = Math.min(visibleMs, totalMs);
  if (span <= chartWidthPx * 2 * 1000) return null; // raw 1s samples fit
  for (const step of STEP_LADDER) {
    if (step > 1000 && span / step <= chartWidthPx * 2) return step;
  }
  return STEP_LADDER[STEP_LADDER.length - 1];
}

function stepLabel(stepMs) {
  if (stepMs == null) return 'raw 1s samples';
  if (stepMs < 60000) return `${stepMs / 1000}-sec buckets`;
  if (stepMs < 3600000) return `${stepMs / 60000}-min buckets`;
  return `${stepMs / 3600000}-hour buckets`;
}

function updateStatusBadge() {
  setStatus(baseStatus + (baseStatus ? ' \u00b7 ' : '') + stepLabel(currentStepMs));
}

// Check the step ladder for the current visible range. The actual data swap is
// deferred to a microtask AFTER the current commit finishes, then re-commits
// explicitly: swapping inside the setScale hook leaves y-scales stale for one
// frame (flicker), and setData(..., false) alone never queues a redraw.
function refreshStep() {
  if (!plot || !rawData || stepSwapQueued) return;
  const xMin = plot.scales.x.min;
  const xMax = plot.scales.x.max;
  if (xMin == null || xMax == null) return;
  const step = pickStep(xMax - xMin, chartEl.clientWidth);
  if (step === currentStepMs) return;

  stepSwapQueued = true;
  const lo = xMin;
  const hi = xMax;
  queueMicrotask(() => {
    stepSwapQueued = false;
    if (!plot || step === currentStepMs) return; // re-check after the commit
    currentStepMs = step;
    const data = displayData();
    plot.setData([data.times, ...data.cols], false); // false: keep zoom range
    plot.setScale('x', { min: lo, max: hi }); // explicit commit: redraw with fresh y-scales
    updateStatusBadge();
  });
}

function computeStats(data) {
  return SERIES_DEF.map((s, j) => {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (const v of data.cols[j]) {
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n++;
    }
    return n ? { min, max, avg: sum / n, n } : { min: null, max: null, avg: null, n: 0 };
  });
}

function renderStats(data) {
  const stats = computeStats(data);
  statsEl.innerHTML = '';
  SERIES_DEF.forEach((s, j) => {
    const st = stats[j];
    const card = document.createElement('div');
    card.className = 'stat-card';
    const fmt = (v) => (v == null ? '\u2014' : v.toFixed(1));
    card.innerHTML =
      `<h3><span style="color:${s.color}">\u25cf</span> ${s.label}</h3>` +
      `<div class="row"><span>min</span><b>${fmt(st.min)}</b></div>` +
      `<div class="row"><span>avg</span><b>${fmt(st.avg)}</b></div>` +
      `<div class="row"><span>max</span><b>${fmt(st.max)}</b></div>`;
    statsEl.appendChild(card);
  });
}

// Axes layout: x (time) axis first, then y-axes grouped by scale.
function makeAxes() {
  const mk = (side) => ({
    size: (u, values) => {
      const vals = (values || []).filter((v) => v != null);
      return vals.length > 0 ? vals.reduce((a, b) => Math.max(a, String(b).length), 0) * 7 + 10 : 0;
    },
    values: (u, vals, space) => space > 40 ? vals : vals.map((v, i) => (i % 2 === 0 ? v : null)),
    side,
  });
  return [
    {}, // x time axis: all defaults from uPlot
    Object.assign(mk(3), { scale: 'c', label: 'Temp \u00b0C', labelSize: 14, stroke: '#d62728' }),
    Object.assign(mk(3), { scale: 'pct', label: 'Utilization %', labelSize: 14, stroke: '#1f77b4' }),
    Object.assign(mk(3), { scale: 'mem', label: 'Memory MiB', labelSize: 14, stroke: '#9467bd' }),
    Object.assign(mk(1), { scale: 'w', label: 'Power W', labelSize: 14, stroke: '#ff7f0e' }),
    Object.assign(mk(1), { scale: 'clk', label: 'Clocks MHz', labelSize: 14, stroke: '#2ca02c' }),
  ];
}

// Wheel zoom plugin: Ctrl/Cmd + scroll zooms the x-scale around the cursor,
// keeping the cursor's relative position fixed. No extra deps.
function wheelZoomPlugin(opts) {
  const factor = (opts && opts.factor) || 0.9;
  return {
    hooks: {
      ready(u) {
        const over = u.over;
        over.style.cursor = 'crosshair';
        let rect = over.getBoundingClientRect();
        const px = (e) => {
          rect = over.getBoundingClientRect();
          return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        };
        over.addEventListener('wheel', (e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          const { x } = px(e);
          const min = u.scales.x.min;
          const max = u.scales.x.max;
          if (min == null || max == null) return;
          const anchor = u.posToVal(x, 'x');
          const rel = (anchor - min) / (max - min); // 0..1 position under cursor
          // zoom-in (deltaY < 0) shrinks the span; zoom-out expands it
          const span = (max - min) * (e.deltaY < 0 ? factor : 1 / factor);
          const lo = anchor - rel * span;
          const hi = lo + span;
          u.setScale('x', { min: lo, max: hi });
        }, { passive: false });
      },
    },
  };
}

function makePlot(data) {
  if (plot) {
    plot.destroy();
    plot = null;
  }

  rawData = data;
  currentStepMs = pickStep(
    data.times[data.times.length - 1] - data.times[0],
    chartEl.clientWidth,
  );
  const disp = displayData();

  const series = [
    { label: 'time' },
    ...SERIES_DEF.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: 1,
      scale: s.scale,
      points: { show: false },
      spanGaps: false,
      paths: uPlot.paths.spline(),
    })),
  ];

  const opts = {
    ms: 1, // x values are ms-epoch; uPlot's default tzDate/fmtDate handle rendering
    width: chartEl.clientWidth,
    height: Math.max(360, (window.innerHeight - chartEl.getBoundingClientRect().top - 80) / 2),
    title: 'GPU telemetry',
    series,
    axes: makeAxes(),
    plugins: [wheelZoomPlugin()],
    cursor: { drag: { x: true, y: false } },
    legend: { show: true },
    hooks: {
      setScale: [
        (u, key) => {
          if (key === 'x') refreshStep();
        },
      ],
      ready: [
        () => refreshStep(),
      ],
    },
  };

  plot = new uPlot(opts, [disp.times, ...disp.cols], chartEl);

  // Regression guard: tick labels must be formatted dates, never raw templates.
  const badTicks = plot.axes.filter((a) => a._show !== false).filter((a) => {
    const vals = a.values(plot, [plot.scales[a.scale].min], 0, 100, 1000);
    return vals.some((v) => typeof v === 'string' && v.includes('{'));
  });
  if (badTicks.length > 0) {
    console.error('uPlot axis tick templates not compiled:', badTicks.map((a) => a.scale));
  }
}

async function loadSelected() {
  if (ranges.length === 0) {
    setStatus('Pick at least one date range to load.', true);
    return;
  }
  const { names, skipped } = expandRanges(ranges);
  if (names.length === 0) {
    setStatus('The selected range(s) contain no log files.', true);
    return;
  }
  setStatus(`Loading ${names.length} day(s)\u2026`);
  try {
    const days = [];
    for (const name of names) {
      const res = await fetch(`graphs/data/${name}`);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const day = parseCsv(await res.text());
      if (day.times.length === 0) throw new Error(`${name}: no data rows`);
      days.push(day);
    }
    const data = mergeDays(days);
    if (data.times.length === 0) throw new Error('No usable data found.');
    makePlot(data);
    renderStats(data);
    const pointCount = data.times.length;
    baseStatus = `Showing ${ranges.length} range(s), ${names.length} day(s), ${pointCount.toLocaleString()} samples.`;
    if (skipped.length > 0) {
      const cap = skipped.slice(0, 5).join(', ');
      const extra = skipped.length > 5 ? `, +${skipped.length - 5} more` : '';
      baseStatus += ` No log: ${cap}${extra}.`;
    }
    updateStatusBadge();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

// ---- Date-range state & helpers ----

function dayName(dateStr) {
  return `gpu-test-${dateStr}.csv`;
}

// 'YYYY-MM-DD' day strings for a range, inclusive.
function rangeDays(range) {
  const out = [];
  const d = new Date(`${range.start}T00:00:00`);
  const end = new Date(`${range.end}T00:00:00`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Expand ranges into available manifest filenames, skipping days with no log.
// Returns { names, skipped } with names sorted ascending and deduped.
function expandRanges(rangeList) {
  const have = new Set(manifest);
  const names = new Set();
  const skipped = new Set();
  for (const r of rangeList) {
    for (const day of rangeDays(r)) {
      if (have.has(dayName(day))) names.add(dayName(day));
      else skipped.add(day);
    }
  }
  return {
    names: [...names].sort(),
    skipped: [...skipped].sort(),
  };
}

function renderRangeList() {
  rangeListEl.innerHTML = '';
  ranges.forEach((r, i) => {
    const chip = document.createElement('div');
    chip.className = 'range-chip';
    const label = document.createElement('span');
    label.textContent = r.start === r.end ? r.start : `${r.start} \u2192 ${r.end}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '\u2715';
    del.title = 'Remove range';
    del.addEventListener('click', () => {
      ranges.splice(i, 1);
      renderRangeList();
      syncPicker();
    });
    chip.appendChild(label);
    chip.appendChild(del);
    rangeListEl.appendChild(chip);
  });
}

// Keep the picker's highlights in sync with the committed ranges.
function syncPicker() {
  if (!picker) return;
  picker.setOptions({
    highlightedDays: ranges.map((r) => [r.start, r.end]),
  });
}

function initPicker() {
  const minDate = manifest[0].replace(/^gpu-test-|\.csv$/g, '');
  const maxDate = manifest[manifest.length - 1].replace(/^gpu-test-|\.csv$/g, '');
  const have = new Set(manifest);

  picker = new Litepicker({
    element: rangePickerEl,
    inlineMode: true,
    singleMode: false,
    numberOfMonths: 1,
    minDate,
    maxDate,
    lockDaysFilter: (date1, date2) => {
      // Lock days that have no log file (e.g. days the system was off).
      if (date1 && date2 == null) {
        return !have.has(dayName(date1.format('YYYY-MM-DD')));
      }
      return false;
    },
    setup: (p) => {
      p.on('selected', (start, end) => {
        if (!start || !end) return; // wait for the range's second click
        ranges.push({ start: start.format('YYYY-MM-DD'), end: end.format('YYYY-MM-DD') });
        renderRangeList();
        syncPicker();
        p.clearSelection();
      });
    },
  });
}

async function init() {
  try {
    const res = await fetch('graphs/data/manifest.json');
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
    manifest = await res.json();
    if (!Array.isArray(manifest) || manifest.length === 0) {
      throw new Error('No CSV files in manifest. Run graphs/copy-logs.sh first.');
    }
    initPicker();
    // Auto-load the latest day so the page starts with a chart, matching the
    // "Latest only" + "Load" button sequence.
    const last = manifest[manifest.length - 1].replace(/^gpu-test-|\.csv$/g, '');
    ranges = [{ start: last, end: last }];
    renderRangeList();
    syncPicker();
    await loadSelected();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

document.getElementById('select-all').addEventListener('click', () => {
  if (manifest.length === 0) return;
  const first = manifest[0].replace(/^gpu-test-|\.csv$/g, '');
  const last = manifest[manifest.length - 1].replace(/^gpu-test-|\.csv$/g, '');
  ranges = [{ start: first, end: last }];
  renderRangeList();
  syncPicker();
});
document.getElementById('latest-only').addEventListener('click', () => {
  if (manifest.length === 0) return;
  const last = manifest[manifest.length - 1].replace(/^gpu-test-|\.csv$/g, '');
  ranges = [{ start: last, end: last }];
  renderRangeList();
  syncPicker();
});
document.getElementById('clear-ranges').addEventListener('click', () => {
  ranges = [];
  renderRangeList();
  syncPicker();
});
document.getElementById('load').addEventListener('click', loadSelected);
document.getElementById('reset-zoom').addEventListener('click', () => {
  if (plot && rawData && rawData.times.length > 0) {
    plot.setScale('x', {
      min: rawData.times[0],
      max: rawData.times[rawData.times.length - 1],
    });
  }
});
window.addEventListener('resize', () => {
  if (plot) {
    plot.setSize({ width: chartEl.clientWidth, height: plot.height });
    refreshStep(); // bucket density depends on chart width
  }
});

init();