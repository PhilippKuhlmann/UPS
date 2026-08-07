/**
 * A single-series time chart drawn as plain SVG: 2 px line, a faint area under
 * it, three recessive grid lines, and a crosshair with a tooltip. One series per
 * chart, so the title names it and no legend is needed; the latest value is
 * direct-labelled in the header.
 */
import { number, shortTime, dateTime } from './format.js';

const PAD = { top: 10, right: 14, bottom: 20, left: 42 };
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function computeDomain(values, mode) {
  if (mode === 'percent') return [0, 100];

  const min = Math.min(...values);
  const max = Math.max(...values);

  if (mode === 'zero') return [0, max <= 0 ? 1 : max * 1.1];
  if (min === max) return [min - 1, max + 1];

  const pad = (max - min) * 0.12;
  // Voltages, power and temperature never go below zero here, so padding must
  // not push the axis into negative numbers that cannot occur.
  return [min >= 0 ? Math.max(0, min - pad) : min - pad, max + pad];
}

/**
 * @param {object} options
 * @param {string} options.title      Row label, e.g. "Ladezustand".
 * @param {string} options.unit       Unit suffix shown next to every value.
 * @param {string} options.color      CSS custom property name of the series colour.
 * @param {'percent'|'zero'|'auto'} options.domain
 * @param {number} [options.decimals]
 */
export function createChart({ title, unit, color, domain = 'auto', decimals = 0 }) {
  const root = document.createElement('figure');
  root.className = 'chart';

  const head = document.createElement('figcaption');
  head.className = 'chart__head';
  head.innerHTML = `
    <span class="chart__title"><span class="chart__swatch" style="background:var(${color})"></span>${title}</span>
    <span class="chart__current">—</span>
  `;
  const current = head.querySelector('.chart__current');

  const svg = el('svg', { class: 'chart__svg', role: 'img' });
  const empty = document.createElement('div');
  empty.className = 'chart__empty';
  empty.textContent = 'Noch keine Messwerte';

  const tooltip = document.createElement('div');
  tooltip.className = 'chart__tooltip';

  const tableToggle = document.createElement('button');
  tableToggle.type = 'button';
  tableToggle.className = 'command';
  tableToggle.style.marginTop = '0.5rem';
  tableToggle.textContent = 'Werte als Tabelle';
  tableToggle.setAttribute('aria-expanded', 'false');

  const table = document.createElement('div');
  table.hidden = true;
  table.style.maxHeight = '14rem';
  table.style.overflow = 'auto';
  table.style.marginTop = '0.5rem';

  root.append(head, svg, empty, tooltip, tableToggle, table);

  let points = [];
  let geometry = null;

  function fmt(value) {
    return `${number(value, decimals)} ${unit}`.trim();
  }

  function draw() {
    svg.replaceChildren();

    if (points.length === 0) {
      svg.hidden = true;
      empty.hidden = false;
      tableToggle.hidden = true;
      current.textContent = '—';
      geometry = null;
      return;
    }

    svg.hidden = false;
    empty.hidden = true;
    tableToggle.hidden = false;

    // Breite und Höhe kommen aus dem Stylesheet; die viewBox bildet sie 1:1
    // ab, damit Linien und Beschriftungen in jeder Größe gleich bleiben.
    const box = svg.getBoundingClientRect();
    const plotWidth = Math.max(160, Math.round(box.width));
    const plotHeight = Math.max(120, Math.round(box.height));
    svg.setAttribute('viewBox', `0 0 ${plotWidth} ${plotHeight}`);

    const values = points.map((point) => point.v);
    const [lo, hi] = computeDomain(values, domain);
    const innerWidth = plotWidth - PAD.left - PAD.right;
    const innerHeight = plotHeight - PAD.top - PAD.bottom;

    const firstT = points[0].t;
    const lastT = points[points.length - 1].t;
    const spanT = Math.max(1, lastT - firstT);

    const x = (t) => PAD.left + ((t - firstT) / spanT) * innerWidth;
    const y = (v) => PAD.top + innerHeight - ((v - lo) / (hi - lo || 1)) * innerHeight;

    geometry = { x, y, innerWidth, plotWidth };

    // Fünf Linien statt drei: auf der höheren Fläche lässt sich damit ein Wert
    // ablesen, ohne ihn zwischen zwei weit entfernten Marken zu schätzen.
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const value = lo + (hi - lo) * fraction;
      const yPos = Math.round(y(value)) + 0.5;
      svg.append(
        el('line', {
          class: 'chart__grid-line',
          x1: PAD.left,
          x2: plotWidth - PAD.right,
          y1: yPos,
          y2: yPos,
        }),
      );
      const label = el('text', {
        class: 'chart__axis-label',
        x: PAD.left - 6,
        y: yPos + 3,
        'text-anchor': 'end',
      });
      label.textContent = number(value, decimals);
      svg.append(label);
    }

    for (const [t, anchor] of [
      [firstT, 'start'],
      [lastT, 'end'],
    ]) {
      const label = el('text', {
        class: 'chart__axis-label',
        x: anchor === 'start' ? PAD.left : plotWidth - PAD.right,
        y: plotHeight - 6,
        'text-anchor': anchor,
      });
      label.textContent = shortTime(t);
      svg.append(label);
    }

    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.t)} ${y(point.v)}`).join(' ');
    const baseline = PAD.top + innerHeight;

    svg.append(
      el('path', {
        class: 'chart__area',
        fill: `var(${color})`,
        d: `${line} L ${x(lastT)} ${baseline} L ${x(firstT)} ${baseline} Z`,
      }),
      el('path', { class: 'chart__line', stroke: `var(${color})`, d: line }),
    );

    const crosshair = el('line', {
      class: 'chart__crosshair',
      y1: PAD.top,
      y2: baseline,
      x1: PAD.left,
      x2: PAD.left,
    });
    const marker = el('circle', { class: 'chart__marker', r: 4, fill: `var(${color})`, cx: 0, cy: 0 });
    svg.append(crosshair, marker);

    svg.__crosshair = crosshair;
    svg.__marker = marker;

    const last = points[points.length - 1];
    current.textContent = fmt(last.v);

    const min = Math.min(...values);
    const max = Math.max(...values);
    svg.setAttribute(
      'aria-label',
      `${title}: aktuell ${fmt(last.v)}, Minimum ${fmt(min)}, Maximum ${fmt(max)}, ` +
        `Zeitraum ${dateTime(firstT)} bis ${dateTime(lastT)}`,
    );
  }

  function nearestIndex(clientX) {
    if (!geometry || points.length === 0) return -1;

    const rect = svg.getBoundingClientRect();
    const localX = clientX - rect.left;

    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < points.length; index++) {
      const distance = Math.abs(geometry.x(points[index].t) - localX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  function showHover(clientX) {
    const index = nearestIndex(clientX);
    if (index < 0) return;

    const point = points[index];
    const px = geometry.x(point.t);
    const py = geometry.y(point.v);

    svg.__crosshair?.setAttribute('x1', px);
    svg.__crosshair?.setAttribute('x2', px);
    svg.__marker?.setAttribute('cx', px);
    svg.__marker?.setAttribute('cy', py);

    tooltip.innerHTML = `<span class="chart__tooltip-time">${shortTime(point.t)}</span>${fmt(point.v)}`;
    // Keep the tooltip inside the card rather than letting it hang over the edge.
    const clamped = Math.min(Math.max(px, 40), root.clientWidth - 40);
    tooltip.style.left = `${clamped}px`;
    tooltip.style.top = `${py + head.offsetHeight + 14}px`;
    root.classList.add('is-hovered');
  }

  svg.addEventListener('pointermove', (event) => showHover(event.clientX));
  svg.addEventListener('pointerdown', (event) => showHover(event.clientX));
  svg.addEventListener('pointerleave', () => root.classList.remove('is-hovered'));

  tableToggle.addEventListener('click', () => {
    const open = table.hidden;
    table.hidden = !open;
    tableToggle.setAttribute('aria-expanded', String(open));
    tableToggle.textContent = open ? 'Tabelle ausblenden' : 'Werte als Tabelle';

    if (!open) return;

    // Roughly 40 rows keeps the table readable regardless of the range.
    const step = Math.max(1, Math.ceil(points.length / 40));
    const rows = points
      .filter((_, index) => index % step === 0)
      .map((point) => `<tr><td class="var-table__name">${dateTime(point.t)}</td><td>${fmt(point.v)}</td></tr>`)
      .join('');

    table.innerHTML = `<table class="var-table"><thead><tr><th>Zeitpunkt</th><th>${title}</th></tr></thead><tbody>${rows}</tbody></table>`;
  });

  const observer = new ResizeObserver(() => draw());
  observer.observe(root);

  return {
    el: root,
    setData(nextPoints) {
      points = nextPoints.filter((point) => point.v !== null && Number.isFinite(point.v));
      if (!table.hidden) {
        table.hidden = true;
        tableToggle.setAttribute('aria-expanded', 'false');
        tableToggle.textContent = 'Werte als Tabelle';
      }
      draw();
    },
    destroy() {
      observer.disconnect();
    },
  };
}
