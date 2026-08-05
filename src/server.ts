import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { AlertEngine } from './alerts.js';
import { createApiRouter, sessionUserFor } from './api.js';
import { AuthService } from './auth.js';
import { loadConfig, redactConfig } from './config.js';
import { Poller } from './poller.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');

const config = loadConfig();

const store = new Store(config.dbPath);
const auth = new AuthService(store.database, config.auth.sessionTtlMs);
const alerts = new AlertEngine(store, config.alerts, config.webhookUrl);

// The database owns the server list. NUT_HOST / NUT_SERVERS only seed it on the
// very first start; after that, servers are managed through the interface.
if (store.listServers().length === 0 && config.seedServers.length > 0) {
  for (const server of config.seedServers) {
    store.createServer({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username ?? null,
      password: server.password ?? null,
    });
  }
  console.log(
    `NUT-Server aus der Konfiguration übernommen: ${config.seedServers.map((s) => s.name).join(', ')}`,
  );
}

const poller = new Poller(config, toPollerServers());

function toPollerServers() {
  return store
    .listServers()
    .filter((server) => server.enabled)
    .map((server) => ({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username ?? undefined,
      password: server.password ?? undefined,
    }));
}

function reloadServers(): void {
  poller.setServers(toPollerServers());
}

if (config.auth.enabled) {
  const { created, username } = auth.ensureDefaultUser(config.auth.initialPassword);
  if (created && !config.auth.initialPassword) {
    console.log(`Startzugang angelegt: ${username} / admin — das Passwort muss beim ersten Login ersetzt werden.`);
  } else if (created) {
    console.log(`Startzugang angelegt: ${username} (Passwort aus ADMIN_PASSWORD).`);
  }
} else {
  console.warn('AUTH_ENABLED=0 — die Oberfläche und die API sind ohne Anmeldung erreichbar.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use('/api', createApiRouter({ config, poller, store, alerts, auth, reloadServers }));
// ETags rather than a max-age: an updated container must not serve stale assets.
app.use(express.static(publicDir, { maxAge: 0, etag: true, index: 'index.html' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, devices: poller.snapshots().length }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// The websocket carries live device data, so the upgrade is authenticated too.
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if (config.auth.enabled) {
    const user = sessionUserFor(auth, request.headers.cookie);
    if (!user || user.mustChangePassword) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

function broadcast(payload: unknown): void {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

wss.on('connection', (socket: WebSocket) => {
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      serverTime: Date.now(),
      devices: poller.snapshots(),
      activeAlerts: alerts.activeAlerts(),
      config: redactConfig(config),
    }),
  );
});

poller.on('poll', (snapshots) => {
  for (const snapshot of snapshots) {
    store.recordSample(snapshot);
  }

  const events = alerts.evaluate(snapshots);

  broadcast({
    type: 'snapshot',
    serverTime: Date.now(),
    devices: poller.snapshots(),
    activeAlerts: alerts.activeAlerts(),
  });

  for (const event of events) {
    console.log(`[alert] ${event.state} ${event.deviceId} ${event.rule}: ${event.message}`);
    broadcast({ type: 'event', event });
  }
});

// Retention runs hourly; the first pass happens right after startup.
function housekeeping(): void {
  store.prune(config.retentionDays);
  auth.pruneSessions();
}

housekeeping();
const pruneTimer = setInterval(housekeeping, 60 * 60 * 1000);

server.listen(config.port, config.bindHost, () => {
  const servers = toPollerServers();
  console.log(`ups-nut läuft auf http://${config.bindHost}:${config.port}`);
  console.log(
    servers.length === 0
      ? 'Noch kein NUT-Server hinterlegt — über die Oberfläche unter „Server" anlegen.'
      : `NUT-Server: ${servers.map((s) => `${s.name} (${s.host}:${s.port})`).join(', ')} · Abfrage alle ${config.pollIntervalMs} ms`,
  );
  poller.start();
});

function shutdown(signal: string): void {
  console.log(`\n${signal} empfangen — beende ups-nut`);
  clearInterval(pruneTimer);
  poller.stop();
  wss.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Do not hang forever on lingering keep-alive sockets.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
