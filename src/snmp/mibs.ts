/**
 * Zwei MIB-Profile statt hunderter Gerätedefinitionen: die APC PowerNet-MIB
 * (Enterprise 318) und die herstellerübergreifende USV-MIB nach RFC 1628.
 * Zusammen decken sie fast alle netzwerkfähigen USVs ab; welche davon greift,
 * ermittelt `detectProfile` am Gerät selbst.
 */
import type { Metrics } from '../types.js';

export type ProfileName = 'apc' | 'rfc1628';

/** Rohwerte, wie sie von der Abfrage zurückkommen: OID-Name → Zahl oder Text. */
export type Readings = Record<string, number | string | null>;

export interface MibProfile {
  name: ProfileName;
  label: string;
  /** Antwortet dieses OID, passt das Profil. */
  probeOid: string;
  /** Feldname → OID. Fehlende Felder werden übersprungen. */
  oids: Record<string, string>;
  toMetrics: (readings: Readings) => Metrics;
  toStatusFlags: (readings: Readings) => string[];
  toIdentity: (readings: Readings) => { model: string; serial: string; firmware: string };
}

function num(readings: Readings, key: string): number | undefined {
  const value = readings[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function text(readings: Readings, key: string): string {
  const value = readings[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Übernimmt nur Felder, die tatsächlich einen Wert haben. */
function assign(metrics: Metrics, key: keyof Metrics, value: number | undefined, scale = 1): void {
  if (value === undefined) return;
  metrics[key] = Math.round(value * scale * 100) / 100;
}

// ── APC PowerNet-MIB ───────────────────────────────────────────────────────

export const APC_PROFILE: MibProfile = {
  name: 'apc',
  label: 'APC PowerNet',
  probeOid: '1.3.6.1.4.1.318.1.1.1.1.1.1.0',
  oids: {
    model: '1.3.6.1.4.1.318.1.1.1.1.1.1.0',
    firmware: '1.3.6.1.4.1.318.1.1.1.1.2.1.0',
    serial: '1.3.6.1.4.1.318.1.1.1.1.2.3.0',
    batteryStatus: '1.3.6.1.4.1.318.1.1.1.2.1.1.0',
    secondsOnBattery: '1.3.6.1.4.1.318.1.1.1.2.1.2.0',
    charge: '1.3.6.1.4.1.318.1.1.1.2.2.1.0',
    batteryTemperature: '1.3.6.1.4.1.318.1.1.1.2.2.2.0',
    runtimeTicks: '1.3.6.1.4.1.318.1.1.1.2.2.3.0',
    replaceBattery: '1.3.6.1.4.1.318.1.1.1.2.2.4.0',
    batteryVoltage: '1.3.6.1.4.1.318.1.1.1.2.2.8.0',
    inputVoltage: '1.3.6.1.4.1.318.1.1.1.3.2.1.0',
    inputFrequency: '1.3.6.1.4.1.318.1.1.1.3.2.4.0',
    outputStatus: '1.3.6.1.4.1.318.1.1.1.4.1.1.0',
    outputVoltage: '1.3.6.1.4.1.318.1.1.1.4.2.1.0',
    outputLoad: '1.3.6.1.4.1.318.1.1.1.4.2.3.0',
    outputCurrent: '1.3.6.1.4.1.318.1.1.1.4.2.4.0',
    outputPower: '1.3.6.1.4.1.318.1.1.1.4.2.8.0',
  },

  toMetrics(readings) {
    const metrics: Metrics = {};
    assign(metrics, 'charge', num(readings, 'charge'));
    assign(metrics, 'load', num(readings, 'outputLoad'));
    // TimeTicks zählen Hundertstelsekunden.
    assign(metrics, 'runtimeSeconds', num(readings, 'runtimeTicks'), 0.01);
    assign(metrics, 'inputVoltage', num(readings, 'inputVoltage'));
    assign(metrics, 'outputVoltage', num(readings, 'outputVoltage'));
    assign(metrics, 'batteryVoltage', num(readings, 'batteryVoltage'));
    assign(metrics, 'inputFrequency', num(readings, 'inputFrequency'));
    assign(metrics, 'realPower', num(readings, 'outputPower'));
    assign(metrics, 'temperature', num(readings, 'batteryTemperature'));
    return metrics;
  },

  toStatusFlags(readings) {
    const flags: string[] = [];
    const output = num(readings, 'outputStatus');
    const battery = num(readings, 'batteryStatus');

    // upsBasicOutputStatus laut PowerNet-MIB.
    switch (output) {
      case 2:
        flags.push('OL');
        break;
      case 3:
        flags.push('OB', 'DISCHRG');
        break;
      case 4:
        flags.push('OL', 'BOOST');
        break;
      case 12:
        flags.push('OL', 'TRIM');
        break;
      case 6:
      case 9:
      case 10:
        flags.push('BYPASS');
        break;
      case 5:
      case 7:
      case 11:
        flags.push('OFF');
        break;
      case 8:
        flags.push('OL');
        break;
      default:
        break;
    }

    if (battery === 3) flags.push('LB');
    if (num(readings, 'replaceBattery') === 2) flags.push('RB');
    if (flags.includes('OL') && (num(readings, 'charge') ?? 100) < 100) flags.push('CHRG');

    return flags;
  },

  toIdentity(readings) {
    return {
      model: text(readings, 'model'),
      serial: text(readings, 'serial'),
      firmware: text(readings, 'firmware'),
    };
  },
};

// ── Standard-USV-MIB (RFC 1628) ────────────────────────────────────────────

export const RFC1628_PROFILE: MibProfile = {
  name: 'rfc1628',
  label: 'Standard-USV-MIB (RFC 1628)',
  probeOid: '1.3.6.1.2.1.33.1.1.2.0',
  oids: {
    manufacturer: '1.3.6.1.2.1.33.1.1.1.0',
    model: '1.3.6.1.2.1.33.1.1.2.0',
    firmware: '1.3.6.1.2.1.33.1.1.3.0',
    batteryStatus: '1.3.6.1.2.1.33.1.2.1.0',
    secondsOnBattery: '1.3.6.1.2.1.33.1.2.2.0',
    minutesRemaining: '1.3.6.1.2.1.33.1.2.3.0',
    charge: '1.3.6.1.2.1.33.1.2.4.0',
    batteryVoltage: '1.3.6.1.2.1.33.1.2.5.0',
    batteryTemperature: '1.3.6.1.2.1.33.1.2.7.0',
    // Die Ein- und Ausgangswerte stehen in Tabellen; Index 1 ist die erste Phase.
    inputFrequency: '1.3.6.1.2.1.33.1.3.3.1.2.1',
    inputVoltage: '1.3.6.1.2.1.33.1.3.3.1.3.1',
    outputSource: '1.3.6.1.2.1.33.1.4.1.0',
    outputFrequency: '1.3.6.1.2.1.33.1.4.2.0',
    outputVoltage: '1.3.6.1.2.1.33.1.4.4.1.2.1',
    outputCurrent: '1.3.6.1.2.1.33.1.4.4.1.3.1',
    outputPower: '1.3.6.1.2.1.33.1.4.4.1.4.1',
    outputLoad: '1.3.6.1.2.1.33.1.4.4.1.5.1',
  },

  toMetrics(readings) {
    const metrics: Metrics = {};
    assign(metrics, 'charge', num(readings, 'charge'));
    assign(metrics, 'load', num(readings, 'outputLoad'));
    assign(metrics, 'runtimeSeconds', num(readings, 'minutesRemaining'), 60);
    assign(metrics, 'inputVoltage', num(readings, 'inputVoltage'));
    assign(metrics, 'outputVoltage', num(readings, 'outputVoltage'));
    // RFC 1628 führt Batteriespannung und Frequenz in Zehntelschritten.
    assign(metrics, 'batteryVoltage', num(readings, 'batteryVoltage'), 0.1);
    assign(metrics, 'inputFrequency', num(readings, 'inputFrequency'), 0.1);
    assign(metrics, 'realPower', num(readings, 'outputPower'));
    assign(metrics, 'temperature', num(readings, 'batteryTemperature'));
    return metrics;
  },

  toStatusFlags(readings) {
    const flags: string[] = [];
    const source = num(readings, 'outputSource');
    const battery = num(readings, 'batteryStatus');

    // upsOutputSource laut RFC 1628.
    switch (source) {
      case 3:
        flags.push('OL');
        break;
      case 5:
        flags.push('OB', 'DISCHRG');
        break;
      case 4:
        flags.push('BYPASS');
        break;
      case 6:
        flags.push('OL', 'BOOST');
        break;
      case 7:
        flags.push('OL', 'TRIM');
        break;
      case 2:
        flags.push('OFF');
        break;
      default:
        break;
    }

    if (battery === 3 || battery === 4) flags.push('LB');
    if (flags.includes('OL') && (num(readings, 'charge') ?? 100) < 100) flags.push('CHRG');

    return flags;
  },

  toIdentity(readings) {
    return {
      model: text(readings, 'model'),
      serial: '',
      firmware: text(readings, 'firmware'),
    };
  },
};

export const PROFILES: MibProfile[] = [APC_PROFILE, RFC1628_PROFILE];

export function profileByName(name: string): MibProfile | undefined {
  return PROFILES.find((profile) => profile.name === name);
}

/**
 * Baut aus den Rohwerten die Variablenliste, die die Oberfläche schon kennt —
 * damit sehen SNMP-Geräte in der Variablentabelle aus wie NUT-Geräte.
 */
export function toNutVars(profile: MibProfile, readings: Readings, metrics: Metrics, flags: string[]) {
  const vars: Record<string, string> = {};
  const put = (key: string, value: number | string | undefined) => {
    if (value !== undefined && value !== null && value !== '') vars[key] = String(value);
  };

  put('ups.status', flags.join(' '));
  put('battery.charge', metrics.charge);
  put('battery.runtime', metrics.runtimeSeconds);
  put('battery.voltage', metrics.batteryVoltage);
  put('ups.load', metrics.load);
  put('ups.realpower', metrics.realPower);
  put('ups.temperature', metrics.temperature);
  put('input.voltage', metrics.inputVoltage);
  put('input.frequency', metrics.inputFrequency);
  put('output.voltage', metrics.outputVoltage);
  put('output.current', num(readings, 'outputCurrent'));
  put('driver.name', `snmp (${profile.label})`);

  const identity = profile.toIdentity(readings);
  put('ups.model', identity.model);
  put('ups.serial', identity.serial);
  put('ups.firmware', identity.firmware);
  put('ups.mfr', text(readings, 'manufacturer'));

  // Alles Abgefragte zusätzlich roh, damit nichts stillschweigend verlorengeht.
  for (const [key, value] of Object.entries(readings)) {
    if (value !== null && value !== undefined) vars[`snmp.${key}`] = String(value);
  }

  return vars;
}
