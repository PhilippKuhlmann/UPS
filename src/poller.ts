import { EventEmitter } from 'node:events';
import type { AppConfig, NutServerConfig } from './config.js';
import { NutConnection, withNutConnection } from './nut/client.js';
import { readDevice, type SnmpTarget } from './snmp/client.js';
import { toNutVars } from './snmp/mibs.js';
import type { DeviceSnapshot, Metrics, PowerPath, Severity, SnmpDeviceRecord } from './types.js';

/** Metadata (command list, writable vars) is refreshed every N polls, not every poll. */
const METADATA_REFRESH_EVERY = 12;

/**
 * Stand-in device shown when a NUT server cannot be reached before it has ever
 * listed anything. Parentheses are not legal in a NUT device name, so this can
 * never collide with a real UPS.
 */
const SERVER_PLACEHOLDER = '(NUT-Server)';

interface ServerState {
  config: NutServerConfig;
  connection: NutConnection | null;
  /** Device ids last seen on this server, so they can be marked lost on failure. */
  knownDeviceIds: Set<string>;
  ticksSinceMetadata: number;
  /** True while the placeholder above stands in for the whole server. */
  placeholderActive: boolean;
}

interface ServerPollResult {
  snapshots: DeviceSnapshot[];
  /** Ids that should disappear from the dashboard entirely. */
  drop: string[];
}

export class Poller extends EventEmitter {
  private readonly config: AppConfig;
  private servers: ServerState[];
  private readonly snapshotsById = new Map<string, DeviceSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  /** Direkt per SNMP abgefragte Geräte, unabhängig von den NUT-Servern. */
  private snmpDevices: SnmpDeviceRecord[] = [];

  constructor(config: AppConfig, servers: NutServerConfig[] = []) {
    super();
    this.config = config;
    this.servers = servers.map((server) => createServerState(server));
  }

  /** Ersetzt die Liste der SNMP-Geräte; wirkt ab der nächsten Abfrage. */
  setSnmpDevices(devices: SnmpDeviceRecord[]): void {
    this.snmpDevices = devices;

    const configured = new Set(devices.map((device) => device.name));
    for (const id of [...this.snmpDevicesIds()]) {
      if (!configured.has(id.slice(0, id.indexOf('/')))) this.snapshotsById.delete(id);
    }

    if (this.timer) void this.poll();
  }

  /** Geräte-IDs, die aus SNMP-Quellen stammen. */
  private snmpDevicesIds(): string[] {
    const nutNames = new Set(this.servers.map((server) => server.config.name));
    return [...this.snapshotsById.keys()].filter((id) => !nutNames.has(id.slice(0, id.indexOf('/'))));
  }

  /**
   * Replaces the polled server list — the dashboard can add and remove servers
   * while running. Connections of unchanged servers are kept open; everything
   * belonging to a removed or reconfigured server is dropped.
   */
  setServers(next: NutServerConfig[]): void {
    const keep: ServerState[] = [];
    const survivingIds = new Set<string>();

    for (const server of next) {
      const existing = this.servers.find((state) => state.config.name === server.name);

      if (existing && sameConnection(existing.config, server)) {
        existing.config = server;
        keep.push(existing);
        for (const id of existing.knownDeviceIds) survivingIds.add(id);
      } else {
        // A changed host, port or credential set means the old connection and
        // everything it reported are stale.
        existing?.connection?.destroy();
        keep.push(createServerState(server));
      }
    }

    for (const state of this.servers) {
      if (!keep.includes(state)) state.connection?.destroy();
    }

    this.servers = keep;

    for (const id of [...this.snapshotsById.keys()]) {
      if (!survivingIds.has(id)) this.snapshotsById.delete(id);
    }

    // Fetch fresh data straight away instead of waiting for the next tick.
    if (this.timer) void this.poll();
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const server of this.servers) {
      server.connection?.destroy();
      server.connection = null;
    }
  }

  snapshots(): DeviceSnapshot[] {
    return [...this.snapshotsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  snapshot(id: string): DeviceSnapshot | undefined {
    return this.snapshotsById.get(id);
  }

  /**
   * Runs an instant command (`INSTCMD`) on a device. Uses a dedicated short-lived
   * connection so a slow or rejected command cannot stall the polling loop.
   */
  async runCommand(deviceId: string, command: string): Promise<void> {
    const { server, upsName } = this.resolve(deviceId);
    const snapshot = this.snapshotsById.get(deviceId);

    if (snapshot && !snapshot.commands.includes(command)) {
      throw new Error(`Device "${deviceId}" does not offer the command "${command}"`);
    }

    await withNutConnection(connectionOptions(server), (connection) =>
      connection.runCommand(upsName, command),
    );
  }

  async setVariable(deviceId: string, name: string, value: string): Promise<void> {
    const { server, upsName } = this.resolve(deviceId);
    const snapshot = this.snapshotsById.get(deviceId);

    if (snapshot && !(name in snapshot.writableVars)) {
      throw new Error(`Variable "${name}" is not writable on "${deviceId}"`);
    }

    await withNutConnection(connectionOptions(server), (connection) =>
      connection.setVar(upsName, name, value),
    );
  }

  private resolve(deviceId: string): { server: NutServerConfig; upsName: string } {
    const separator = deviceId.indexOf('/');
    const serverName = separator === -1 ? '' : deviceId.slice(0, separator);
    const upsName = separator === -1 ? '' : deviceId.slice(separator + 1);
    const server = this.servers.find((entry) => entry.config.name === serverName);

    if (!server || !upsName) {
      throw new Error(`Unknown device "${deviceId}"`);
    }
    return { server: server.config, upsName };
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // A slow server must not stack up overlapping polls.
    this.polling = true;

    try {
      const [nutResults, snmpSnapshots] = await Promise.all([
        Promise.all(this.servers.map((server) => this.pollServer(server))),
        Promise.all(this.snmpDevices.map((device) => this.pollSnmpDevice(device))),
      ]);

      const snapshots = [...nutResults.flatMap((result) => result.snapshots), ...snmpSnapshots];

      for (const id of nutResults.flatMap((result) => result.drop)) {
        this.snapshotsById.delete(id);
      }
      for (const snapshot of snapshots) {
        this.snapshotsById.set(snapshot.id, snapshot);
      }

      // Eine Abfrage, die beim Entfernen einer Quelle schon lief, liefert deren
      // Geräte noch nach. Was zu keiner konfigurierten Quelle mehr gehört,
      // fliegt hier raus.
      const configured = new Set([
        ...this.servers.map((server) => server.config.name),
        ...this.snmpDevices.map((device) => device.name),
      ]);
      for (const id of [...this.snapshotsById.keys()]) {
        if (!configured.has(id.slice(0, id.indexOf('/')))) this.snapshotsById.delete(id);
      }

      this.emit(
        'poll',
        snapshots.filter((snapshot) => configured.has(snapshot.serverName)),
      );
    } finally {
      this.polling = false;
    }
  }

  /**
   * Fragt ein Gerät direkt per SNMP ab. Anders als bei NUT steht ein Eintrag
   * für genau ein Gerät; die Geräte-ID lautet `<name>/ups`, damit Verlauf,
   * Alarme und Routen unverändert funktionieren.
   */
  private async pollSnmpDevice(device: SnmpDeviceRecord): Promise<DeviceSnapshot> {
    const id = `${device.name}/ups`;
    const previous = this.snapshotsById.get(id);

    try {
      const { profile, readings } = await readDevice(snmpTarget(device), device.profile);
      const metrics = profile.toMetrics(readings);
      const statusFlags = profile.toStatusFlags(readings);
      const identity = profile.toIdentity(readings);

      return {
        id,
        serverName: device.name,
        // Bei SNMP sind Quelle und Gerät dasselbe; als Beschriftung taugt der
        // vergebene Name mehr als ein generisches „ups".
        upsName: device.name,
        description: `${device.host} · ${profile.label}`,
        reachable: true,
        updatedAt: Date.now(),
        statusFlags,
        severity: severityFor(statusFlags),
        powerPath: powerPathFor(statusFlags),
        charging: statusFlags.includes('CHRG'),
        metrics,
        vars: toNutVars(profile, readings, metrics, statusFlags),
        writableVars: {},
        // Steuerbefehle laufen bei SNMP über Schreibzugriffe; bewusst noch nicht
        // umgesetzt, damit hier nichts scheinbar Verfügbares angeboten wird.
        commands: [],
        model: identity.model,
        manufacturer: typeof readings.manufacturer === 'string' ? readings.manufacturer.trim() : 'APC',
        serial: identity.serial,
        driver: `snmp (${profile.label})`,
      };
    } catch (error) {
      return unreachableSnapshot(previous, id, device.name, (error as Error).message);
    }
  }

  private async pollServer(server: ServerState): Promise<ServerPollResult> {
    try {
      if (!server.connection || !server.connection.isOpen) {
        server.connection = await NutConnection.connect(connectionOptions(server.config));
        server.ticksSinceMetadata = METADATA_REFRESH_EVERY;
      }

      const connection = server.connection;
      const refreshMetadata = ++server.ticksSinceMetadata >= METADATA_REFRESH_EVERY;
      if (refreshMetadata) server.ticksSinceMetadata = 0;

      const list = await connection.listUps();
      const snapshots: DeviceSnapshot[] = [];
      const seen = new Set<string>();

      for (const entry of list) {
        const id = `${server.config.name}/${entry.name}`;
        seen.add(id);

        const vars = await connection.listVars(entry.name);
        const previous = this.snapshotsById.get(id);

        let commands = previous?.commands ?? [];
        let writableVars = previous?.writableVars ?? {};

        if (refreshMetadata || !previous) {
          commands = await safely(() => connection.listCommands(entry.name), []);
          writableVars = await safely(() => connection.listWritableVars(entry.name), {});
        }

        snapshots.push(buildSnapshot({
          id,
          serverName: server.config.name,
          upsName: entry.name,
          description: entry.description,
          vars,
          commands,
          writableVars,
        }));
      }

      // A UPS that disappeared from LIST UPS is reported as lost, not silently dropped.
      for (const id of server.knownDeviceIds) {
        if (!seen.has(id)) {
          snapshots.push(unreachableSnapshot(this.snapshotsById.get(id), id, server.config.name, 'Gerät wird vom NUT-Server nicht mehr geführt'));
        }
      }
      server.knownDeviceIds = seen;

      // The server answered, so a placeholder from an earlier outage is obsolete.
      const drop: string[] = [];
      if (server.placeholderActive) {
        server.placeholderActive = false;
        drop.push(`${server.config.name}/${SERVER_PLACEHOLDER}`);
      }

      return { snapshots, drop };
    } catch (error) {
      server.connection?.destroy();
      server.connection = null;

      const message = (error as Error).message;

      if (server.knownDeviceIds.size === 0) {
        server.placeholderActive = true;
        const id = `${server.config.name}/${SERVER_PLACEHOLDER}`;
        const snapshot = unreachableSnapshot(this.snapshotsById.get(id), id, server.config.name, message);
        snapshot.description = `${server.config.host}:${server.config.port} — noch kein Gerät gemeldet`;
        return { snapshots: [snapshot], drop: [] };
      }

      return {
        snapshots: [...server.knownDeviceIds].map((id) =>
          unreachableSnapshot(this.snapshotsById.get(id), id, server.config.name, message),
        ),
        drop: [],
      };
    }
  }
}

export function snmpTarget(device: SnmpDeviceRecord): SnmpTarget {
  return {
    host: device.host,
    port: device.port,
    version: device.version,
    community: device.community,
    securityLevel: device.securityLevel,
    securityName: device.securityName,
    authProtocol: device.authProtocol,
    authPassword: device.authPassword,
    privProtocol: device.privProtocol,
    privPassword: device.privPassword,
  };
}

function createServerState(config: NutServerConfig): ServerState {
  return {
    config,
    connection: null,
    knownDeviceIds: new Set(),
    ticksSinceMetadata: METADATA_REFRESH_EVERY,
    placeholderActive: false,
  };
}

/** True when two configurations would open the identical connection. */
function sameConnection(a: NutServerConfig, b: NutServerConfig): boolean {
  return a.host === b.host && a.port === b.port && a.username === b.username && a.password === b.password;
}

function connectionOptions(server: NutServerConfig) {
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password,
  };
}

async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function unreachableSnapshot(
  previous: DeviceSnapshot | undefined,
  id: string,
  serverName: string,
  error: string,
): DeviceSnapshot {
  const upsName = id.slice(id.indexOf('/') + 1);

  return {
    id,
    serverName,
    upsName,
    description: previous?.description ?? '',
    reachable: false,
    error,
    updatedAt: Date.now(),
    statusFlags: [],
    severity: 'critical',
    powerPath: 'unknown',
    charging: false,
    metrics: {},
    vars: previous?.vars ?? {},
    writableVars: previous?.writableVars ?? {},
    commands: previous?.commands ?? [],
    model: previous?.model ?? '',
    manufacturer: previous?.manufacturer ?? '',
    serial: previous?.serial ?? '',
    driver: previous?.driver ?? '',
  };
}

interface SnapshotInput {
  id: string;
  serverName: string;
  upsName: string;
  description: string;
  vars: Record<string, string>;
  commands: string[];
  writableVars: Record<string, string>;
}

export function buildSnapshot(input: SnapshotInput): DeviceSnapshot {
  const { vars } = input;
  const statusFlags = (vars['ups.status'] ?? '').split(/\s+/).filter(Boolean);

  return {
    id: input.id,
    serverName: input.serverName,
    upsName: input.upsName,
    description: input.description || vars['device.description'] || '',
    reachable: true,
    updatedAt: Date.now(),
    statusFlags,
    severity: severityFor(statusFlags),
    powerPath: powerPathFor(statusFlags),
    charging: statusFlags.includes('CHRG'),
    metrics: metricsFrom(vars),
    vars,
    writableVars: input.writableVars,
    commands: input.commands,
    model: vars['ups.model'] ?? vars['device.model'] ?? '',
    manufacturer: vars['ups.mfr'] ?? vars['device.mfr'] ?? '',
    serial: vars['ups.serial'] ?? vars['device.serial'] ?? '',
    driver: vars['driver.name'] ?? '',
  };
}

function metricsFrom(vars: Record<string, string>): Metrics {
  const metrics: Metrics = {};

  const assign = (key: keyof Metrics, ...names: string[]) => {
    for (const name of names) {
      const value = Number(vars[name]);
      if (vars[name] !== undefined && Number.isFinite(value)) {
        metrics[key] = value;
        return;
      }
    }
  };

  assign('charge', 'battery.charge');
  assign('load', 'ups.load');
  assign('runtimeSeconds', 'battery.runtime');
  assign('inputVoltage', 'input.voltage', 'input.L1-N.voltage');
  assign('outputVoltage', 'output.voltage', 'output.L1-N.voltage');
  assign('batteryVoltage', 'battery.voltage');
  assign('inputFrequency', 'input.frequency');
  assign('realPower', 'ups.realpower', 'output.realpower');
  assign('apparentPower', 'ups.power');
  assign('nominalPower', 'ups.realpower.nominal', 'ups.power.nominal');
  assign('temperature', 'ups.temperature', 'battery.temperature');

  // Some drivers report only load percentage and a nominal rating; derive watts
  // so the dashboard can still show a power figure.
  if (metrics.realPower === undefined && metrics.load !== undefined && metrics.nominalPower !== undefined) {
    metrics.realPower = Math.round((metrics.load / 100) * metrics.nominalPower);
  }

  return metrics;
}

function powerPathFor(flags: string[]): PowerPath {
  if (flags.includes('OFF')) return 'off';
  if (flags.includes('BYPASS')) return 'bypass';
  if (flags.includes('OB')) return 'battery';
  if (flags.includes('OL')) return 'mains';
  return 'unknown';
}

function severityFor(flags: string[]): Severity {
  if (flags.includes('LB') || flags.includes('FSD') || flags.includes('OFF')) return 'critical';
  if (flags.includes('OB') || flags.includes('RB') || flags.includes('OVER') || flags.includes('ALARM')) {
    return 'serious';
  }
  if (flags.includes('BYPASS') || flags.includes('CAL') || flags.includes('DISCHRG')) return 'warning';
  if (flags.length === 0) return 'warning';
  return 'good';
}
