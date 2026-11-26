// Every chart on the dashboard, on Chart.js. One axis per chart, thin marks,
// quiet grids, and a tooltip on hover; text stays in the ink colors and the
// marks carry the series colors.
import { Chart, BarController, LineController, ScatterController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler } from 'chart.js';
import { fmt, tick, day, fullDay, hour } from './format.js';

Chart.register(BarController, LineController, ScatterController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler);

export const INK = { surface: '#1a1a19', grid: '#2c2c2a', axis: '#383835', text: '#f0efec', text2: '#c3c2b7', muted: '#898781' };
/** Series colors, given out in this order and never by rank (validated for the dark surface). */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];
/** A measure keeps its color wherever it is drawn, whatever else is on the chart. */
const BY_ID = { new: SERIES[0], active: SERIES[1], returning: SERIES[2], downloads: SERIES[3] };
export const colorOf = (s, i) => s.color || BY_ID[s.id] || SERIES[i % SERIES.length];
// A value with nothing drawn on either side of it gets a dot: a line needs two points.
const lonely = (r) => (c) => { const d = c.dataset.data, i = c.dataIndex; return d[i] != null && d[i - 1] == null && d[i + 1] == null ? r : 0; };

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
  const wide = (canvas.parentElement?.clientWidth || canvas.clientWidth || 0) >= 520;
  return make(canvas, {
    type: 'line',
    data: { labels: dates, datasets: series.map((s, i) => ({ label: s.short || s.label, data: s.values, borderColor: colorOf(s, i), backgroundColor: colorOf(s, i), borderWidth: 2, pointRadius: lonely(3), pointHoverRadius: 4, pointHitRadius: 12, pointHoverBorderColor: INK.surface, pointHoverBorderWidth: 2, tension: 0.25, spanGaps: false })) },
    options: {
      layout: { padding: { right: wide ? 96 : 8 } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: xDays(dates), y: yCount(format, { whole: true }) },
      plugins: { tooltip: tooltip({ callbacks: { title: (it) => fullDay(dates[it[0].dataIndex]), label: (it) => ` ${it.dataset.label}: ${fmt(it.raw, format)}` } }) },
    },
    plugins: wide ? [crosshair, endLabels] : [crosshair],
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

/** Counts an hour over the last two days, a line a measure. */
export function hourLines(canvas, { hours, series }) {
  const wide = (canvas.parentElement?.clientWidth || canvas.clientWidth || 0) >= 520;
  const labelEnds = wide && series.length > 1;
  return make(canvas, {
    type: 'line',
    data: { labels: hours, datasets: series.map((s, i) => ({ label: s.label, data: s.values, borderColor: colorOf(s, i), backgroundColor: colorOf(s, i), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, pointHoverBorderColor: INK.surface, pointHoverBorderWidth: 2, tension: 0.3 })) },
    options: {
      layout: { padding: { right: labelEnds ? 72 : 8 } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: { grid: { display: false }, border: { color: INK.axis }, ticks: { maxRotation: 0, autoSkipPadding: 28, callback(v) { return hour(hours[v]); } } }, y: yCount('int', { whole: true }) },
      plugins: { tooltip: tooltip({ callbacks: { title: (it) => hour(hours[it[0].dataIndex]), label: (it) => ` ${it.dataset.label}: ${fmt(it.raw, 'int')}` } }) },
    },
    plugins: labelEnds ? [crosshair, endLabels] : [crosshair],
  });
}

/** A running total since launch. The tooltip also says what that day added. */
export function growthLine(canvas, { dates, cumulative, daily, label = 'Total' }) {
  return make(canvas, {
    type: 'line',
    data: { labels: dates, datasets: [{ label, data: cumulative, borderColor: SERIES[0], backgroundColor: 'rgba(57, 135, 229, 0.12)', fill: true, borderWidth: 2, pointRadius: lonely(3), pointHoverRadius: 4, pointHitRadius: 12, pointHoverBorderColor: INK.surface, pointHoverBorderWidth: 2, tension: 0.15 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: xDays(dates), y: yCount('int', { whole: true }) },
      plugins: { tooltip: tooltip({ displayColors: false, callbacks: { title: (it) => fullDay(dates[it[0].dataIndex]), label: (it) => [`${fmt(it.raw, 'int')} in all`, `${fmt(daily[it.dataIndex], 'int')} that day`] } }) },
    },
    plugins: [crosshair],
  });
}

const MOVE_COLOR = { up: '#22c55e', down: '#ef5350', flat: SERIES[0] };
const moveTone = (m) => (m > 0 ? 'up' : m < 0 ? 'down' : 'flat');
const splitTerm = (term) => {
  const words = term.split(/\s+/);
  if (words.length <= 1 || term.length <= 10) return term;
  if (words.length === 2) return words;
  let best = [words[0], words.slice(1).join(' ')];
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
    if (Math.max(a.length, b.length) < Math.max(best[0].length, best[1].length)) best = [a, b];
  }
  return best;
};

// Top-10 reference line, previous-rank movement trails, and collision-free #rank + ▲/▼ annotations.
const rankMarks = {
  id: 'rankMarks',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales: { y } } = chart;
    const items = opts.items || [];
    const pts = chart.getDatasetMeta(0)?.data || [];
    ctx.save();
    // Subtle Top-10 threshold guide line.
    const y10 = y.getPixelForValue(10);
    ctx.strokeStyle = 'rgba(240, 239, 236, 0.14)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(a.left, y10); ctx.lineTo(a.right, y10); ctx.stroke();
    ctx.setLineDash([]);
    // Vertical movement trails from previous rank to current dot.
    items.forEach((it, i) => {
      const pt = pts[i];
      if (!pt || !it.move || it.prev == null) return;
      const fromVal = Math.min(100, Math.max(1, it.prev));
      const py = y.getPixelForValue(fromVal);
      if (Math.abs(py - pt.y) < 3) return;
      const col = it.move > 0 ? 'rgba(34, 197, 94, 0.45)' : 'rgba(239, 83, 80, 0.45)';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      if (it.prev > 100) ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(pt.x, py); ctx.lineTo(pt.x, pt.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(pt.x, py, 3, 0, Math.PI * 2); ctx.fillStyle = INK.surface; ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  },
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales: { y } } = chart;
    const items = opts.items || [];
    const pts = chart.getDatasetMeta(0)?.data || [];
    if (!pts.length) return;
    const slotW = (a.right - a.left) / Math.max(items.length, 1);
    const stacked = slotW < 58;
    const font = `600 11px ${Chart.defaults.font.family}`;
    const boxes = [];
    pts.forEach((pt, i) => {
      boxes.push([pt.x - 7, pt.y - 7, pt.x + 7, pt.y + 7]);
      const it = items[i];
      if (it?.move && it.prev != null) {
        const py = y.getPixelForValue(Math.min(100, Math.max(1, it.prev)));
        boxes.push([pt.x - 5, Math.min(pt.y, py) - 4, pt.x + 5, Math.max(pt.y, py) + 4]);
      }
    });
    const hits = (b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

    ctx.save();
    ctx.font = font;
    ctx.textBaseline = 'middle';
    items.forEach((it, i) => {
      const pt = pts[i];
      if (!pt) return;
      const rankTxt = `#${it.now}`;
      const moveTxt = it.move > 0 ? `▲${it.move}` : it.move < 0 ? `▼${Math.abs(it.move)}` : '';
      const rw = ctx.measureText(rankTxt).width;
      const mw = moveTxt ? ctx.measureText(moveTxt).width : 0;
      const twoLines = stacked && !!moveTxt;
      const w = twoLines ? Math.max(rw, mw) : rw + (moveTxt ? 4 + mw : 0);
      const h = twoLines ? 23 : 12;
      const cx = Math.min(Math.max(pt.x, a.left + w / 2 + 1), a.right - w / 2 - 1);
      const step = h / 2 + 10;
      // Place labels on the open side of the dot: below when the trail extends upward (moved down), above otherwise.
      const preferBelow = it.move < 0 || pt.y - h - 10 < 4;
      const offsets = preferBelow
        ? [step, -step, step + 13, -(step + 13), step + 26, -(step + 26), step + 39]
        : [-step, step, -(step + 13), step + 13, -(step + 26), step + 26, step + 39];
      let cy = pt.y + offsets[0];
      for (const dy of offsets) {
        const y0 = pt.y + dy;
        const box = [cx - w / 2 - 2, y0 - h / 2 - 1, cx + w / 2 + 2, y0 + h / 2 + 1];
        if (box[1] >= 2 && box[3] <= a.bottom - 2 && !hits(box)) { cy = y0; break; }
      }
      cy = Math.min(Math.max(cy, h / 2 + 2), a.bottom - h / 2 - 2);
      boxes.push([cx - w / 2 - 2, cy - h / 2 - 1, cx + w / 2 + 2, cy + h / 2 + 1]);

      if (Math.abs(cy - pt.y) > h / 2 + 15) {
        ctx.strokeStyle = 'rgba(195, 194, 183, 0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y + (cy > pt.y ? 6 : -6));
        ctx.lineTo(cx, cy + (cy > pt.y ? -(h / 2 + 1) : h / 2 + 1));
        ctx.stroke();
      }
      if (twoLines) {
        ctx.textAlign = 'center';
        ctx.fillStyle = INK.text;
        ctx.fillText(rankTxt, cx, cy - 5.5);
        ctx.fillStyle = it.move > 0 ? MOVE_COLOR.up : MOVE_COLOR.down;
        ctx.fillText(moveTxt, cx, cy + 6.5);
      } else {
        ctx.textAlign = 'left';
        const x0 = cx - w / 2;
        ctx.fillStyle = INK.text;
        ctx.fillText(rankTxt, x0, cy);
        if (moveTxt) {
          ctx.fillStyle = it.move > 0 ? MOVE_COLOR.up : MOVE_COLOR.down;
          ctx.fillText(moveTxt, x0 + rw + 4, cy);
        }
      }
    });
    ctx.restore();
  },
};

/** Top 10 search keywords plotted by their placement in the top 100 (#1 at top), with movement arrows. */
export function rankScatter(canvas, { items }) {
  const hostW = canvas.parentElement?.clientWidth || canvas.clientWidth || 0;
  const slotW = items.length ? (hostW - 56) / items.length : 80;
  const flat = slotW >= 58;
  const data = items.map((it, i) => ({ x: i, y: it.now }));
  const colors = items.map((it) => MOVE_COLOR[moveTone(it.move)]);
  return make(canvas, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Search rank',
        data,
        clip: false,
        pointRadius: 5.5,
        pointHoverRadius: 7.5,
        pointHitRadius: 16,
        pointBackgroundColor: colors,
        pointBorderColor: INK.surface,
        pointBorderWidth: 2,
      }],
    },
    options: {
      layout: { padding: { top: flat ? 24 : 32, right: 16, bottom: 4 } },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: -0.55,
          max: Math.max(items.length - 0.45, 0.55),
          grid: { color: 'rgba(44, 44, 42, 0.5)', lineWidth: 1 },
          border: { color: INK.axis },
          afterBuildTicks: (axis) => { axis.ticks = items.map((_, i) => ({ value: i })); },
          ticks: {
            autoSkip: false,
            color: INK.text2,
            minRotation: flat ? 0 : 40,
            maxRotation: flat ? 0 : 40,
            font: { size: flat ? 11 : 10.5 },
            callback: (v) => {
              const it = items[v];
              if (!it) return '';
              return flat ? splitTerm(it.term) : it.term;
            },
          },
        },
        y: {
          reverse: true,
          min: 1,
          max: 100,
          grid: { color: INK.grid, lineWidth: 1 },
          border: { display: false },
          afterBuildTicks: (axis) => { axis.ticks = [1, 25, 50, 75, 100].map((v) => ({ value: v })); },
          ticks: { color: INK.muted, callback: (v) => `#${v}` },
        },
      },
      plugins: {
        tooltip: tooltip({
          displayColors: false,
          callbacks: {
            title: (it) => items[it[0].dataIndex]?.term || '',
            label: (it) => {
              const s = items[it.dataIndex];
              const lines = [`Placement: #${s.now}`];
              if (s.move > 0) lines.push(`Moved ▲ ${s.move} (from #${s.prev}${s.prev_date ? ` on ${day(s.prev_date)}` : ''})`);
              else if (s.move < 0) lines.push(`Moved ▼ ${Math.abs(s.move)} (from #${s.prev}${s.prev_date ? ` on ${day(s.prev_date)}` : ''})`);
              else if (s.prev != null) lines.push(`No change (was #${s.prev}${s.prev_date ? ` on ${day(s.prev_date)}` : ''})`);
              if (s.best != null && s.worst != null && s.best !== s.worst) lines.push(`Range: #${s.best} – #${s.worst}`);
              return lines;
            },
          },
        }),
        rankMarks: { items },
      },
    },
    plugins: [rankMarks],
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
