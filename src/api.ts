import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { AlertEngine } from './alerts.js';
import { AUTH_COOKIE, AuthError, readCookie, serializeCookie, type AuthService, type SessionUser } from './auth.js';
import { redactConfig, type AppConfig } from './config.js';
import { messageForEvent, redactSettings, type ChannelName, type Notifier } from './notify.js';
import { withNutConnection } from './nut/client.js';
import type { Poller } from './poller.js';
import type { Store } from './store.js';
import type { AlertEvent, NutServerPublic, NutServerRecord } from './types.js';

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface ApiDeps {
  config: AppConfig;
  poller: Poller;
  store: Store;
  alerts: AlertEngine;
  auth: AuthService;
  notifier: Notifier;
  /** Re-reads the server table and hands it to the poller. */
  reloadServers: () => void;
  /** Pushes a newly recorded event to every open browser. */
  publishEvent: (event: AlertEvent) => void;
}

/**
 * Commands that take power away from the load. They are recorded with a higher
 * severity and — unlike ordinary commands — are worth a notification.
 */
function isDisruptiveCommand(command: string): boolean {
  if (command === 'shutdown.stop') return false;
  return /^(shutdown\.|load\.off|bypass\.)/.test(command);
}

/** Server names become part of every device id, so they stay simple. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

function parseServerInput(body: unknown, { partial }: { partial: boolean }) {
  const input = (body ?? {}) as Record<string, unknown>;
  const result: {
    name?: string;
    host?: string;
    port?: number;
    username?: string | null;
    password?: string | null;
    enabled?: boolean;
  } = {};

  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? '').trim();
    if (!NAME_PATTERN.test(name)) {
      throw new ValidationError('Der Name darf nur Buchstaben, Ziffern, Leerzeichen, Punkt, Strich und Unterstrich enthalten (max. 40 Zeichen).');
    }
    if (name.includes('/')) throw new ValidationError('Der Name darf keinen Schrägstrich enthalten.');
    result.name = name;
  }

  if (input.host !== undefined || !partial) {
    const host = String(input.host ?? '').trim();
    if (!host) throw new ValidationError('Adresse des NUT-Servers fehlt.');
    result.host = host;
  }

  if (input.port !== undefined || !partial) {
    const port = Number(input.port ?? 3493);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ValidationError('Port muss zwischen 1 und 65535 liegen.');
    }
    result.port = port;
  }

  if (input.username !== undefined) result.username = String(input.username).trim() || null;
  // An absent password keeps the stored one; an empty string clears it.
  if (input.password !== undefined) result.password = String(input.password) || null;
  if (input.enabled !== undefined) result.enabled = Boolean(input.enabled);

  return result;
}

class ValidationError extends Error {}

interface AuthedRequest extends Request {
  sessionUser?: SessionUser;
  sessionToken?: string;
}

/** Identifies a client for login rate limiting. */
function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unbekannt';
}

/**
 * Answers whether a request carries a valid session. Also used for the
 * websocket upgrade, which never reaches the Express router.
 */
export function sessionUserFor(auth: AuthService, cookieHeader: string | undefined): SessionUser | null {
  const token = readCookie(cookieHeader, AUTH_COOKIE);
  return token ? auth.userForToken(token) : null;
}

export function createApiRouter({
  config,
  poller,
  store,
  alerts,
  auth,
  notifier,
  reloadServers,
  publishEvent,
}: ApiDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  const deviceId = (req: Request) => `${req.params.server}/${req.params.ups}`;

  /**
   * Writes an entry to the audit trail so every command and every changed
   * variable stays traceable to the account that triggered it.
   */
  function record(entry: {
    deviceId: string;
    rule: 'command' | 'variable';
    severity: 'good' | 'warning' | 'serious';
    message: string;
    actor: string;
    title: string;
    notify: boolean;
  }): void {
    const event = store.addEvent({
      deviceId: entry.deviceId,
      rule: entry.rule,
      severity: entry.severity,
      state: 'executed',
      message: entry.message,
      value: null,
      ts: Date.now(),
      actor: entry.actor,
    });

    console.log(`[audit] ${entry.actor} · ${entry.deviceId} · ${entry.message}`);
    publishEvent(event);

    if (entry.notify && notifier.shouldSend(event)) {
      void notifier.notify(messageForEvent(event, entry.title, poller.snapshot(entry.deviceId)));
    }
  }

  function setSessionCookie(res: Response, token: string): void {
    res.setHeader(
      'Set-Cookie',
      serializeCookie(AUTH_COOKIE, token, {
        maxAgeMs: config.auth.sessionTtlMs,
        secure: config.auth.secureCookie,
      }),
    );
  }

  // ── Authentication (reachable without a session) ────────────────────────

  router.get('/auth/session', (req: AuthedRequest, res) => {
    if (!config.auth.enabled) {
      return res.json({ authEnabled: false, authenticated: true, user: null });
    }

    const token = readCookie(req.headers.cookie, AUTH_COOKIE);
    const user = token ? auth.userForToken(token) : null;

    res.json({ authEnabled: true, authenticated: Boolean(user), user });
  });

  router.post('/auth/login', (req, res) => {
    if (!config.auth.enabled) return res.json({ authEnabled: false, user: null });

    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Benutzername und Passwort eingeben.' });
    }

    try {
      const { user, token } = auth.login(username, password, clientKey(req));
      setSessionCookie(res, token);
      res.json({ authEnabled: true, user });
    } catch (error) {
      const authError = error as AuthError;
      res.status(authError.status ?? 401).json({ error: authError.message, code: authError.code });
    }
  });

  router.post('/auth/logout', (req, res) => {
    const token = readCookie(req.headers.cookie, AUTH_COOKIE);
    if (token) auth.destroySession(token);

    res.setHeader('Set-Cookie', serializeCookie(AUTH_COOKIE, '', { maxAgeMs: 0, secure: config.auth.secureCookie }));
    res.json({ ok: true });
  });

  // ── Everything below needs a session ────────────────────────────────────

  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!config.auth.enabled) return next();

    const token = readCookie(req.headers.cookie, AUTH_COOKIE);
    const user = token ? auth.userForToken(token) : null;

    if (!user || !token) {
      return res.status(401).json({ error: 'Nicht angemeldet.', code: 'unauthenticated' });
    }

    req.sessionUser = user;
    req.sessionToken = token;
    next();
  });

  router.post('/auth/password', (req: AuthedRequest, res) => {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    try {
      auth.changePassword(req.sessionUser!.id, currentPassword, newPassword, req.sessionToken!);
      res.json({ ok: true, user: { ...req.sessionUser!, mustChangePassword: false } });
    } catch (error) {
      const authError = error as AuthError;
      res.status(authError.status ?? 400).json({ error: authError.message, code: authError.code });
    }
  });

  // A forced password change is only forced if nothing else answers until it happens.
  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!config.auth.enabled || !req.sessionUser?.mustChangePassword) return next();

    res.status(403).json({
      error: 'Bitte zuerst das Startpasswort ersetzen.',
      code: 'password_change_required',
    });
  });

  // ── Monitoring ──────────────────────────────────────────────────────────

  router.get('/state', (_req, res) => {
    res.json({
      serverTime: Date.now(),
      devices: poller.snapshots(),
      activeAlerts: alerts.activeAlerts(),
      config: redactConfig(config),
    });
  });

  router.get('/devices', (_req, res) => {
    res.json(poller.snapshots());
  });

  router.get('/devices/:server/:ups', (req, res) => {
    const snapshot = poller.snapshot(deviceId(req));
    if (!snapshot) return notFound(res, 'Gerät nicht gefunden');

    res.json({ ...snapshot, activeAlerts: alerts.activeAlertsFor(snapshot.id) });
  });

  router.get('/devices/:server/:ups/history', (req, res) => {
    const id = deviceId(req);
    const now = Date.now();

    const range = String(req.query.range ?? '6h');
    const span = RANGE_MS[range];
    if (span === undefined && (req.query.from === undefined || req.query.to === undefined)) {
      return badRequest(res, `Unbekannter Zeitraum "${range}" — erlaubt: ${Object.keys(RANGE_MS).join(', ')}`);
    }

    const from = req.query.from !== undefined ? Number(req.query.from) : now - (span ?? 0);
    const to = req.query.to !== undefined ? Number(req.query.to) : now;

    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return badRequest(res, 'Ungültiger Zeitraum');
    }

    // Messwerte, die das Gerät nur als feste Zahl meldet, werden gemeldet statt
    // gezeichnet — ein Diagramm davon täuscht eine Messung vor.
    const temperature = store.staticMetric(id, 'temperature');

    res.json({
      deviceId: id,
      from,
      to,
      staticMetrics: temperature.isStatic ? [{ key: 'temperature', value: temperature.value }] : [],
      points: store.history({ deviceId: id, from, to, points: Number(req.query.points) || 300 }),
    });
  });

  router.post('/devices/:server/:ups/command', async (req: AuthedRequest, res) => {
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    if (!command) return badRequest(res, 'Feld "command" fehlt');

    const id = deviceId(req);
    const actor = req.sessionUser?.username ?? 'unbekannt';
    const disruptive = isDisruptiveCommand(command);

    try {
      await poller.runCommand(id, command);

      record({
        deviceId: id,
        rule: 'command',
        severity: disruptive ? 'serious' : 'good',
        message: `Befehl „${command}" ausgeführt`,
        actor,
        title: 'Befehl ausgeführt',
        notify: disruptive,
      });

      res.json({ ok: true, command });
    } catch (error) {
      const reason = (error as Error).message;

      // Abgelehnte Versuche gehören genauso ins Protokoll wie erfolgreiche.
      record({
        deviceId: id,
        rule: 'command',
        severity: 'warning',
        message: `Befehl „${command}" abgelehnt: ${reason}`,
        actor,
        title: 'Befehl abgelehnt',
        notify: false,
      });

      res.status(502).json({ error: reason });
    }
  });

  router.post('/devices/:server/:ups/variable', async (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const value = req.body?.value;

    if (!name) return badRequest(res, 'Feld "name" fehlt');
    if (typeof value !== 'string') return badRequest(res, 'Feld "value" muss ein String sein');

    const id = deviceId(req);
    const actor = req.sessionUser?.username ?? 'unbekannt';

    try {
      await poller.setVariable(id, name, value);

      record({
        deviceId: id,
        rule: 'variable',
        severity: 'good',
        message: `${name} auf „${value}" gesetzt`,
        actor,
        title: 'Variable geändert',
        notify: false,
      });

      res.json({ ok: true, name, value });
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.get('/events', (req, res) => {
    res.json(
      store.events({
        limit: Number(req.query.limit) || 100,
        deviceId: typeof req.query.device === 'string' ? req.query.device : undefined,
        unacknowledgedOnly: req.query.unacknowledged === '1',
      }),
    );
  });

  router.post('/events/:id/ack', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, 'Ungültige Ereignis-ID');

    res.json({ ok: store.acknowledgeEvent(id) });
  });

  router.post('/events/ack-all', (_req, res) => {
    res.json({ ok: true, acknowledged: store.acknowledgeAll() });
  });

  router.get('/config', (_req, res) => {
    res.json(redactConfig(config));
  });

  // ── Meldewege ───────────────────────────────────────────────────────────

  router.get('/notifications', (_req, res) => {
    res.json(redactSettings(notifier.settings()));
  });

  router.put('/notifications', (req, res) => {
    if (typeof req.body !== 'object' || req.body === null) {
      return badRequest(res, 'Ungültige Einstellungen');
    }

    res.json(redactSettings(notifier.save(req.body)));
  });

  router.post('/notifications/:channel/test', async (req, res) => {
    const channel = req.params.channel as ChannelName;
    if (!['webhook', 'email', 'telegram'].includes(channel)) {
      return badRequest(res, `Unbekannter Meldeweg "${req.params.channel}"`);
    }

    const result = await notifier.test(channel, req.body ?? {});
    res.status(result.ok ? 200 : 502).json(result);
  });

  // ── NUT servers ─────────────────────────────────────────────────────────

  router.get('/servers', (_req, res) => {
    res.json(store.listServers().map(toPublicServer));
  });

  /**
   * Tries a connection without saving anything and reports which UPS devices
   * the server offers — so adding one is a confirmation, not a guess.
   */
  router.post('/servers/test', async (req, res) => {
    let input;
    try {
      input = parseServerInput({ name: 'test', ...(req.body ?? {}) }, { partial: false });
    } catch (error) {
      return badRequest(res, (error as Error).message);
    }

    // An existing server may be tested without re-entering its password.
    let password = input.password ?? null;
    const existingId = Number(req.body?.id);
    if (password === null && Number.isInteger(existingId)) {
      password = store.server(existingId)?.password ?? null;
    }

    try {
      const result = await withNutConnection(
        {
          host: input.host!,
          port: input.port!,
          username: input.username ?? undefined,
          password: password ?? undefined,
          timeoutMs: 6000,
        },
        async (connection) => {
          const version = await connection.version().catch(() => '');
          const list = await connection.listUps();
          return { version, devices: list };
        },
      );

      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(502).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post('/servers', (req, res) => {
    let input;
    try {
      input = parseServerInput(req.body, { partial: false });
    } catch (error) {
      return badRequest(res, (error as Error).message);
    }

    if (store.listServers().some((server) => server.name === input.name)) {
      return res.status(409).json({ error: `Es gibt bereits einen Server namens "${input.name}".` });
    }

    const created = store.createServer({
      name: input.name!,
      host: input.host!,
      port: input.port!,
      username: input.username ?? null,
      password: input.password ?? null,
      enabled: input.enabled ?? true,
    });

    reloadServers();
    res.status(201).json(toPublicServer(created));
  });

  router.patch('/servers/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, 'Ungültige Server-ID');

    let patch;
    try {
      patch = parseServerInput(req.body, { partial: true });
    } catch (error) {
      return badRequest(res, (error as Error).message);
    }

    if (patch.name && store.listServers().some((server) => server.name === patch.name && server.id !== id)) {
      return res.status(409).json({ error: `Es gibt bereits einen Server namens "${patch.name}".` });
    }

    const updated = store.updateServer(id, patch);
    if (!updated) return notFound(res, 'Server nicht gefunden');

    reloadServers();
    res.json(toPublicServer(updated));
  });

  router.delete('/servers/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return badRequest(res, 'Ungültige Server-ID');

    const removed = store.deleteServer(id);
    if (!removed) return notFound(res, 'Server nicht gefunden');

    reloadServers();
    res.json({ ok: true, name: removed.name });
  });

  return router;
}

function toPublicServer(server: NutServerRecord): NutServerPublic {
  const { password, ...rest } = server;
  return { ...rest, hasPassword: Boolean(password) };
}

function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: message });
}

function notFound(res: Response, message: string) {
  return res.status(404).json({ error: message });
}
