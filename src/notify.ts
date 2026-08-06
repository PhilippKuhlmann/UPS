import nodemailer from 'nodemailer';
import type { Store } from './store.js';
import type { AlertEvent, DeviceSnapshot, Severity } from './types.js';

const SETTINGS_KEY = 'notifications';

/** Ranking used by the minimum-severity filter. */
const SEVERITY_ORDER: Record<Severity, number> = { good: 0, warning: 1, serious: 2, critical: 3 };

export type ChannelName = 'webhook' | 'email' | 'telegram';

export interface WebhookConfig {
  enabled: boolean;
  url: string;
}

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** True for implicit TLS on port 465; false uses STARTTLS when offered. */
  secure: boolean;
  username: string;
  password: string;
  from: string;
  /** Comma separated. */
  to: string;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chatId: string;
}

export interface NotificationSettings {
  /** Alerts below this level are not sent anywhere. */
  minSeverity: Severity;
  /** Also send the all-clear when a condition ends. */
  sendClears: boolean;
  /** Send commands that cut power to the load. */
  sendDisruptiveCommands: boolean;
  webhook: WebhookConfig;
  email: EmailConfig;
  telegram: TelegramConfig;
}

export interface NotificationMessage {
  subject: string;
  body: string;
  /** Present for alerts, absent for a test message. */
  event?: AlertEvent | undefined;
  device?: DeviceSnapshot | undefined;
}

export interface ChannelResult {
  channel: ChannelName;
  ok: boolean;
  error?: string;
}

export const DEFAULT_SETTINGS: NotificationSettings = {
  minSeverity: 'warning',
  sendClears: true,
  sendDisruptiveCommands: true,
  webhook: { enabled: false, url: '' },
  email: {
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    from: '',
    to: '',
  },
  telegram: { enabled: false, token: '', chatId: '' },
};

/** Config for the browser — secrets replaced by a flag. */
export function redactSettings(settings: NotificationSettings) {
  return {
    minSeverity: settings.minSeverity,
    sendClears: settings.sendClears,
    sendDisruptiveCommands: settings.sendDisruptiveCommands,
    webhook: settings.webhook,
    email: { ...settings.email, password: '', hasPassword: Boolean(settings.email.password) },
    telegram: { ...settings.telegram, token: '', hasToken: Boolean(settings.telegram.token) },
  };
}

export class Notifier {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  settings(): NotificationSettings {
    const stored = this.store.setting<Partial<NotificationSettings>>(SETTINGS_KEY) ?? {};

    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      webhook: { ...DEFAULT_SETTINGS.webhook, ...stored.webhook },
      email: { ...DEFAULT_SETTINGS.email, ...stored.email },
      telegram: { ...DEFAULT_SETTINGS.telegram, ...stored.telegram },
    };
  }

  save(patch: Partial<NotificationSettings>): NotificationSettings {
    const current = this.settings();
    const next: NotificationSettings = {
      ...current,
      ...patch,
      webhook: { ...current.webhook, ...patch.webhook },
      email: { ...current.email, ...patch.email },
      telegram: { ...current.telegram, ...patch.telegram },
    };

    // An empty secret means "keep the stored one", never "clear it" — the
    // browser never receives the real value to send back.
    if (patch.email && !patch.email.password) next.email.password = current.email.password;
    if (patch.telegram && !patch.telegram.token) next.telegram.token = current.telegram.token;

    this.store.saveSetting(SETTINGS_KEY, next);
    return next;
  }

  /** Decides whether an event is worth a notification at all. */
  shouldSend(event: AlertEvent): boolean {
    const settings = this.settings();

    if (event.state === 'cleared') return settings.sendClears;
    if (event.state === 'executed') return settings.sendDisruptiveCommands;

    return SEVERITY_ORDER[event.severity] >= SEVERITY_ORDER[settings.minSeverity];
  }

  async notify(message: NotificationMessage): Promise<ChannelResult[]> {
    const settings = this.settings();
    const jobs: Promise<ChannelResult>[] = [];

    if (settings.webhook.enabled && settings.webhook.url) {
      jobs.push(this.runChannel('webhook', () => this.sendWebhook(settings.webhook, message)));
    }
    if (settings.email.enabled && settings.email.host && settings.email.to) {
      jobs.push(this.runChannel('email', () => this.sendEmail(settings.email, message)));
    }
    if (settings.telegram.enabled && settings.telegram.token && settings.telegram.chatId) {
      jobs.push(this.runChannel('telegram', () => this.sendTelegram(settings.telegram, message)));
    }

    return Promise.all(jobs);
  }

  /** Sends a test message through one channel using the supplied config. */
  async test(channel: ChannelName, config: unknown): Promise<ChannelResult> {
    const stored = this.settings();
    const message: NotificationMessage = {
      subject: 'USV-Überwachung: Testnachricht',
      body:
        'Das ist eine Testnachricht der USV-Überwachung.\n\n' +
        'Kommt sie an, funktioniert dieser Meldeweg. Echte Meldungen enthalten ' +
        'Gerät, Regel und Messwert.\n\n' +
        `Gesendet: ${new Date().toLocaleString('de-DE')}`,
    };

    return this.runChannel(channel, async () => {
      if (channel === 'webhook') {
        await this.sendWebhook({ ...stored.webhook, ...(config as WebhookConfig) }, message);
        return;
      }
      if (channel === 'email') {
        const merged = { ...stored.email, ...(config as EmailConfig) };
        if (!merged.password) merged.password = stored.email.password;
        await this.sendEmail(merged, message);
        return;
      }
      const merged = { ...stored.telegram, ...(config as TelegramConfig) };
      if (!merged.token) merged.token = stored.telegram.token;
      await this.sendTelegram(merged, message);
    });
  }

  private async runChannel(channel: ChannelName, fn: () => Promise<void>): Promise<ChannelResult> {
    try {
      await fn();
      return { channel, ok: true };
    } catch (error) {
      const reason = (error as Error).message;
      console.warn(`[notify] ${channel} fehlgeschlagen: ${reason}`);
      return { channel, ok: false, error: reason };
    }
  }

  private async sendWebhook(config: WebhookConfig, message: NotificationMessage): Promise<void> {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: message.subject,
        message: message.body,
        device: message.event?.deviceId ?? null,
        rule: message.event?.rule ?? null,
        state: message.event?.state ?? null,
        severity: message.event?.severity ?? null,
        value: message.event?.value ?? null,
        status: message.device?.statusFlags.join(' ') ?? null,
        timestamp: new Date(message.event?.ts ?? Date.now()).toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  }

  private async sendEmail(config: EmailConfig, message: NotificationMessage): Promise<void> {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });

    try {
      await transport.sendMail({
        from: config.from || config.username,
        to: config.to
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean),
        subject: message.subject,
        text: message.body,
      });
    } finally {
      transport.close();
    }
  }

  private async sendTelegram(config: TelegramConfig, message: NotificationMessage): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: `${message.subject}\n\n${message.body}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null;

    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.description ?? `HTTP ${response.status} ${response.statusText}`);
    }
  }
}

const SEVERITY_WORDS: Record<Severity, string> = {
  good: 'Entwarnung',
  warning: 'Hinweis',
  serious: 'Warnung',
  critical: 'Kritisch',
};

/** Turns an event into the subject and body used by every channel. */
export function messageForEvent(
  event: AlertEvent,
  title: string,
  device: DeviceSnapshot | undefined,
): NotificationMessage {
  const prefix = event.state === 'cleared' ? 'Entwarnung' : SEVERITY_WORDS[event.severity];
  const lines = [
    event.message,
    '',
    `Gerät:     ${event.deviceId}${device?.model ? ` (${device.model})` : ''}`,
    `Regel:     ${title}`,
    `Zeitpunkt: ${new Date(event.ts).toLocaleString('de-DE')}`,
  ];

  if (event.actor) lines.push(`Ausgelöst: ${event.actor}`);
  if (device?.statusFlags.length) lines.push(`Status:    ${device.statusFlags.join(' ')}`);

  if (device?.reachable) {
    const { charge, load, runtimeSeconds } = device.metrics;
    if (charge !== undefined) lines.push(`Ladung:    ${charge} %`);
    if (load !== undefined) lines.push(`Last:      ${load} %`);
    if (runtimeSeconds !== undefined) {
      lines.push(`Restlauf:  ${Math.round(runtimeSeconds / 60)} min`);
    }
  }

  return {
    subject: `[USV] ${prefix}: ${title} — ${event.deviceId}`,
    body: lines.join('\n'),
    event,
    device,
  };
}
