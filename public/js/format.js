/** Display formatting and the German vocabulary of the interface. */

const NBSP = ' ';

/** NUT status flags, in the order a person reads them off the front panel. */
export const STATUS_LABELS = {
  OL: 'Netzbetrieb',
  OB: 'Batteriebetrieb',
  LB: 'Batterie schwach',
  HB: 'Batterie voll',
  RB: 'Batterie tauschen',
  CHRG: 'lädt',
  DISCHRG: 'entlädt',
  BYPASS: 'Bypass',
  CAL: 'Kalibrierung',
  OFF: 'Ausgang aus',
  OVER: 'Überlast',
  TRIM: 'senkt Spannung',
  BOOST: 'hebt Spannung',
  FSD: 'Abschaltung läuft',
  ALARM: 'Alarm',
};

export const SEVERITY_GLYPHS = {
  good: '●',
  warning: '▲',
  serious: '▲',
  critical: '■',
};

export const POWER_PATH_LABELS = {
  mains: 'Netzbetrieb',
  battery: 'Batteriebetrieb',
  bypass: 'Bypass',
  off: 'Ausgang aus',
  unknown: 'Zustand unbekannt',
};

/** The one status line shown on the card: path first, then the notable flags. */
export function headlineStatus(device) {
  if (!device.reachable) return 'Nicht erreichbar';

  const base = POWER_PATH_LABELS[device.powerPath] ?? POWER_PATH_LABELS.unknown;
  const extras = device.statusFlags
    .filter((flag) => !['OL', 'OB', 'BYPASS', 'OFF'].includes(flag))
    .map((flag) => STATUS_LABELS[flag] ?? flag);

  return extras.length > 0 ? `${base} · ${extras.join(' · ')}` : base;
}

export function number(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Runtime reads as a duration, not as a count of seconds. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}${NBSP}s`;

  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}${NBSP}min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}${NBSP}h` : `${hours}${NBSP}h${NBSP}${minutes}${NBSP}min`;
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortTime(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(ts) {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function relativeTime(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return 'gerade eben';
  if (seconds < 60) return `vor ${seconds}${NBSP}s`;
  if (seconds < 3600) return `vor ${Math.round(seconds / 60)}${NBSP}min`;
  if (seconds < 86400) return `vor ${Math.round(seconds / 3600)}${NBSP}h`;
  return `vor ${Math.round(seconds / 86400)}${NBSP}Tagen`;
}

/** Turns `test.battery.start.quick` into `Batterietest starten (kurz)`. */
const COMMAND_LABELS = {
  'beeper.disable': 'Signalton abschalten',
  'beeper.enable': 'Signalton einschalten',
  'beeper.mute': 'Signalton stummschalten',
  'beeper.toggle': 'Signalton umschalten',
  'test.battery.start': 'Batterietest starten',
  'test.battery.start.quick': 'Batterietest starten (kurz)',
  'test.battery.start.deep': 'Batterietest starten (lang)',
  'test.battery.stop': 'Batterietest abbrechen',
  'test.panel.start': 'Anzeigetest starten',
  'test.panel.stop': 'Anzeigetest abbrechen',
  'calibrate.start': 'Kalibrierung starten',
  'calibrate.stop': 'Kalibrierung abbrechen',
  'load.on': 'Ausgang einschalten',
  'load.off': 'Ausgang abschalten',
  'shutdown.return': 'Herunterfahren, dann zurückkehren',
  'shutdown.stayoff': 'Herunterfahren und aus bleiben',
  'shutdown.reboot': 'Ausgang aus- und wieder einschalten',
  'shutdown.reboot.graceful': 'Geordnet aus- und wieder einschalten',
  'shutdown.stop': 'Abschaltung abbrechen',
  'bypass.start': 'Bypass einschalten',
  'bypass.stop': 'Bypass ausschalten',
};

export function commandLabel(command) {
  return COMMAND_LABELS[command] ?? command;
}

/**
 * Commands that cut power to the load need a second, deliberate click. Every
 * `shutdown.*` counts — including `shutdown.reboot`, which power-cycles
 * everything plugged in — except `shutdown.stop`, which calls one off.
 */
export function isDisruptiveCommand(command) {
  if (command === 'shutdown.stop') return false;
  return /^(shutdown\.|load\.off|bypass\.)/.test(command);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
