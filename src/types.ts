export type Severity = 'good' | 'warning' | 'serious' | 'critical';

/** The four power paths the front panel diagram can draw. */
export type PowerPath = 'mains' | 'battery' | 'bypass' | 'off' | 'unknown';

export interface Metrics {
  charge?: number;
  load?: number;
  runtimeSeconds?: number;
  inputVoltage?: number;
  outputVoltage?: number;
  batteryVoltage?: number;
  inputFrequency?: number;
  realPower?: number;
  apparentPower?: number;
  nominalPower?: number;
  temperature?: number;
}

export interface DeviceSnapshot {
  /** `<serverName>/<upsName>` — stable across restarts, used everywhere as the key. */
  id: string;
  serverName: string;
  upsName: string;
  description: string;
  /** True when the last poll reached the server and the driver answered. */
  reachable: boolean;
  error?: string;
  updatedAt: number;
  /** Raw `ups.status` flags, e.g. `['OL', 'CHRG']`. */
  statusFlags: string[];
  severity: Severity;
  powerPath: PowerPath;
  charging: boolean;
  metrics: Metrics;
  vars: Record<string, string>;
  writableVars: Record<string, string>;
  commands: string[];
  model: string;
  manufacturer: string;
  serial: string;
  driver: string;
}

export interface AlertEvent {
  id: number;
  deviceId: string;
  rule: string;
  severity: Severity;
  /**
   * `raised` when a condition started, `cleared` when it ended, `executed` for
   * an entry in the audit trail — a command or a variable someone changed.
   */
  state: 'raised' | 'cleared' | 'executed';
  message: string;
  value: number | null;
  ts: number;
  acknowledged: boolean;
  /** Username behind an `executed` entry; null for anything the poller found. */
  actor: string | null;
}

/** A NUT server as stored in the database — the source of truth at runtime. */
export interface NutServerRecord {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The same record with the password removed, for anything leaving the server. */
export type NutServerPublic = Omit<NutServerRecord, 'password'> & { hasPassword: boolean };

/**
 * Eine USV, die direkt über SNMP abgefragt wird — typischerweise eine
 * Netzwerkkarte wie die APC NMC. Anders als bei NUT steht ein Eintrag hier für
 * genau ein Gerät, nicht für einen Server mit mehreren.
 */
export interface SnmpDeviceRecord {
  id: number;
  name: string;
  host: string;
  port: number;
  /** `1`, `2c` oder `3`. */
  version: string;
  community: string | null;
  securityLevel: string | null;
  securityName: string | null;
  authProtocol: string | null;
  authPassword: string | null;
  privProtocol: string | null;
  privPassword: string | null;
  /** `apc`, `rfc1628` oder null für automatische Erkennung. */
  profile: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SnmpDevicePublic = Omit<
  SnmpDeviceRecord,
  'community' | 'authPassword' | 'privPassword'
> & {
  hasCommunity: boolean;
  hasAuthPassword: boolean;
  hasPrivPassword: boolean;
};

export interface HistoryPoint {
  t: number;
  charge: number | null;
  load: number | null;
  runtimeSeconds: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  batteryVoltage: number | null;
  realPower: number | null;
  temperature: number | null;
}
