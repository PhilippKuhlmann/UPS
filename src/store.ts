import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AlertEvent, DeviceSnapshot, HistoryPoint, NutServerRecord, Severity } from './types.js';

export interface ServerInput {
  name: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  enabled?: boolean;
}

export interface HistoryQuery {
  deviceId: string;
  /** Inclusive lower bound, epoch milliseconds. */
  from: number;
  /** Inclusive upper bound, epoch milliseconds. */
  to: number;
  /** Target number of points; samples are averaged into that many buckets. */
  points?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  device_id      TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  status         TEXT,
  charge         REAL,
  load           REAL,
  runtime        REAL,
  input_voltage  REAL,
  output_voltage REAL,
  battery_voltage REAL,
  real_power     REAL,
  temperature    REAL
);
CREATE INDEX IF NOT EXISTS idx_samples_device_ts ON samples (device_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    TEXT    NOT NULL,
  rule         TEXT    NOT NULL,
  severity     TEXT    NOT NULL,
  state        TEXT    NOT NULL,
  message      TEXT    NOT NULL,
  value        REAL,
  ts           INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_device ON events (device_id, ts DESC);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  password_changed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nut_servers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  host       TEXT    NOT NULL,
  port       INTEGER NOT NULL DEFAULT 3493,
  username   TEXT,
  password   TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface SampleRow {
  t: number;
  charge: number | null;
  load: number | null;
  runtime: number | null;
  input_voltage: number | null;
  output_voltage: number | null;
  battery_voltage: number | null;
  real_power: number | null;
  temperature: number | null;
}

interface EventRow {
  id: number;
  device_id: string;
  rule: string;
  severity: string;
  state: string;
  message: string;
  value: number | null;
  ts: number;
  acknowledged: number;
  actor: string | null;
}

export class Store {
  private readonly db: Database.Database;
  private readonly insertSample: Database.Statement;
  private readonly insertEvent: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrate();

    this.insertSample = this.db.prepare(`
      INSERT INTO samples (device_id, ts, status, charge, load, runtime,
                           input_voltage, output_voltage, battery_voltage, real_power, temperature)
      VALUES (@device_id, @ts, @status, @charge, @load, @runtime,
              @input_voltage, @output_voltage, @battery_voltage, @real_power, @temperature)
    `);

    this.insertEvent = this.db.prepare(`
      INSERT INTO events (device_id, rule, severity, state, message, value, ts, actor)
      VALUES (@device_id, @rule, @severity, @state, @message, @value, @ts, @actor)
    `);
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` never touches an existing table, so columns
   * added after the fact need their own step for databases already in service.
   */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[];

    if (!columns.some((column) => column.name === 'actor')) {
      this.db.exec('ALTER TABLE events ADD COLUMN actor TEXT');
    }
  }

  /** Handed to AuthService, which owns the `users` and `sessions` tables. */
  get database(): Database.Database {
    return this.db;
  }

  recordSample(snapshot: DeviceSnapshot): void {
    if (!snapshot.reachable) return;

    const m = snapshot.metrics;
    this.insertSample.run({
      device_id: snapshot.id,
      ts: snapshot.updatedAt,
      status: snapshot.statusFlags.join(' '),
      charge: m.charge ?? null,
      load: m.load ?? null,
      runtime: m.runtimeSeconds ?? null,
      input_voltage: m.inputVoltage ?? null,
      output_voltage: m.outputVoltage ?? null,
      battery_voltage: m.batteryVoltage ?? null,
      real_power: m.realPower ?? null,
      temperature: m.temperature ?? null,
    });
  }

  /**
   * Returns averaged buckets rather than raw samples: a 30-day window at a 5 s
   * poll interval is half a million rows, and a chart only needs a few hundred.
   */
  history(query: HistoryQuery): HistoryPoint[] {
    const points = Math.max(20, Math.min(query.points ?? 300, 2000));
    const span = Math.max(1, query.to - query.from);
    const bucket = Math.max(1000, Math.round(span / points));

    const rows = this.db
      .prepare(
        `
        SELECT (ts / ?) * ? AS t,
               AVG(charge)          AS charge,
               AVG(load)            AS load,
               AVG(runtime)         AS runtime,
               AVG(input_voltage)   AS input_voltage,
               AVG(output_voltage)  AS output_voltage,
               AVG(battery_voltage) AS battery_voltage,
               AVG(real_power)      AS real_power,
               AVG(temperature)     AS temperature
        FROM samples
        WHERE device_id = ? AND ts >= ? AND ts <= ?
        GROUP BY t
        ORDER BY t
      `,
      )
      .all(bucket, bucket, query.deviceId, query.from, query.to) as SampleRow[];

    return rows.map((row) => ({
      t: row.t,
      charge: round(row.charge),
      load: round(row.load),
      runtimeSeconds: round(row.runtime),
      inputVoltage: round(row.input_voltage),
      outputVoltage: round(row.output_voltage),
      batteryVoltage: round(row.battery_voltage),
      realPower: round(row.real_power),
      temperature: round(row.temperature),
    }));
  }

  addEvent(event: Omit<AlertEvent, 'id' | 'acknowledged'>): AlertEvent {
    const result = this.insertEvent.run({
      device_id: event.deviceId,
      rule: event.rule,
      severity: event.severity,
      state: event.state,
      message: event.message,
      value: event.value,
      ts: event.ts,
      actor: event.actor ?? null,
    });

    return { ...event, id: Number(result.lastInsertRowid), acknowledged: false };
  }

  events(options: { limit?: number; deviceId?: string; unacknowledgedOnly?: boolean } = {}): AlertEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.deviceId) {
      clauses.push('device_id = ?');
      params.push(options.deviceId);
    }
    if (options.unacknowledgedOnly) {
      clauses.push('acknowledged = 0');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...params, limit) as EventRow[];

    return rows.map(toAlertEvent);
  }

  acknowledgeEvent(id: number): boolean {
    return this.db.prepare('UPDATE events SET acknowledged = 1 WHERE id = ?').run(id).changes > 0;
  }

  acknowledgeAll(): number {
    return this.db.prepare('UPDATE events SET acknowledged = 1 WHERE acknowledged = 0').run().changes;
  }

  // ── NUT servers ────────────────────────────────────────────────────────

  listServers(): NutServerRecord[] {
    const rows = this.db.prepare('SELECT * FROM nut_servers ORDER BY name').all() as ServerRow[];
    return rows.map(toServerRecord);
  }

  server(id: number): NutServerRecord | null {
    const row = this.db.prepare('SELECT * FROM nut_servers WHERE id = ?').get(id) as ServerRow | undefined;
    return row ? toServerRecord(row) : null;
  }

  createServer(input: ServerInput): NutServerRecord {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO nut_servers (name, host, port, username, password, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.host,
        input.port,
        input.username || null,
        input.password || null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    return this.server(Number(result.lastInsertRowid))!;
  }

  /** Fields left undefined keep their stored value — notably the password. */
  updateServer(id: number, patch: Partial<ServerInput>): NutServerRecord | null {
    const current = this.server(id);
    if (!current) return null;

    const next = {
      name: patch.name ?? current.name,
      host: patch.host ?? current.host,
      port: patch.port ?? current.port,
      username: patch.username === undefined ? current.username : patch.username || null,
      password: patch.password === undefined ? current.password : patch.password || null,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
    };

    this.db
      .prepare(
        `UPDATE nut_servers
         SET name = ?, host = ?, port = ?, username = ?, password = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.name, next.host, next.port, next.username, next.password, next.enabled ? 1 : 0, Date.now(), id);

    return this.server(id);
  }

  /** Removes a server together with the history and events of its devices. */
  deleteServer(id: number): NutServerRecord | null {
    const server = this.server(id);
    if (!server) return null;

    const prefix = `${server.name}/`;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM samples WHERE device_id LIKE ?').run(`${prefix}%`);
      this.db.prepare('DELETE FROM events WHERE device_id LIKE ?').run(`${prefix}%`);
      this.db.prepare('DELETE FROM nut_servers WHERE id = ?').run(id);
    })();

    return server;
  }

  /**
   * Prüft, ob ein Messwert über die **gesamte** gespeicherte Historie nie einen
   * anderen Wert hatte. Manche Geräte melden für einen fehlenden Fühler eine
   * feste Zahl — die UniFi UPS 2U etwa immer 25,0 °C. Ein Diagramm davon
   * täuscht eine Messung vor, die es nicht gibt.
   *
   * Bewusst über die ganze Historie und nicht über das angezeigte Fenster:
   * ein echter Fühler steht durchaus mal eine Stunde still, aber nicht tagelang.
   * Ohne genug Material wird nichts behauptet.
   */
  staticMetric(
    deviceId: string,
    column: 'temperature',
    minSamples = 500,
    minSpanMs = 60 * 60 * 1000,
  ): { isStatic: boolean; value: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT ${column}) AS distinct_values,
                MIN(${column}) AS value, MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM samples WHERE device_id = ? AND ${column} IS NOT NULL`,
      )
      .get(deviceId) as {
      n: number;
      distinct_values: number;
      value: number | null;
      first_ts: number | null;
      last_ts: number | null;
    };

    const span = (row.last_ts ?? 0) - (row.first_ts ?? 0);
    const isStatic = row.distinct_values === 1 && row.n >= minSamples && span >= minSpanMs;

    return { isStatic, value: isStatic ? row.value : null };
  }

  // ── Einstellungen ──────────────────────────────────────────────────────

  /** Reads a JSON setting, or null when it was never written. */
  setting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  saveSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /** Drops samples and events older than the retention window. */
  prune(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}

function round(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toServerRecord(row: ServerRow): NutServerRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAlertEvent(row: EventRow): AlertEvent {
  return {
    id: row.id,
    deviceId: row.device_id,
    rule: row.rule,
    severity: row.severity as Severity,
    state: row.state as 'raised' | 'cleared',
    message: row.message,
    value: row.value,
    ts: row.ts,
    acknowledged: row.acknowledged === 1,
    actor: row.actor,
  };
}
