// Every chart on the dashboard, on Chart.js. One axis per chart, thin marks,
// quiet grids, and a tooltip on hover; text stays in the ink colors and the
// marks carry the series colors.
import { Chart, BarController, LineController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler } from 'chart.js';
import { fmt, tick, day, fullDay, hour } from './format.js';

Chart.register(BarController, LineController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler);

export const INK = { surface: '#1a1a19', grid: '#2c2c2a', axis: '#383835', text: '#f0efec', text2: '#c3c2b7', muted: '#898781' };
/** Series colors, given out in this order and never by rank (validated for the dark surface). */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];

Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.color = INK.muted;
Chart.defaults.animation = false;
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

const alive = new Set();
export function destroyCharts() { for (const c of alive) c.destroy(); alive.clear(); }
function make(canvas, config) { const c = new Chart(canvas, config); alive.add(c); return c; }

const tooltip = (extra = {}) => ({
  backgroundColor: '#262624', titleColor: INK.text, bodyColor: INK.text2, footerColor: INK.muted, borderColor: INK.axis, borderWidth: 1,
  padding: 10, cornerRadius: 6, boxPadding: 5, usePointStyle: true, titleFont: { weight: '600' }, footerFont: { weight: '400' }, ...extra,
});
const xDays = (dates, show = true) => ({
  grid: { display: false }, border: { color: INK.axis },
  ticks: { display: show, maxRotation: 0, autoSkipPadding: 18, callback(v) { return day(dates[v]); } },
});
const yCount = (format, { max, whole } = {}) => ({
  beginAtZero: true, max, grid: { color: INK.grid, lineWidth: 1 }, border: { display: false },
  ticks: { maxTicksLimit: 5, precision: whole ? 0 : undefined, callback: (v) => tick(v, format) },
});

// A hairline at the hovered day, so a value can be read down to the axis.
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { ctx, chartArea: a } = chart, x = active[0].element.x;
    ctx.save(); ctx.strokeStyle = INK.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke(); ctx.restore();
  },
};

// Each line's name at its last point, so the series is never told by color alone.
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: a } = chart, spots = [];
    chart.data.datasets.forEach((ds, i) => {
      const pts = chart.getDatasetMeta(i).data;
      for (let j = pts.length - 1; j >= 0; j--) if (ds.data[j] != null) { spots.push({ x: pts[j].x, y: pts[j].y, text: ds.label }); break; }
    });
    spots.sort((p, q) => p.y - q.y);
    for (let i = 1; i < spots.length; i++) if (spots[i].y - spots[i - 1].y < 14) spots[i].y = spots[i - 1].y + 14;
    ctx.save(); ctx.font = `12px ${Chart.defaults.font.family}`; ctx.fillStyle = INK.text2; ctx.textBaseline = 'middle';
    for (const s of spots) ctx.fillText(s.text, Math.min(s.x + 8, a.right + 8), Math.min(Math.max(s.y, a.top + 6), a.bottom - 6));
    ctx.restore();
  },
};

// The value at the end of each horizontal bar.
const barValues = {
  id: 'barValues',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart, bars = chart.getDatasetMeta(0).data;
    ctx.save(); ctx.font = `12px ${Chart.defaults.font.family}`; ctx.fillStyle = INK.text2; ctx.textBaseline = 'middle';
    bars.forEach((bar, i) => ctx.fillText(opts.text(i), bar.x + 8, bar.y));
    ctx.restore();
  },
};

/** One measure a day, as bars. */
export function dayBars(canvas, { dates, values, format, label, color = SERIES[0], showDates = true }) {
  return make(canvas, {
    type: 'bar',
    data: { labels: dates, datasets: [{ label, data: values, backgroundColor: color, borderRadius: { topLeft: 4, topRight: 4 }, maxBarThickness: 24, categoryPercentage: 0.86, barPercentage: 0.9 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: xDays(dates, showDates), y: yCount(format, { whole: format === 'int' }) },
      plugins: { tooltip: tooltip({ callbacks: { title: (it) => fullDay(dates[it[0].dataIndex]), label: (it) => ` ${label}: ${fmt(it.raw, format)}` } }) },
    },
  });
}

/** A measure a day split by series, stacked, with a gap of surface between the pieces. */
export function stackedDayBars(canvas, { dates, series, format }) {
  return make(canvas, {
    type: 'bar',
    data: { labels: dates, datasets: series.map((s, i) => ({ label: s.label, data: s.values, backgroundColor: s.color || SERIES[i % SERIES.length], borderColor: INK.surface, borderWidth: { top: 2 }, borderRadius: 2, maxBarThickness: 24, categoryPercentage: 0.86, barPercentage: 0.9 })) },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ...xDays(dates), stacked: true }, y: { ...yCount(format), stacked: true } },
      plugins: { tooltip: tooltip({ callbacks: { title: (it) => fullDay(dates[it[0].dataIndex]), label: (it) => ` ${it.dataset.label}: ${fmt(it.raw, format)}`, footer: (it) => (it.length > 1 ? `Total ${fmt(it.reduce((a, x) => a + (x.raw || 0), 0), format)}` : '') } }) },
    },
  });
}

/** Counts of people a day, one line a series, on one shared axis. */
export function dayLines(canvas, { dates, series, format = 'int' }) {
  return make(canvas, {
    type: 'line',
    data: { labels: dates, datasets: series.map((s, i) => ({ label: s.label, data: s.values, borderColor: SERIES[i], backgroundColor: SERIES[i], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12, pointHoverBorderColor: INK.surface, pointHoverBorderWidth: 2, tension: 0.25, spanGaps: false })) },
    options: {
      layout: { padding: { right: 96 } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: xDays(dates), y: yCount(format, { whole: true }) },
      plugins: { tooltip: tooltip({ callbacks: { title: (it) => fullDay(dates[it[0].dataIndex]), label: (it) => ` ${it.dataset.label}: ${fmt(it.raw, format)}` } }) },
    },
    plugins: [crosshair, endLabels],
  });
}

/** The share of new players still playing N days on. */
export function retentionCurve(canvas, { points }) {
  // The measured days (0, 1, 3, 7, 14, 30) sit evenly spaced: on a true day
  // scale the first three land on top of each other.
  return make(canvas, {
    type: 'line',
    data: { labels: points.map((p) => `Day ${p.day}`), datasets: [{ label: 'Retention', data: points.map((p) => p.rate), borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: INK.surface, pointBorderWidth: 2, pointHitRadius: 16, tension: 0 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { offset: true, grid: { display: false }, border: { color: INK.axis }, ticks: { maxRotation: 0, autoSkip: false } },
        y: { ...yCount('pct', { max: 1 }), ticks: { maxTicksLimit: 5, callback: (v) => tick(v, 'pct') } },
      },
      plugins: { tooltip: tooltip({ displayColors: false, callbacks: { title: (it) => `Day ${points[it[0].dataIndex].day}`, label: (it) => { const p = points[it.dataIndex]; return [`${fmt(p.rate, 'pct')} came back`, `${fmt(p.back, 'int')} of ${fmt(p.size, 'int')} players`]; } } }) },
    },
    plugins: [crosshair],
  });
}

/** Ranked or ordered categories, one hue, with each value written at the end of its bar. */
export function sideBars(canvas, { labels, values, text, tip, color = SERIES[0] }) {
  const most = Math.max(...values, 0);
  return make(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: { topRight: 4, bottomRight: 4 }, barThickness: 16 }] },
    options: {
      indexAxis: 'y',
      layout: { padding: { right: 8 } },
      scales: {
        x: { display: false, beginAtZero: true, max: most > 0 ? most * 1.42 : 1 },
        y: { grid: { display: false }, border: { color: INK.axis }, ticks: { color: INK.text2, autoSkip: false, crossAlign: 'far' } },
      },
      plugins: { tooltip: tooltip({ displayColors: false, callbacks: { title: (it) => labels[it[0].dataIndex], label: (it) => tip(it.dataIndex) } }), barValues: { text } },
    },
    plugins: [barValues],
  });
}

/** One count an hour over the last two days. */
export function hourLine(canvas, { hours, values, label }) {
  return make(canvas, {
    type: 'line',
    data: { labels: hours, datasets: [{ label, data: values, borderColor: SERIES[0], backgroundColor: 'rgba(57, 135, 229, 0.12)', fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0.3 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: { grid: { display: false }, border: { color: INK.axis }, ticks: { maxRotation: 0, autoSkipPadding: 28, callback(v) { return hour(hours[v]); } } }, y: yCount('int', { whole: true }) },
      plugins: { tooltip: tooltip({ displayColors: false, callbacks: { title: (it) => hour(hours[it[0].dataIndex]), label: (it) => `${label}: ${fmt(it.raw, 'int')}` } }) },
    },
    plugins: [crosshair],
  });
}

/** A small line with no axes, for a KPI card. Plain SVG: nothing to hover. */
export function sparkline(values, color = SERIES[0]) {
  const NS = 'http://www.w3.org/2000/svg', W = 120, H = 28, pad = 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('spark');
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return svg;
  const max = Math.max(...pts.map(([, v]) => v), 0), min = Math.min(...pts.map(([, v]) => v), 0), span = max - min || 1;
  const x = (i) => pad + (i / (values.length - 1)) * (W - pad * 2), y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', pts.map(([i, v], n) => `${n ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '));
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  return svg;
}
