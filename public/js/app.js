import { api, authEvents, connectLiveFeed } from './api.js';
import { createChart } from './chart.js';
import { createDiagram } from './diagram.js';
import { renderAccount, renderLogin, renderPasswordChange } from './gate.js';
import { renderServers } from './servers.js';
import {
  clockTime,
  commandLabel,
  dateTime,
  duration,
  escapeHtml,
  headlineStatus,
  isDisruptiveCommand,
  number,
  relativeTime,
  SEVERITY_GLYPHS,
  STATUS_LABELS,
} from './format.js';

const main = document.getElementById('main');
const subtitle = document.getElementById('masthead-subtitle');
const connectionState = document.getElementById('connection-state');
const connectionText = document.getElementById('connection-text');
const eventBadge = document.getElementById('event-badge');

const state = {
  devices: [],
  activeAlerts: [],
  config: null,
  unacknowledged: 0,
  /** False until the first snapshot arrives, so views can tell "loading" from "gone". */
  loaded: false,
  /** The signed-in account, or null when authentication is switched off. */
  user: null,
};

/**
 * Colour follows the metric family, not the chart order: battery figures are
 * green, output/load figures blue, mains and environment figures ochre.
 */
const CHART_SPECS = [
  { key: 'charge', title: 'Ladezustand', unit: '%', color: '--series-charge', domain: 'percent' },
  { key: 'runtimeSeconds', title: 'Restlaufzeit', unit: 'min', color: '--series-charge', domain: 'zero', scale: 1 / 60 },
  { key: 'load', title: 'Last', unit: '%', color: '--series-load', domain: 'percent' },
  { key: 'realPower', title: 'Wirkleistung', unit: 'W', color: '--series-load', domain: 'zero' },
  { key: 'inputVoltage', title: 'Eingangsspannung', unit: 'V', color: '--series-voltage', domain: 'auto', decimals: 1 },
  { key: 'batteryVoltage', title: 'Batteriespannung', unit: 'V', color: '--series-charge', domain: 'auto', decimals: 1 },
  { key: 'temperature', title: 'Temperatur', unit: '°C', color: '--series-voltage', domain: 'auto', decimals: 1 },
];

const RANGES = [
  ['1h', '1 Std'],
  ['6h', '6 Std'],
  ['24h', '24 Std'],
  ['7d', '7 Tage'],
  ['30d', '30 Tage'],
];

/* ── Chrome ───────────────────────────────────────────────────────────── */

function setConnection(status) {
  const labels = { connecting: 'Verbindung wird aufgebaut', live: 'Live', lost: 'Verbindung unterbrochen — neuer Versuch läuft' };
  connectionState.dataset.state = status;
  connectionText.textContent = labels[status] ?? status;
}

let toastTimer = null;

function toast(message, tone = 'info') {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);

  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.tone = tone;
  node.role = 'status';
  node.textContent = message;
  document.body.append(node);

  toastTimer = setTimeout(() => node.remove(), 5000);
}

function updateChrome() {
  const total = state.devices.length;
  const problems = state.devices.filter((device) => device.severity !== 'good').length;
  const interval = state.config ? `${Math.round(state.config.pollIntervalMs / 1000)} s` : '—';

  subtitle.textContent =
    total === 0
      ? 'Keine Geräte gemeldet'
      : `${total} ${total === 1 ? 'Gerät' : 'Geräte'} · ${problems === 0 ? 'alle unauffällig' : `${problems} auffällig`} · Abfrage alle ${interval}`;

  eventBadge.hidden = state.unacknowledged === 0;
  eventBadge.textContent = String(state.unacknowledged);

  for (const tab of document.querySelectorAll('.tab')) {
    const route = tab.dataset.route;
    const active = route === '#/' ? location.hash === '#/' || location.hash === '' : location.hash.startsWith(route);
    if (active) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  }
}

/* ── Shared pieces ────────────────────────────────────────────────────── */

function statusChip(device) {
  const severity = device.severity;
  return `<span class="status-chip" data-severity="${severity}">
    <span class="status-chip__glyph" aria-hidden="true">${SEVERITY_GLYPHS[severity] ?? '●'}</span>
    ${escapeHtml(headlineStatus(device))}
  </span>`;
}

function readout(label, value, unit, muted = false) {
  return `<div class="readout${muted ? ' readout--muted' : ''}">
    <div class="readout__label">${escapeHtml(label)}</div>
    <div class="readout__value">${escapeHtml(value)}${unit ? `<span class="readout__unit">${escapeHtml(unit)}</span>` : ''}</div>
  </div>`;
}

function readoutsFor(device) {
  const m = device.metrics;
  return [
    readout('Ladung', m.charge === undefined ? '—' : number(m.charge), m.charge === undefined ? '' : '%', m.charge === undefined),
    readout('Last', m.load === undefined ? '—' : number(m.load), m.load === undefined ? '' : '%', m.load === undefined),
    readout('Restlaufzeit', duration(m.runtimeSeconds), '', m.runtimeSeconds === undefined),
    readout('Eingang', m.inputVoltage === undefined ? '—' : number(m.inputVoltage, 1), m.inputVoltage === undefined ? '' : 'V', m.inputVoltage === undefined),
  ].join('');
}

function alertBar(alert) {
  return `<div class="alert-bar" data-severity="${alert.severity}">
    <span class="alert-bar__glyph" aria-hidden="true">${SEVERITY_GLYPHS[alert.severity] ?? '▲'}</span>
    <div>
      <div class="alert-bar__title">${escapeHtml(alert.title)} · ${escapeHtml(alert.deviceId)}</div>
      <p class="alert-bar__text">${escapeHtml(alert.message)} · ${escapeHtml(relativeTime(alert.since))}</p>
    </div>
  </div>`;
}

/* ── Overview ─────────────────────────────────────────────────────────── */

function createDeviceCard(device) {
  const card = document.createElement('a');
  card.className = 'panel device';
  card.href = `#/device/${device.id.split('/').map(encodeURIComponent).join('/')}`;

  const head = document.createElement('div');
  head.className = 'device__head';

  const diagram = createDiagram();

  const readouts = document.createElement('div');
  readouts.className = 'device__readouts';

  const error = document.createElement('p');
  error.className = 'device__error';

  card.append(head, diagram.el, readouts, error);

  function update(next) {
    head.innerHTML = `
      <div>
        <div class="device__name">${escapeHtml(next.upsName)}</div>
        <div class="device__meta">${escapeHtml([next.manufacturer, next.model].filter(Boolean).join(' ') || next.description || next.serverName)}</div>
      </div>
      ${statusChip(next)}
    `;
    diagram.update(next);
    readouts.innerHTML = readoutsFor(next);
    error.textContent = next.reachable ? '' : next.error ?? 'Unbekannter Fehler';
    error.hidden = next.reachable;
  }

  update(device);
  return { el: card, update, id: device.id };
}

function renderOverview(container) {
  const alerts = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'device-grid';
  container.append(alerts, grid);

  const cards = new Map();

  function paint() {
    alerts.innerHTML = state.activeAlerts.map(alertBar).join('');

    if (state.devices.length === 0) {
      grid.innerHTML = `<div class="empty-state">
        <div class="empty-state__title">Keine Geräte</div>
        <p class="empty-state__text">Es ist noch kein NUT-Server hinterlegt, oder er meldet keine USV.</p>
        <p style="margin-top:0.9rem"><a class="command" href="#/servers">USV-Server hinzufügen</a></p>
      </div>`;
      cards.clear();
      return;
    }

    if (grid.firstElementChild?.classList.contains('empty-state')) grid.replaceChildren();

    const seen = new Set();
    for (const device of state.devices) {
      seen.add(device.id);
      const existing = cards.get(device.id);
      if (existing) {
        existing.update(device);
      } else {
        const card = createDeviceCard(device);
        cards.set(device.id, card);
        grid.append(card.el);
      }
    }

    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.el.remove();
        cards.delete(id);
      }
    }
  }

  paint();
  return { onState: paint, destroy() {} };
}

/* ── Device detail ────────────────────────────────────────────────────── */

function renderDevice(container, deviceId) {
  let range = localStorage.getItem('ups-nut-range') ?? '6h';
  let variableFilter = '';
  let historyTimer = null;
  const charts = new Map();

  const back = document.createElement('a');
  back.className = 'back-link';
  back.href = '#/';
  back.textContent = '← Übersicht';

  const alerts = document.createElement('div');

  const summary = document.createElement('section');
  summary.className = 'panel';

  const historyPanel = document.createElement('section');
  historyPanel.className = 'panel';
  historyPanel.innerHTML = `
    <div class="panel__head">
      <h2 class="section-title">Verlauf</h2>
      <div class="range-picker" role="group" aria-label="Zeitraum"></div>
    </div>
    <div class="panel__body"><div class="chart-grid"></div></div>
  `;
  const rangePicker = historyPanel.querySelector('.range-picker');
  const chartGrid = historyPanel.querySelector('.chart-grid');

  const controlPanel = document.createElement('section');
  controlPanel.className = 'panel';

  const varsPanel = document.createElement('section');
  varsPanel.className = 'panel';

  const placeholder = document.createElement('div');
  placeholder.className = 'empty-state';
  placeholder.hidden = true;

  const panels = [alerts, summary, historyPanel, controlPanel, varsPanel];
  container.append(back, placeholder, ...panels);

  for (const [value, label] of RANGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(value === range));
    button.addEventListener('click', () => {
      range = value;
      localStorage.setItem('ups-nut-range', value);
      for (const sibling of rangePicker.children) {
        sibling.setAttribute('aria-pressed', String(sibling === button));
      }
      void loadHistory();
    });
    rangePicker.append(button);
  }

  const diagram = createDiagram();

  function currentDevice() {
    return state.devices.find((device) => device.id === deviceId);
  }

  async function loadHistory() {
    const device = currentDevice();
    if (!device) return;

    let response;
    try {
      response = await api.history(deviceId, range);
    } catch (error) {
      toast(`Verlauf konnte nicht geladen werden: ${error.message}`, 'error');
      return;
    }

    const available = CHART_SPECS.filter((spec) =>
      response.points.some((point) => point[spec.key] !== null && point[spec.key] !== undefined),
    );

    if (available.length === 0) {
      chartGrid.innerHTML = `<div class="empty-state">
        <div class="empty-state__title">Noch kein Verlauf</div>
        <p class="empty-state__text">Für diesen Zeitraum liegen keine Messwerte vor. Die Aufzeichnung beginnt mit der ersten Abfrage nach dem Start.</p>
      </div>`;
      for (const chart of charts.values()) chart.destroy();
      charts.clear();
      return;
    }

    if (chartGrid.firstElementChild?.classList.contains('empty-state')) chartGrid.replaceChildren();

    for (const spec of available) {
      let chart = charts.get(spec.key);
      if (!chart) {
        chart = createChart({
          title: spec.title,
          unit: spec.unit,
          color: spec.color,
          domain: spec.domain,
          decimals: spec.decimals ?? 0,
        });
        charts.set(spec.key, chart);
        chartGrid.append(chart.el);
      }
      chart.setData(
        response.points.map((point) => ({
          t: point.t,
          v: point[spec.key] === null || point[spec.key] === undefined ? null : point[spec.key] * (spec.scale ?? 1),
        })),
      );
    }

    for (const [key, chart] of charts) {
      if (!available.some((spec) => spec.key === key)) {
        chart.destroy();
        chart.el.remove();
        charts.delete(key);
      }
    }
  }

  function paintSummary(device) {
    if (!summary.querySelector('.device__readouts')) {
      summary.innerHTML = '<div class="device__head"></div>';
      summary.append(diagram.el);
      const readouts = document.createElement('div');
      readouts.className = 'device__readouts';
      summary.append(readouts);
    }

    summary.querySelector('.device__head').innerHTML = `
      <div>
        <div class="device__name">${escapeHtml(device.upsName)} <span class="eyebrow">auf ${escapeHtml(device.serverName)}</span></div>
        <div class="device__meta">${escapeHtml([device.manufacturer, device.model].filter(Boolean).join(' ') || device.description || '—')}${device.serial ? ` · S/N ${escapeHtml(device.serial)}` : ''}${device.driver ? ` · ${escapeHtml(device.driver)}` : ''}</div>
      </div>
      ${statusChip(device)}
    `;
    diagram.update(device);
    summary.querySelector('.device__readouts').innerHTML =
      readoutsFor(device) +
      readout('Statusflags', device.statusFlags.join(' ') || '—', '', device.statusFlags.length === 0) +
      readout('Letzte Abfrage', clockTime(device.updatedAt), '');
  }

  function paintControls(device) {
    const commands = device.commands ?? [];
    const writable = Object.entries(device.writableVars ?? {});

    controlPanel.innerHTML = `
      <div class="panel__head"><h2 class="section-title">Steuerung</h2></div>
      <div class="panel__body">
        ${
          commands.length === 0
            ? '<p class="note">Dieses Gerät bietet keine Befehle an, oder der NUT-Benutzer hat keine <code>instcmds</code>-Berechtigung.</p>'
            : `<div class="command-list">${commands
                .map(
                  (command) =>
                    `<button class="command" type="button" data-command="${escapeHtml(command)}">${escapeHtml(commandLabel(command))}</button>`,
                )
                .join('')}</div>`
        }
        ${
          writable.length === 0
            ? ''
            : `<h3 class="eyebrow" style="margin-top:1.1rem">Beschreibbare Variablen</h3>
               <table class="var-table" style="margin-top:0.4rem">
                 <tbody>
                   ${writable
                     .map(
                       ([name, value]) => `<tr>
                         <td class="var-table__name">${escapeHtml(name)}</td>
                         <td>
                           <input class="filter-input" data-var="${escapeHtml(name)}" value="${escapeHtml(value)}" aria-label="Wert für ${escapeHtml(name)}" />
                           <button class="command" type="button" data-set="${escapeHtml(name)}">Setzen</button>
                         </td>
                       </tr>`,
                     )
                     .join('')}
                 </tbody>
               </table>`
        }
      </div>
    `;

    for (const button of controlPanel.querySelectorAll('[data-command]')) {
      button.addEventListener('click', () => runCommand(button));
    }
    for (const button of controlPanel.querySelectorAll('[data-set]')) {
      button.addEventListener('click', () => setVariable(button));
    }
  }

  async function runCommand(button) {
    const command = button.dataset.command;

    // Commands that cut power ask for a deliberate second click.
    if (isDisruptiveCommand(command) && button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.classList.add('command--armed');
      button.textContent = 'Wirklich ausführen?';
      setTimeout(() => {
        if (button.dataset.armed !== 'true') return;
        button.dataset.armed = 'false';
        button.classList.remove('command--armed');
        button.textContent = commandLabel(command);
      }, 6000);
      return;
    }

    button.disabled = true;
    try {
      await api.runCommand(deviceId, command);
      toast(`Befehl gesendet: ${commandLabel(command)}`);
    } catch (error) {
      toast(`Befehl abgelehnt: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.dataset.armed = 'false';
      button.classList.remove('command--armed');
      button.textContent = commandLabel(command);
    }
  }

  async function setVariable(button) {
    const name = button.dataset.set;
    const input = controlPanel.querySelector(`[data-var="${CSS.escape(name)}"]`);

    button.disabled = true;
    try {
      await api.setVariable(deviceId, name, input.value);
      toast(`${name} auf ${input.value} gesetzt`);
    } catch (error) {
      toast(`Änderung abgelehnt: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function paintVariables(device) {
    const entries = Object.entries(device.vars ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const filtered = variableFilter
      ? entries.filter(([name, value]) => `${name} ${value}`.toLowerCase().includes(variableFilter))
      : entries;

    varsPanel.innerHTML = `
      <div class="panel__head">
        <h2 class="section-title">Variablen <span class="eyebrow">${filtered.length}/${entries.length}</span></h2>
        <input class="filter-input" type="search" placeholder="filtern …" aria-label="Variablen filtern" value="${escapeHtml(variableFilter)}" />
      </div>
      <div class="panel__body" style="padding:0.75rem 0">
        ${
          filtered.length === 0
            ? '<p class="note" style="padding:0 1rem">Keine Variable passt zum Filter.</p>'
            : `<table class="var-table"><thead><tr><th>Name</th><th>Wert</th></tr></thead><tbody>${filtered
                .map(
                  ([name, value]) => `<tr>
                    <td class="var-table__name">${escapeHtml(name)}${name in (device.writableVars ?? {}) ? '<span class="var-table__rw">RW</span>' : ''}</td>
                    <td>${escapeHtml(value)}${name === 'ups.status' ? ` <span class="eyebrow">${escapeHtml(value.split(/\s+/).filter(Boolean).map((flag) => STATUS_LABELS[flag] ?? flag).join(' · '))}</span>` : ''}</td>
                  </tr>`,
                )
                .join('')}</tbody></table>`
        }
      </div>
    `;

    const input = varsPanel.querySelector('input[type="search"]');
    input.addEventListener('input', () => {
      variableFilter = input.value.trim().toLowerCase();
      const caret = input.selectionStart;
      paintVariables(currentDevice() ?? device);
      const next = varsPanel.querySelector('input[type="search"]');
      next.focus();
      next.setSelectionRange(caret, caret);
    });
  }

  let lastControlSignature = '';
  let historyRequested = false;

  function paint() {
    const device = currentDevice();

    // Before the first snapshot arrives the device is simply not known yet —
    // that is a loading state, not a missing device.
    if (!device) {
      placeholder.hidden = false;
      placeholder.innerHTML = state.loaded
        ? `<div class="empty-state__title">Gerät nicht gefunden</div>
           <p class="empty-state__text">${escapeHtml(deviceId)} wird vom NUT-Server nicht gemeldet.</p>`
        : `<div class="empty-state__title">Wird geladen</div>
           <p class="empty-state__text">Warte auf die erste Abfrage von ${escapeHtml(deviceId)}.</p>`;
      for (const panel of panels) panel.hidden = true;
      return;
    }

    placeholder.hidden = true;
    for (const panel of panels) panel.hidden = false;

    // The very first load races the first snapshot; fetch history once the
    // device is actually known.
    if (!historyRequested) {
      historyRequested = true;
      void loadHistory();
    }

    alerts.innerHTML = state.activeAlerts.filter((alert) => alert.deviceId === deviceId).map(alertBar).join('');
    paintSummary(device);

    // Rebuilding the control panel steals focus from its inputs, so only do it
    // when the command list or writable set actually changed.
    const signature = JSON.stringify([device.commands, Object.keys(device.writableVars ?? {})]);
    if (signature !== lastControlSignature) {
      lastControlSignature = signature;
      paintControls(device);
    }

    if (document.activeElement !== varsPanel.querySelector('input[type="search"]')) {
      paintVariables(device);
    }
  }

  paint();
  historyTimer = setInterval(() => void loadHistory(), 30000);

  return {
    onState: paint,
    destroy() {
      clearInterval(historyTimer);
      for (const chart of charts.values()) chart.destroy();
    },
  };
}

/* ── Events ───────────────────────────────────────────────────────────── */

function renderEvents(container) {
  const panel = document.createElement('section');
  panel.className = 'panel';
  container.append(panel);

  async function paint() {
    let events = [];
    try {
      events = await api.events(200);
    } catch (error) {
      toast(`Ereignisse konnten nicht geladen werden: ${error.message}`, 'error');
      return;
    }

    state.unacknowledged = events.filter((event) => !event.acknowledged && event.state === 'raised').length;
    updateChrome();

    panel.innerHTML = `
      <div class="panel__head">
        <h2 class="section-title">Ereignisse <span class="eyebrow">${events.length}</span></h2>
        <button class="command" type="button" data-ack-all ${state.unacknowledged === 0 ? 'disabled' : ''}>Alle bestätigen</button>
      </div>
      ${
        events.length === 0
          ? `<div class="panel__body"><div class="empty-state">
               <div class="empty-state__title">Keine Ereignisse</div>
               <p class="empty-state__text">Es gab bisher keinen Alarm. Neue Ereignisse erscheinen hier, sobald eine Regel greift.</p>
             </div></div>`
          : events
              .map(
                (event) => `<div class="event-row" data-severity="${event.severity}">
                  <span class="event-row__time">${escapeHtml(dateTime(event.ts))}</span>
                  <span>
                    <span class="event-row__title">${event.state === 'cleared' ? 'Ende · ' : ''}${escapeHtml(ruleTitle(event.rule))}</span>
                    <span class="event-row__message"> ${escapeHtml(event.message)}</span>
                  </span>
                  <span class="event-row__device">${escapeHtml(event.deviceId)}${event.acknowledged || event.state === 'cleared' ? '' : ' ·'} ${
                    event.acknowledged || event.state === 'cleared'
                      ? ''
                      : `<button class="command" type="button" data-ack="${event.id}">bestätigen</button>`
                  }</span>
                </div>`,
              )
              .join('')
      }
    `;

    panel.querySelector('[data-ack-all]')?.addEventListener('click', async () => {
      await api.acknowledgeAll();
      void paint();
    });

    for (const button of panel.querySelectorAll('[data-ack]')) {
      button.addEventListener('click', async () => {
        await api.acknowledgeEvent(Number(button.dataset.ack));
        void paint();
      });
    }
  }

  void paint();
  return { onState: () => {}, onEvent: () => void paint(), destroy() {} };
}

const RULE_TITLES = {
  unreachable: 'Verbindung verloren',
  on_battery: 'Batteriebetrieb',
  low_battery: 'Batterie kritisch',
  shutdown_imminent: 'Abschaltung eingeleitet',
  charge_low: 'Ladezustand niedrig',
  runtime_low: 'Restlaufzeit niedrig',
  overload: 'Überlast',
  replace_battery: 'Batterie tauschen',
  bypass: 'Bypass aktiv',
  temperature_high: 'Temperatur hoch',
};

function ruleTitle(rule) {
  return RULE_TITLES[rule] ?? rule;
}

/* ── Routing & live feed ──────────────────────────────────────────────── */

let view = null;

function route() {
  const hash = location.hash || '#/';
  view?.destroy();
  main.replaceChildren();

  const deviceMatch = hash.match(/^#\/device\/([^/]+)\/([^/]+)$/);
  if (deviceMatch) {
    view = renderDevice(main, `${decodeURIComponent(deviceMatch[1])}/${decodeURIComponent(deviceMatch[2])}`);
  } else if (hash.startsWith('#/events')) {
    view = renderEvents(main);
  } else if (hash.startsWith('#/konto')) {
    view = renderAccount(main, {
      user: state.user,
      onChanged: (user) => {
        state.user = user;
      },
    });
  } else if (hash.startsWith('#/servers')) {
    view = renderServers(main, {
      onChanged: () => {
        // The poller re-reads immediately; refresh so the tab count is honest
        // even before the next websocket snapshot lands.
        api.state().then(applySnapshot).catch(() => {});
      },
    });
  } else {
    view = renderOverview(main);
  }

  updateChrome();
  window.scrollTo(0, 0);
}

function applySnapshot(message) {
  state.devices = message.devices ?? state.devices;
  state.activeAlerts = message.activeAlerts ?? state.activeAlerts;
  if (message.config) state.config = message.config;
  state.loaded = true;

  updateChrome();
  view?.onState();
}

async function refreshEventCount() {
  try {
    const events = await api.events(200);
    state.unacknowledged = events.filter((event) => !event.acknowledged && event.state === 'raised').length;
    updateChrome();
  } catch {
    // The badge is not worth surfacing an error for.
  }
}

/* ── Session gate ─────────────────────────────────────────────────────── */

const nav = document.querySelector('.tabs');
const linkStrip = document.getElementById('connection-state');
const logoutButton = document.getElementById('logout');

let liveFeed = null;
let running = false;
let reGating = false;

/** Chrome that only makes sense once someone is actually looking at devices. */
function setChromeVisible(visible) {
  nav.hidden = !visible;
  linkStrip.hidden = !visible;
  logoutButton.hidden = !visible;
  if (!visible) subtitle.textContent = 'Anmeldung erforderlich';
}

function startApp() {
  if (running) return;
  running = true;

  setChromeVisible(true);
  setConnection('connecting');
  window.addEventListener('hashchange', route);
  route();

  api
    .state()
    .then(applySnapshot)
    .catch((error) => toast(`Status konnte nicht geladen werden: ${error.message}`, 'error'));

  void refreshEventCount();

  liveFeed = connectLiveFeed({
    onStateChange(status) {
      setConnection(status);
      // The upgrade is authenticated, so a dropped feed may mean the session
      // ended rather than the server going away. Ask, instead of retrying blind.
      if (status === 'lost') void verifySessionStillValid();
    },
    onMessage(message) {
      if (message.type === 'snapshot') {
        applySnapshot(message);
      } else if (message.type === 'event') {
        if (message.event.state === 'raised') {
          state.unacknowledged += 1;
          toast(
            `${ruleTitle(message.event.rule)}: ${message.event.message}`,
            message.event.severity === 'critical' ? 'error' : 'info',
          );
        }
        updateChrome();
        view?.onEvent?.();
      }
    },
  });
}

async function verifySessionStillValid() {
  if (!running || reGating) return;

  try {
    const session = await api.session();
    if (session.authEnabled && !session.authenticated) showLogin();
  } catch {
    // Server unreachable — the reconnect loop keeps trying on its own.
  }
}

function stopApp() {
  running = false;
  liveFeed?.close();
  liveFeed = null;
  view?.destroy();
  view = null;
  window.removeEventListener('hashchange', route);
  main.replaceChildren();
  state.devices = [];
  state.activeAlerts = [];
  state.loaded = false;
  setChromeVisible(false);
}

function afterAuth(user) {
  state.user = user ?? null;

  if (user?.mustChangePassword) {
    stopApp();
    renderPasswordChange(main, user, afterAuth);
    return;
  }
  startApp();
}

function showLogin() {
  stopApp();
  renderLogin(main, afterAuth);
}

/** Re-checks with the server which screen belongs on the page. */
async function gate() {
  let session;
  try {
    session = await api.session();
  } catch (error) {
    main.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">Server nicht erreichbar</div>
      <p class="empty-state__text">${escapeHtml(error.message)}</p>
    </div>`;
    setChromeVisible(false);
    return;
  }

  if (!session.authEnabled) {
    // Without authentication there is no account to show or password to change.
    logoutButton.hidden = true;
    document.getElementById('tab-konto').hidden = true;
    nav.hidden = false;
    linkStrip.hidden = false;
    startApp();
    return;
  }

  if (!session.authenticated) {
    showLogin();
    return;
  }

  afterAuth(session.user);
}

authEvents.addEventListener('lost', () => {
  if (reGating) return;
  reGating = true;
  stopApp();
  void gate().finally(() => {
    reGating = false;
  });
});

logoutButton.addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    // Even a failed call should drop the local view back to the login.
  }
  showLogin();
});

setChromeVisible(false);
void gate();
