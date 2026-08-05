/**
 * The one-line diagram: the same drawing an electrician would sketch for a UPS
 * installation — mains, the unit, the load, and the battery hanging off it —
 * with current animated along whichever conductors are actually carrying it.
 *
 * The SVG is built once and only its attributes are updated afterwards, so the
 * flow animation runs continuously instead of restarting on every poll.
 */
import { duration, number, POWER_PATH_LABELS } from './format.js';

const TEMPLATE = `
<svg class="oneline" viewBox="0 0 520 190" role="img" preserveAspectRatio="xMidYMid meet">
  <title></title>

  <g data-conductor="bypass">
    <path class="oneline__base" d="M 48 44 V 14 H 456 V 44" />
    <path class="oneline__flow" d="M 48 44 V 14 H 456 V 44" />
    <polygon class="oneline__arrow" points="244,8 256,14 244,20" />
  </g>

  <g data-conductor="in">
    <path class="oneline__base" d="M 90 67 H 182" />
    <path class="oneline__flow" d="M 90 67 H 182" />
    <polygon class="oneline__arrow" points="124,61 136,67 124,73" />
  </g>

  <g data-conductor="out">
    <path class="oneline__base" d="M 306 67 H 398" />
    <path class="oneline__flow" d="M 306 67 H 398" />
    <polygon class="oneline__arrow" points="340,61 352,67 340,73" />
  </g>

  <g data-conductor="battery">
    <path class="oneline__base" d="M 244 102 V 140" />
    <path class="oneline__flow" d="M 244 102 V 140" />
    <polygon class="oneline__arrow" data-arrow="down" points="238,114 250,114 244,126" />
    <polygon class="oneline__arrow" data-arrow="up" points="238,126 250,126 244,114" />
  </g>

  <g class="oneline__break-mark">
    <line class="oneline__break" x1="130" y1="60" x2="142" y2="74" />
    <line class="oneline__break" x1="142" y1="60" x2="130" y2="74" />
  </g>

  <g>
    <rect class="oneline__node-box" x="6" y="44" width="84" height="46" rx="2" />
    <text class="oneline__node-label" x="48" y="61" text-anchor="middle">Netz</text>
    <text class="oneline__node-value" x="48" y="80" text-anchor="middle" data-value="mains">—</text>
  </g>

  <g>
    <rect class="oneline__node-box" x="182" y="32" width="124" height="70" rx="2" />
    <text class="oneline__node-label" x="244" y="52" text-anchor="middle">USV</text>
    <text class="oneline__node-value" x="244" y="76" text-anchor="middle" data-value="ups">—</text>
    <text class="oneline__node-label" x="244" y="93" text-anchor="middle" data-value="ups-caption">Last</text>
  </g>

  <g>
    <rect class="oneline__node-box" x="398" y="44" width="116" height="46" rx="2" />
    <text class="oneline__node-label" x="456" y="61" text-anchor="middle">Last</text>
    <text class="oneline__node-value" x="456" y="80" text-anchor="middle" data-value="load">—</text>
  </g>

  <g>
    <!-- Wider than the other nodes: it carries charge and runtime in one line. -->
    <rect class="oneline__node-box" x="158" y="140" width="172" height="42" rx="2" />
    <text class="oneline__node-label" x="244" y="156" text-anchor="middle">Batterie</text>
    <text class="oneline__node-value" x="244" y="174" text-anchor="middle" data-value="battery">—</text>
  </g>
</svg>
`;

/** Which conductors carry current in each power path, and in which direction. */
function conductorStates(device) {
  const off = { live: false, reverse: false, charge: false };

  switch (device.powerPath) {
    case 'mains':
      return {
        bypass: { hidden: true },
        in: { live: true },
        out: { live: true },
        battery: device.charging ? { live: true, charge: true } : off,
      };
    case 'battery':
      return {
        bypass: { hidden: true },
        in: off,
        out: { live: true },
        battery: { live: true, reverse: true },
      };
    case 'bypass':
      return {
        bypass: { live: true },
        in: { live: true },
        out: off,
        battery: off,
      };
    default:
      return { bypass: { hidden: true }, in: off, out: off, battery: off };
  }
}

function loadNodeValue(device) {
  const { realPower, outputVoltage } = device.metrics;
  if (realPower !== undefined) return `${number(realPower)} W`;
  if (outputVoltage !== undefined) return `${number(outputVoltage, 1)} V`;
  return '—';
}

function batteryNodeValue(device) {
  const { charge, runtimeSeconds } = device.metrics;
  if (charge === undefined && runtimeSeconds === undefined) return '—';
  if (runtimeSeconds === undefined) return `${number(charge)} %`;
  if (charge === undefined) return duration(runtimeSeconds);
  return `${number(charge)} % · ${duration(runtimeSeconds)}`;
}

export function createDiagram() {
  const wrapper = document.createElement('div');
  wrapper.className = 'device__diagram';
  wrapper.innerHTML = TEMPLATE;

  const svg = wrapper.querySelector('svg');
  const title = svg.querySelector('title');
  const groups = {
    bypass: svg.querySelector('[data-conductor="bypass"]'),
    in: svg.querySelector('[data-conductor="in"]'),
    out: svg.querySelector('[data-conductor="out"]'),
    battery: svg.querySelector('[data-conductor="battery"]'),
  };
  const arrowDown = svg.querySelector('[data-arrow="down"]');
  const arrowUp = svg.querySelector('[data-arrow="up"]');
  const values = {
    mains: svg.querySelector('[data-value="mains"]'),
    ups: svg.querySelector('[data-value="ups"]'),
    upsCaption: svg.querySelector('[data-value="ups-caption"]'),
    load: svg.querySelector('[data-value="load"]'),
    battery: svg.querySelector('[data-value="battery"]'),
  };

  function update(device) {
    const path = device.reachable ? device.powerPath : 'unknown';
    svg.setAttribute('class', `oneline oneline--${path}`);
    svg.dataset.path = path;

    const states = conductorStates(device.reachable ? device : { powerPath: 'unknown', charging: false });

    for (const [name, group] of Object.entries(groups)) {
      const state = states[name] ?? {};
      group.dataset.live = state.live ? 'true' : 'false';
      group.dataset.reverse = state.reverse ? 'true' : 'false';
      group.dataset.hidden = state.hidden ? 'true' : 'false';
      group.classList.toggle('oneline__charge-color', Boolean(state.charge));
    }

    const batteryState = states.battery ?? {};
    arrowDown.dataset.hidden = batteryState.reverse ? 'true' : 'false';
    arrowUp.dataset.hidden = batteryState.reverse ? 'false' : 'true';

    const { inputVoltage, load } = device.metrics ?? {};
    values.mains.textContent = inputVoltage !== undefined ? `${number(inputVoltage, 1)} V` : '—';
    values.ups.textContent = load !== undefined ? `${number(load)} %` : '—';
    // The UPS box is 124 units wide; a long model name has to be clipped.
    values.upsCaption.textContent = (device.model || 'Last').slice(0, 18);
    values.load.textContent = loadNodeValue(device);
    values.battery.textContent = batteryNodeValue(device);

    title.textContent = device.reachable
      ? `Einliniendiagramm: ${POWER_PATH_LABELS[device.powerPath] ?? 'Zustand unbekannt'}, Batterie ${batteryNodeValue(device)}`
      : 'Einliniendiagramm: Gerät nicht erreichbar';
  }

  return { el: wrapper, update };
}
