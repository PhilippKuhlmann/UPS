import { EventEmitter } from 'node:events';
import type { AlertThresholds } from './config.js';
import { messageForEvent, type Notifier } from './notify.js';
import type { Store } from './store.js';
import type { AlertEvent, DeviceSnapshot, Severity } from './types.js';

interface RuleResult {
  active: boolean;
  message: string;
  value?: number | undefined;
}

interface Rule {
  key: string;
  severity: Severity;
  /** Human label for the rule, shown in the events list. */
  title: string;
  evaluate: (snapshot: DeviceSnapshot, thresholds: AlertThresholds) => RuleResult;
}

const INACTIVE: RuleResult = { active: false, message: '' };

const RULES: Rule[] = [
  {
    key: 'unreachable',
    severity: 'critical',
    title: 'Verbindung verloren',
    evaluate: (snapshot) =>
      snapshot.reachable
        ? INACTIVE
        : { active: true, message: snapshot.error ?? 'NUT-Server nicht erreichbar' },
  },
  {
    key: 'on_battery',
    severity: 'serious',
    title: 'Batteriebetrieb',
    evaluate: (snapshot) =>
      snapshot.reachable && snapshot.statusFlags.includes('OB')
        ? { active: true, message: 'Netzstrom ausgefallen — Gerät läuft auf Batterie', value: snapshot.metrics.charge }
        : INACTIVE,
  },
  {
    key: 'low_battery',
    severity: 'critical',
    title: 'Batterie kritisch',
    evaluate: (snapshot) =>
      snapshot.reachable && snapshot.statusFlags.includes('LB')
        ? { active: true, message: 'USV meldet niedrigen Batteriestand (LB)', value: snapshot.metrics.charge }
        : INACTIVE,
  },
  {
    key: 'shutdown_imminent',
    severity: 'critical',
    title: 'Abschaltung eingeleitet',
    evaluate: (snapshot) =>
      snapshot.reachable && snapshot.statusFlags.includes('FSD')
        ? { active: true, message: 'Erzwungene Abschaltung aktiv (FSD)' }
        : INACTIVE,
  },
  {
    key: 'charge_low',
    severity: 'serious',
    title: 'Ladezustand niedrig',
    evaluate: (snapshot, thresholds) => {
      const charge = snapshot.metrics.charge;
      if (!snapshot.reachable || charge === undefined || charge >= thresholds.chargeBelow) return INACTIVE;
      return {
        active: true,
        message: `Ladezustand ${charge} % liegt unter der Schwelle von ${thresholds.chargeBelow} %`,
        value: charge,
      };
    },
  },
  {
    key: 'runtime_low',
    severity: 'serious',
    title: 'Restlaufzeit niedrig',
    evaluate: (snapshot, thresholds) => {
      const runtime = snapshot.metrics.runtimeSeconds;
      if (!snapshot.reachable || runtime === undefined || runtime >= thresholds.runtimeBelowSeconds) {
        return INACTIVE;
      }
      return {
        active: true,
        message: `Restlaufzeit ${Math.round(runtime / 60)} min liegt unter der Schwelle von ${Math.round(thresholds.runtimeBelowSeconds / 60)} min`,
        value: runtime,
      };
    },
  },
  {
    key: 'overload',
    severity: 'serious',
    title: 'Überlast',
    evaluate: (snapshot, thresholds) => {
      if (!snapshot.reachable) return INACTIVE;
      if (snapshot.statusFlags.includes('OVER')) {
        return { active: true, message: 'USV meldet Überlast (OVER)', value: snapshot.metrics.load };
      }
      const load = snapshot.metrics.load;
      if (load === undefined || load <= thresholds.loadAbove) return INACTIVE;
      return {
        active: true,
        message: `Last ${load} % liegt über der Schwelle von ${thresholds.loadAbove} %`,
        value: load,
      };
    },
  },
  {
    key: 'replace_battery',
    severity: 'serious',
    title: 'Batterie tauschen',
    evaluate: (snapshot) =>
      snapshot.reachable && snapshot.statusFlags.includes('RB')
        ? { active: true, message: 'USV fordert Batteriewechsel (RB)' }
        : INACTIVE,
  },
  {
    key: 'bypass',
    severity: 'warning',
    title: 'Bypass aktiv',
    evaluate: (snapshot) =>
      snapshot.reachable && snapshot.statusFlags.includes('BYPASS')
        ? { active: true, message: 'Last hängt am Bypass — kein Batterieschutz' }
        : INACTIVE,
  },
  {
    key: 'temperature_high',
    severity: 'warning',
    title: 'Temperatur hoch',
    evaluate: (snapshot, thresholds) => {
      const temperature = snapshot.metrics.temperature;
      if (!snapshot.reachable || temperature === undefined || temperature <= thresholds.temperatureAbove) {
        return INACTIVE;
      }
      return {
        active: true,
        message: `Temperatur ${temperature} °C liegt über der Schwelle von ${thresholds.temperatureAbove} °C`,
        value: temperature,
      };
    },
  },
];

export interface ActiveAlert {
  deviceId: string;
  rule: string;
  title: string;
  severity: Severity;
  message: string;
  since: number;
}

/**
 * Turns each poll into alert transitions. A rule that becomes true emits a
 * `raised` event once; when it goes false again it emits `cleared` once. Steady
 * state produces nothing, so the event log stays readable.
 */
export class AlertEngine extends EventEmitter {
  private readonly store: Store;
  private readonly thresholds: AlertThresholds;
  private readonly notifier: Notifier;
  private readonly active = new Map<string, ActiveAlert>();

  constructor(store: Store, thresholds: AlertThresholds, notifier: Notifier) {
    super();
    this.store = store;
    this.thresholds = thresholds;
    this.notifier = notifier;
  }

  activeAlerts(): ActiveAlert[] {
    return [...this.active.values()].sort((a, b) => a.since - b.since);
  }

  activeAlertsFor(deviceId: string): ActiveAlert[] {
    return this.activeAlerts().filter((alert) => alert.deviceId === deviceId);
  }

  evaluate(snapshots: DeviceSnapshot[]): AlertEvent[] {
    const emitted: AlertEvent[] = [];

    for (const snapshot of snapshots) {
      for (const rule of RULES) {
        const key = `${snapshot.id}::${rule.key}`;
        const result = rule.evaluate(snapshot, this.thresholds);
        const wasActive = this.active.get(key);

        if (result.active && !wasActive) {
          this.active.set(key, {
            deviceId: snapshot.id,
            rule: rule.key,
            title: rule.title,
            severity: rule.severity,
            message: result.message,
            since: snapshot.updatedAt,
          });
          emitted.push(this.record(snapshot, rule, 'raised', result.message, result.value));
        } else if (!result.active && wasActive) {
          this.active.delete(key);
          emitted.push(this.record(snapshot, rule, 'cleared', `${rule.title} beendet`, result.value));
        }
      }
    }

    return emitted;
  }

  private record(
    snapshot: DeviceSnapshot,
    rule: Rule,
    state: 'raised' | 'cleared',
    message: string,
    value: number | undefined,
  ): AlertEvent {
    const event = this.store.addEvent({
      deviceId: snapshot.id,
      rule: rule.key,
      severity: state === 'cleared' ? 'good' : rule.severity,
      state,
      message,
      value: value ?? null,
      ts: snapshot.updatedAt,
      actor: null,
    });

    this.emit('alert', event);

    if (this.notifier.shouldSend(event)) {
      void this.notifier.notify(messageForEvent(event, rule.title, snapshot));
    }

    return event;
  }
}

/** Titles by rule key, so other modules can label an event the same way. */
export const RULE_TITLES: Record<string, string> = Object.fromEntries(
  RULES.map((rule) => [rule.key, rule.title]),
);
