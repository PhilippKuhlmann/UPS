/** REST calls plus the websocket that carries every poll to the browser. */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Fires when the server stops accepting the session, so the app can re-gate. */
export const authEvents = new EventTarget();

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new ApiError(
      payload?.error ?? `${response.status} ${response.statusText}`,
      response.status,
      payload?.code,
    );

    // A session that expired mid-use must send the person back to the login,
    // not surface as a confusing failure on whatever they happened to click.
    //
    // Only the server's own verdict counts here. A wrong password also answers
    // 401, but that is a form error to display — re-gating on it would rebuild
    // the view and throw the message away before anyone could read it.
    const sessionGone = error.code === 'unauthenticated' || error.code === 'password_change_required';
    if (sessionGone) {
      authEvents.dispatchEvent(new CustomEvent('lost', { detail: error }));
    }

    throw error;
  }

  return payload;
}

const devicePath = (deviceId) =>
  `/api/devices/${deviceId.split('/').map(encodeURIComponent).join('/')}`;

export const api = {
  session: () => request('/api/auth/session'),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  state: () => request('/api/state'),
  device: (deviceId) => request(devicePath(deviceId)),
  history: (deviceId, range, points = 300) =>
    request(`${devicePath(deviceId)}/history?range=${encodeURIComponent(range)}&points=${points}`),
  runCommand: (deviceId, command) =>
    request(`${devicePath(deviceId)}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
  setVariable: (deviceId, name, value) =>
    request(`${devicePath(deviceId)}/variable`, {
      method: 'POST',
      body: JSON.stringify({ name, value }),
    }),
  servers: () => request('/api/servers'),
  testServer: (server) => request('/api/servers/test', { method: 'POST', body: JSON.stringify(server) }),
  createServer: (server) => request('/api/servers', { method: 'POST', body: JSON.stringify(server) }),
  updateServer: (id, patch) =>
    request(`/api/servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteServer: (id) => request(`/api/servers/${id}`, { method: 'DELETE' }),
  events: (limit = 200, deviceId) =>
    request(`/api/events?limit=${limit}${deviceId ? `&device=${encodeURIComponent(deviceId)}` : ''}`),
  acknowledgeEvent: (id) => request(`/api/events/${id}/ack`, { method: 'POST' }),
  acknowledgeAll: () => request('/api/events/ack-all', { method: 'POST' }),
};

/**
 * Keeps a websocket to `/ws` open, reconnecting with a backoff that tops out at
 * 15 s so a restarted server is picked up quickly without hammering it.
 */
export function connectLiveFeed({ onMessage, onStateChange }) {
  let socket = null;
  let retryDelay = 1000;
  let closed = false;

  function open() {
    if (closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws`);

    socket.addEventListener('open', () => {
      retryDelay = 1000;
      onStateChange('live');
    });

    socket.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      onStateChange('lost');
      setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 1.6, 15000);
    });

    socket.addEventListener('error', () => socket?.close());
  }

  open();

  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}
