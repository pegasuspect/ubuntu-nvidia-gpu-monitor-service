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
const dayListEl = document.getElementById('day-list');
const statsEl = document.getElementById('stats');
const chartEl = document.getElementById('chart');

let plot = null;
let manifest = [];

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', Boolean(isError));
}

function parseTimestamp(ts) {
  // nvidia-smi format: "2026-09-16 14:23:01.123", logged in the GPU service's TZ.
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/.exec(ts.trim());
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

// Axes layout: 3 on the left, 3 on the right, each with its own scale group.
function makeAxes() {
  const mk = (side) => ({
    size: (u, values) => values.filter((v) => v != null).length > 0
      ? values.filter((v) => v != null).reduce((a, b) => Math.max(a, String(b).length), 0) * 7 + 10
      : 0,
    values: (u, vals, space) => space > 40 ? vals : vals.map((v, i) => (i % 2 === 0 ? v : null)),
    [side ? 'side' : 'side']: side,
  });
  return [
    Object.assign(mk(3), { scale: 'c', label: 'Temp \u00b0C', labelSize: 14, stroke: '#d62728' }),
    Object.assign(mk(3), { scale: 'pct', label: 'Utilization %', labelSize: 14, stroke: '#1f77b4' }),
    Object.assign(mk(3), { scale: 'mem', label: 'Memory MiB', labelSize: 14, stroke: '#9467bd' }),
    Object.assign(mk(1), { scale: 'w', label: 'Power W', labelSize: 14, stroke: '#ff7f0e' }),
    Object.assign(mk(1), { scale: 'clk', label: 'Clocks MHz', labelSize: 14, stroke: '#2ca02c' }),
    Object.assign(mk(1), {
      scale: 'clk', show: false, size: 0,
    }),
  ];
}

// Wheel zoom plugin (keeps x under cursor anchored), no extra deps.
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
          const lft = u.posToVal(x, 'x');
          const [min, max] = u.scales.x.range(u, u.data[0][0], u.data[0][u.data[0].length - 1]);
          const scale = e.deltaY < 0 ? 1 / factor : factor;
          const mid = lft;
          const half = (max - min) / 2 * scale;
          const lo = mid - half * ((mid - min) / (max - min) * 2);
          const hi = lo + (max - min) * scale;
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

  const series = [
    { label: 'time' },
    ...SERIES_DEF.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: 1,
      scale: s.scale,
      points: { show: false },
      spanGaps: false,
    })),
  ];

  const opts = {
    width: chartEl.clientWidth,
    height: Math.max(360, window.innerHeight - chartEl.getBoundingClientRect().top - 80),
    title: 'GPU telemetry',
    series,
    axes: makeAxes(),
    plugins: [wheelZoomPlugin()],
    cursor: { drag: { x: true, y: false } },
    legend: { show: true },
    tzDate: (ts) => new Date(ts * 1000),
    fmtDate: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
  };

  plot = new uPlot(opts, [data.times, ...data.cols], chartEl);
}

async function loadSelected() {
  const checked = [...dayListEl.querySelectorAll('input:checked')].map((i) => i.value);
  if (checked.length === 0) {
    setStatus('Select at least one day to load.', true);
    return;
  }
  setStatus(`Loading ${checked.length} day(s)\u2026`);
  try {
    const days = [];
    for (const name of checked) {
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
    setStatus(`Showing ${checked.length} day(s), ${pointCount.toLocaleString()} samples.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

function renderDayList() {
  dayListEl.innerHTML = '';
  manifest.forEach((name, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = i === manifest.length - 1; // default: latest day
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name.replace(/^gpu-test-|\.csv$/g, '')));
    dayListEl.appendChild(label);
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
    renderDayList();
    setStatus(`${manifest.length} day(s) available. Select and press Load.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

document.getElementById('select-all').addEventListener('click', () => {
  dayListEl.querySelectorAll('input').forEach((i) => { i.checked = true; });
});
document.getElementById('latest-only').addEventListener('click', () => {
  dayListEl.querySelectorAll('input').forEach((i, _, all) => { i.checked = i === all[all.length - 1]; });
});
document.getElementById('load').addEventListener('click', loadSelected);
document.getElementById('reset-zoom').addEventListener('click', () => {
  if (plot) plot.setScale('x', {});
});
window.addEventListener('resize', () => {
  if (plot) plot.setSize({ width: chartEl.clientWidth, height: plot.height });
});

init();