import snmp from 'net-snmp';
import type { AuthProtocols, PrivProtocols, SecurityLevel, Session, User, Varbind } from 'net-snmp';
import { PROFILES, profileByName, type MibProfile, type Readings } from './mibs.js';

export interface SnmpTarget {
  host: string;
  port: number;
  /** `1`, `2c` oder `3`. */
  version: string;
  /** Nur für v1/v2c. */
  community?: string | null;
  /** Nur für v3. */
  securityLevel?: string | null;
  securityName?: string | null;
  authProtocol?: string | null;
  authPassword?: string | null;
  privProtocol?: string | null;
  privPassword?: string | null;
  timeoutMs?: number;
}

const SECURITY_LEVELS: Record<string, SecurityLevel> = {
  noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
  authNoPriv: snmp.SecurityLevel.authNoPriv,
  authPriv: snmp.SecurityLevel.authPriv,
};

const AUTH_PROTOCOLS: Record<string, AuthProtocols> = {
  md5: snmp.AuthProtocols.md5,
  sha: snmp.AuthProtocols.sha,
  sha224: snmp.AuthProtocols.sha224,
  sha256: snmp.AuthProtocols.sha256,
  sha384: snmp.AuthProtocols.sha384,
  sha512: snmp.AuthProtocols.sha512,
};

const PRIV_PROTOCOLS: Record<string, PrivProtocols> = {
  des: snmp.PrivProtocols.des,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
  aes256r: snmp.PrivProtocols.aes256r,
};

export const AUTH_PROTOCOL_NAMES = Object.keys(AUTH_PROTOCOLS);
export const PRIV_PROTOCOL_NAMES = Object.keys(PRIV_PROTOCOLS);
export const SECURITY_LEVEL_NAMES = Object.keys(SECURITY_LEVELS);

/** Öffnet eine Sitzung; für v3 mit dem passenden Sicherheitsprofil. */
function createSession(target: SnmpTarget): Session {
  const common = {
    port: target.port,
    timeout: target.timeoutMs ?? 5000,
    retries: 1,
  };

  if (target.version === '3') {
    const level = SECURITY_LEVELS[target.securityLevel ?? 'authPriv'] ?? snmp.SecurityLevel.authPriv;
    const user: User = { name: target.securityName ?? '', level };

    if (level !== snmp.SecurityLevel.noAuthNoPriv) {
      user.authProtocol = AUTH_PROTOCOLS[target.authProtocol ?? 'sha'] ?? snmp.AuthProtocols.sha;
      user.authKey = target.authPassword ?? '';
    }
    if (level === snmp.SecurityLevel.authPriv) {
      user.privProtocol = PRIV_PROTOCOLS[target.privProtocol ?? 'aes'] ?? snmp.PrivProtocols.aes;
      user.privKey = target.privPassword ?? '';
    }

    return snmp.createV3Session(target.host, user, { ...common, version: snmp.Version3 });
  }

  const version = target.version === '1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(target.host, target.community || 'public', { ...common, version });
}

/** True, wenn das Gerät für dieses OID keinen Wert hat. */
function isMissing(varbind: Varbind): boolean {
  return (
    snmp.isVarbindError(varbind) ||
    varbind.type === snmp.ObjectType.NoSuchObject ||
    varbind.type === snmp.ObjectType.NoSuchInstance ||
    varbind.type === snmp.ObjectType.EndOfMibView
  );
}

function toValue(varbind: Varbind): number | string | null {
  if (isMissing(varbind)) return null;

  const { value } = varbind as { value: unknown };
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/, '');
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'string') return value;
  return null;
}

/**
 * Fragt mehrere OIDs auf einmal ab. Fehlende Werte kommen als null zurück,
 * statt die ganze Abfrage scheitern zu lassen — kein Gerät liefert alles.
 */
function get(session: Session, oids: string[]): Promise<(number | string | null)[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) return reject(error);
      resolve((varbinds ?? []).map(toValue));
    });
  });
}

async function withSession<T>(target: SnmpTarget, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = createSession(target);
  // net-snmp meldet Socket-Fehler über ein Event; ohne Zuhörer beendet das den Prozess.
  session.on('error', () => {});

  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

export interface SnmpReadResult {
  profile: MibProfile;
  readings: Readings;
}

/**
 * Erklärt, warum gar keine Antwort kam. Bei v2c verwirft eine Karte Anfragen
 * mit falscher Community stillschweigend — das sieht von außen aus wie „nicht
 * erreichbar", deshalb nennt die Meldung beide Ursachen.
 */
function describeSilence(target: SnmpTarget, lastError: Error | null): string {
  const where = `${target.host}:${target.port}`;

  if (lastError && /timed out|timeout/i.test(lastError.message)) {
    return target.version === '3'
      ? `Keine Antwort von ${where}. Prüfe Adresse und Port, ob SNMPv3 freigegeben ist und ob Benutzername, Verfahren und Passwörter stimmen.`
      : `Keine Antwort von ${where}. Prüfe Adresse und Port — auch eine falsche Community bleibt unbeantwortet.`;
  }

  return lastError ? `${where}: ${lastError.message}` : `Keine Antwort von ${where}.`;
}

/**
 * Ermittelt das passende Profil, indem der Reihe nach das Kenn-OID jedes
 * Profils abgefragt wird. Das erste, das antwortet, gewinnt.
 *
 * Wirft, wenn überhaupt keine Antwort kam — sonst wäre „unerreichbar" von
 * „antwortet, aber unbekannte MIB" nicht zu unterscheiden.
 */
export async function detectProfile(target: SnmpTarget): Promise<MibProfile | null> {
  return withSession(target, async (session) => {
    let answered = false;
    let lastError: Error | null = null;

    for (const profile of PROFILES) {
      try {
        const [value] = await get(session, [profile.probeOid]);
        answered = true;
        if (value !== null && value !== '') return profile;
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (!answered) throw new Error(describeSilence(target, lastError));
    return null;
  });
}

/** Liest alle Felder eines Profils; erkennt es bei Bedarf zuerst. */
export async function readDevice(target: SnmpTarget, profileName?: string | null): Promise<SnmpReadResult> {
  const known = profileName ? profileByName(profileName) : undefined;
  const profile = known ?? (await detectProfile(target));

  if (!profile) {
    throw new Error(
      'Das Gerät antwortet, meldet sich aber weder mit der APC-MIB noch mit der Standard-USV-MIB. ' +
        'Prüfe, ob SNMP auf der Karte für diesen Zugang freigegeben ist.',
    );
  }

  return withSession(target, async (session) => {
    const keys = Object.keys(profile.oids);
    const values = await get(
      session,
      keys.map((key) => profile.oids[key]!),
    );

    const readings: Readings = {};
    keys.forEach((key, index) => {
      readings[key] = values[index] ?? null;
    });

    return { profile, readings };
  });
}
