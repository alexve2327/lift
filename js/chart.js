// chart.js — hand-authored inline SVG line charts. No library, which keeps the
// app offline-capable and build-step-free.
//
// Design notes, so the charts stay readable rather than decorative:
//
//  - ONE series per chart. On a 393px phone, four overlapping exercise lines is
//    noise. Per-exercise charts need no legend and no categorical palette:
//    identity comes from the card title, so the single series wears the accent.
//  - Interaction is TAP, not hover. There is no hover on a phone, and a tooltip
//    that only appears on mouseover is a tooltip that never appears.
//  - Colors come from CSS custom properties, so both themes work from one
//    definition and nothing is hardcoded to one background.

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k) n.append(k);
  return n;
}

const niceStep = (span, target = 5) => {
  const raw = Math.max(span, 1e-9) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((m) => raw <= m * mag) * mag || mag * 10;
};

/**
 * points: [{ x: Date|number, y: number, label?, sub?, mark?: 'diamond', hollow?: bool }]
 * bands:  [{ from, to, label }]  horizontal reference band (the rep range)
 * rules:  [{ y, label }]         dashed horizontal reference lines
 */
export function lineChart({
  points, height = 190, yLabel = '', pointLabel = null,
  bands = [], rules = [], yPad = 0.12, integerY = false, onSelect = null,
}) {
  const W = 680;
  const H = height;
  const m = { t: 18, r: 14, b: 26, l: 42 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const wrap = document.createElement('div');
  wrap.className = 'chart';

  if (!points.length) {
    wrap.append(Object.assign(document.createElement('p'),
      { className: 'muted small chart-empty', textContent: 'No data yet.' }));
    return wrap;
  }

  const xs = points.map((p) => +p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo0 = Math.min(...ys, ...bands.flatMap((b) => [b.from, b.to]), ...rules.map((r) => r.y));
  const hi0 = Math.max(...ys, ...bands.flatMap((b) => [b.from, b.to]), ...rules.map((r) => r.y));
  const pad = Math.max((hi0 - lo0) * yPad, integerY ? 1 : Math.max(hi0 * 0.04, 2));
  let lo = lo0 - pad;
  let hi = hi0 + pad;
  if (integerY) { lo = Math.floor(lo); hi = Math.ceil(hi); }
  if (hi - lo < 1e-9) { hi = lo + 1; }

  const X = (v) => m.l + (x1 === x0 ? iw / 2 : ((+v - x0) / (x1 - x0)) * iw);
  const Y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;

  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `${yLabel || 'Value'} over time, ${points.length} points`,
    preserveAspectRatio: 'none',
  });

  // --- y grid ---------------------------------------------------------------
  const step = niceStep(hi - lo, 4);
  const gy = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) gy.push(v);
  for (const v of gy) {
    svg.append(s('line', {
      x1: m.l, x2: W - m.r, y1: Y(v).toFixed(2), y2: Y(v).toFixed(2),
      class: 'c-grid',
    }));
    const t = s('text', { x: m.l - 7, y: (Y(v) + 3.5).toFixed(2), class: 'c-axis', 'text-anchor': 'end' });
    t.textContent = Math.abs(v) >= 1000 ? v.toLocaleString() : String(Math.round(v * 10) / 10);
    svg.append(t);
  }

  // --- reference bands and rules -------------------------------------------
  for (const b of bands) {
    svg.append(s('rect', {
      x: m.l, width: iw,
      y: Y(Math.max(b.from, b.to)).toFixed(2),
      height: Math.abs(Y(b.from) - Y(b.to)).toFixed(2),
      class: 'c-band',
    }));
  }
  for (const r of rules) {
    svg.append(s('line', {
      x1: m.l, x2: W - m.r, y1: Y(r.y).toFixed(2), y2: Y(r.y).toFixed(2),
      class: 'c-rule',
    }));
    if (r.label) {
      // Left gutter, not right: the right edge is where the newest point and
      // its value label live, and the two collided.
      const t = s('text', { x: m.l + 4, y: (Y(r.y) - 4).toFixed(2), class: 'c-rule-label', 'text-anchor': 'start' });
      t.textContent = r.label;
      svg.append(t);
    }
  }

  // --- the line -------------------------------------------------------------
  const solid = points.filter((p) => !p.hollow);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(2)},${Y(p.y).toFixed(2)}`).join(' ');
  svg.append(s('path', { d: path, class: 'c-line' + (solid.length === points.length ? '' : ' dashed') }));

  // --- x axis: first, middle, last date ------------------------------------
  const fmtX = (v) => new Date(v).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  const ticks = points.length <= 2 ? points : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
  for (const p of ticks) {
    const t = s('text', { x: X(p.x).toFixed(2), y: H - 8, class: 'c-axis', 'text-anchor': 'middle' });
    t.textContent = fmtX(p.x);
    svg.append(t);
  }

  // --- points, labels, hit targets -----------------------------------------
  const readout = document.createElement('div');
  readout.className = 'chart-readout';
  const marks = [];

  points.forEach((p, i) => {
    const cx = X(p.x);
    const cy = Y(p.y);
    const g = s('g', { class: 'c-pt' + (p.hollow ? ' hollow' : '') });

    if (p.mark === 'diamond') {
      g.append(s('path', {
        d: `M${cx},${cy - 5.5} L${cx + 5.5},${cy} L${cx},${cy + 5.5} L${cx - 5.5},${cy} Z`,
        class: 'c-dot diamond',
      }));
    } else {
      g.append(s('circle', { cx: cx.toFixed(2), cy: cy.toFixed(2), r: 3.6, class: 'c-dot' }));
    }

    // Selective point labels: the number above each point that the plotting
    // notes ask for (set count on the weight chart, weight on the reps chart).
    if (pointLabel) {
      const txt = pointLabel(p, i);
      if (txt) {
        const t = s('text', { x: cx.toFixed(2), y: (cy - 10).toFixed(2), class: 'c-ptlabel', 'text-anchor': 'middle' });
        t.textContent = txt;
        g.append(t);
      }
    }

    // Hit target larger than the mark, per the interaction rules.
    const hit = s('circle', { cx: cx.toFixed(2), cy: cy.toFixed(2), r: 16, class: 'c-hit' });
    const select = () => {
      for (const o of marks) o.classList.remove('on');
      g.classList.add('on');
      readout.textContent = p.label ?? '';
      readout.classList.add('on');
      onSelect?.(p, i);
    };
    hit.addEventListener('pointerdown', select);
    g.append(hit);
    marks.push(g);
    svg.append(g);
  });

  const scroller = document.createElement('div');
  scroller.className = 'chart-scroll';
  scroller.append(svg);
  wrap.append(scroller, readout);

  // Show the most recent point by default, so the chart says something before
  // you touch it.
  const last = points[points.length - 1];
  readout.textContent = last.label ?? '';
  marks[marks.length - 1].classList.add('on');

  return wrap;
}

/** Least-squares trend line, used on the bodyweight chart. Returns the
 *  endpoints so the caller can draw it, plus lb/week for the readout. */
export function trend(points) {
  const n = points.length;
  if (n < 3) return null;
  const xs = points.map((p) => +p.x);
  const ys = points.map((p) => p.y);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const slope = num / den;                 // lb per millisecond
  return {
    perWeek: slope * 604800000,
    at: (x) => my + slope * (x - mx),
    from: Math.min(...xs),
    to: Math.max(...xs),
  };
}
