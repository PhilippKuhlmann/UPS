import fs from 'node:fs';
import path from 'node:path';

export interface NutServerConfig {
  name: string;
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
}

export interface AlertThresholds {
  /** Raise when battery charge drops below this percentage. */
  chargeBelow: number;
  /** Raise when output load rises above this percentage. */
  loadAbove: number;
  /** Raise when estimated runtime drops below this many seconds. */
  runtimeBelowSeconds: number;
  /** Raise when the UPS internal temperature rises above this many °C. */
  temperatureAbove: number;
}

export interface AppConfig {
  port: number;
  bindHost: string;
  pollIntervalMs: number;
  retentionDays: number;
  dbPath: string;
  /**
   * Only used to seed the database on first start. Afterwards the `nut_servers`
   * table is the source of truth and is edited through the interface.
   */
  seedServers: NutServerConfig[];
  alerts: AlertThresholds;
  webhookUrl?: string | undefined;
  auth: AuthConfig;
}

export interface AuthConfig {
  /** Turn off only when something in front of the app already authenticates. */
  enabled: boolean;
  sessionTtlMs: number;
  /** Send the session cookie only over HTTPS. Off by default for plain LAN use. */
  secureCookie: boolean;
  /** Initial password for the admin account; without it, admin/admin is created. */
  initialPassword?: string | undefined;
}

function readEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Servers come either from `NUT_SERVERS` (JSON array, for several sites) or from
 * the flat `NUT_HOST`/`NUT_PORT`/… variables for the common single-server case.
 */
function parseServers(): NutServerConfig[] {
  const raw = process.env.NUT_SERVERS?.trim();

  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`NUT_SERVERS is not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('NUT_SERVERS must be a JSON array of server objects');
    }

    return parsed.map((entry, index) => {
      const server = entry as Partial<NutServerConfig>;
      if (!server.host) {
        throw new Error(`NUT_SERVERS[${index}] is missing "host"`);
      }
      return {
        name: server.name ?? server.host,
        host: server.host,
        port: server.port ?? 3493,
        username: server.username,
        password: server.password,
      };
    });
  }

  const host = process.env.NUT_HOST?.trim();
  if (!host) return [];

  return [
    {
      name: process.env.NUT_NAME?.trim() || host,
      host,
      port: num(process.env.NUT_PORT, 3493),
      username: process.env.NUT_USERNAME?.trim() || undefined,
      password: process.env.NUT_PASSWORD || undefined,
    },
  ];
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  readEnvFile(path.join(cwd, '.env'));

  const seedServers = parseServers();
  const names = new Set<string>();
  for (const server of seedServers) {
    if (names.has(server.name)) {
      throw new Error(`Doppelter NUT-Servername "${server.name}" — Namen müssen eindeutig sein`);
    }
    names.add(server.name);
  }

  return {
    port: num(process.env.PORT, 8080),
    bindHost: process.env.BIND_HOST?.trim() || '0.0.0.0',
    pollIntervalMs: Math.max(1000, num(process.env.POLL_INTERVAL_MS, 5000)),
    retentionDays: Math.max(1, num(process.env.HISTORY_RETENTION_DAYS, 30)),
    dbPath: process.env.DB_PATH?.trim() || path.join(cwd, 'data', 'ups.db'),
    seedServers,
    alerts: {
      chargeBelow: num(process.env.ALERT_CHARGE_BELOW, 30),
      loadAbove: num(process.env.ALERT_LOAD_ABOVE, 85),
      runtimeBelowSeconds: num(process.env.ALERT_RUNTIME_BELOW_SECONDS, 300),
      temperatureAbove: num(process.env.ALERT_TEMPERATURE_ABOVE, 45),
    },
    webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || undefined,
    auth: {
      enabled: process.env.AUTH_ENABLED?.trim() !== '0',
      sessionTtlMs: Math.max(1, num(process.env.SESSION_TTL_HOURS, 336)) * 60 * 60 * 1000,
      secureCookie: process.env.SESSION_COOKIE_SECURE?.trim() === '1',
      initialPassword: process.env.ADMIN_PASSWORD || undefined,
    },
  };
}

/** Config safe to hand to the browser — credentials removed. */
export function redactConfig(config: AppConfig) {
  return {
    pollIntervalMs: config.pollIntervalMs,
    retentionDays: config.retentionDays,
    alerts: config.alerts,
    webhookConfigured: Boolean(config.webhookUrl),
    authEnabled: config.auth.enabled,
  };
}
