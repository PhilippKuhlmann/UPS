import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/** scrypt parameters. Stored alongside each hash so they can be raised later. */
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';
const MIN_PASSWORD_LENGTH = 8;

/** Failed logins per client before the account is locked out for a while. */
const MAX_FAILURES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

export interface SessionUser {
  id: number;
  username: string;
  mustChangePassword: boolean;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'auth_error') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  must_change_password: number;
}

interface SessionRow {
  user_id: number;
  expires_at: number;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keyLength, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const expectedBuffer = Buffer.from(expected, 'base64');
  const derived = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expectedBuffer.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });

  return crypto.timingSafeEqual(derived, expectedBuffer);
}

/** Sessions are looked up by the hash of the token, never by the token itself. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  private readonly db: Database.Database;
  private readonly sessionTtlMs: number;
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(db: Database.Database, sessionTtlMs: number) {
    this.db = db;
    this.sessionTtlMs = sessionTtlMs;
  }

  /**
   * Creates the initial account on first start. The default password must be
   * replaced before anything else in the app becomes reachable.
   *
   * @param initialPassword From ADMIN_PASSWORD; when given, no change is forced.
   */
  ensureDefaultUser(initialPassword?: string | undefined): { created: boolean; username: string } {
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (existing.count > 0) return { created: false, username: DEFAULT_USERNAME };

    const password = initialPassword?.trim() || DEFAULT_PASSWORD;
    if (initialPassword && password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`ADMIN_PASSWORD muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben`);
    }

    this.db
      .prepare(
        `INSERT INTO users (username, password_hash, must_change_password, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(DEFAULT_USERNAME, hashPassword(password), initialPassword ? 0 : 1, Date.now());

    return { created: true, username: DEFAULT_USERNAME };
  }

  /** Seconds a client still has to wait, or 0 when it may try again. */
  lockoutSeconds(clientKey: string): number {
    const entry = this.failures.get(clientKey);
    if (!entry || entry.until <= Date.now()) return 0;
    return Math.ceil((entry.until - Date.now()) / 1000);
  }

  login(username: string, password: string, clientKey: string): { user: SessionUser; token: string; expiresAt: number } {
    const waitSeconds = this.lockoutSeconds(clientKey);
    if (waitSeconds > 0) {
      throw new AuthError(
        `Zu viele Fehlversuche. Nächster Versuch in ${Math.ceil(waitSeconds / 60)} Minuten möglich.`,
        429,
        'locked_out',
      );
    }

    const row = this.db
      .prepare('SELECT id, username, password_hash, must_change_password FROM users WHERE username = ?')
      .get(username.trim().toLowerCase()) as UserRow | undefined;

    // The same message either way, so the form cannot be used to probe for names.
    if (!row || !verifyPassword(password, row.password_hash)) {
      this.registerFailure(clientKey);
      throw new AuthError('Benutzername oder Passwort stimmt nicht.', 401, 'invalid_credentials');
    }

    this.failures.delete(clientKey);

    const user: SessionUser = {
      id: row.id,
      username: row.username,
      mustChangePassword: row.must_change_password === 1,
    };

    return { user, ...this.createSession(row.id) };
  }

  private registerFailure(clientKey: string): void {
    const entry = this.failures.get(clientKey) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.until = Date.now() + LOCKOUT_MS;
      entry.count = 0;
    }
    this.failures.set(clientKey, entry);
  }

  private createSession(userId: number): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;

    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, now, expiresAt, now);

    return { token, expiresAt };
  }

  userForToken(token: string): SessionUser | null {
    const session = this.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
      .get(hashToken(token)) as SessionRow | undefined;

    if (!session) return null;

    if (session.expires_at <= Date.now()) {
      this.destroySession(token);
      return null;
    }

    const row = this.db
      .prepare('SELECT id, username, password_hash, must_change_password FROM users WHERE id = ?')
      .get(session.user_id) as UserRow | undefined;

    if (!row) return null;

    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), hashToken(token));

    return { id: row.id, username: row.username, mustChangePassword: row.must_change_password === 1 };
  }

  destroySession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /**
   * Changes a password and invalidates every other session of that user, so a
   * stolen cookie stops working the moment the password is replaced.
   */
  changePassword(userId: number, currentPassword: string, newPassword: string, keepToken: string): void {
    const row = this.db
      .prepare('SELECT id, username, password_hash, must_change_password FROM users WHERE id = ?')
      .get(userId) as UserRow | undefined;

    if (!row) throw new AuthError('Benutzer nicht gefunden.', 404, 'no_user');
    if (!verifyPassword(currentPassword, row.password_hash)) {
      throw new AuthError('Das aktuelle Passwort stimmt nicht.', 401, 'invalid_credentials');
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(`Das neue Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`, 400, 'too_short');
    }
    if (newPassword === currentPassword) {
      throw new AuthError('Das neue Passwort muss sich vom alten unterscheiden.', 400, 'unchanged');
    }

    const now = Date.now();
    this.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), now, userId);

    this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .run(userId, hashToken(keepToken));
  }

  pruneSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }
}

export const AUTH_COOKIE = 'ups_nut_session';

/** Minimal cookie reader — avoids pulling in a parser for a single value. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeMs?: number; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure) parts.push('Secure');
  parts.push(`Max-Age=${Math.floor((options.maxAgeMs ?? 0) / 1000)}`);
  return parts.join('; ');
}
