/**
 * Meldewege: Webhook, E-Mail und Telegram. Jeder Kanal lässt sich einzeln
 * einschalten, speichern und mit einer Testnachricht prüfen — ein Meldeweg,
 * den man nicht ausprobieren kann, merkt man erst im Ernstfall.
 */
import { api } from './api.js';
import { escapeHtml } from './format.js';

const SEVERITIES = [
  ['warning', 'ab Hinweis'],
  ['serious', 'ab Warnung'],
  ['critical', 'nur Kritisch'],
];

function field({ id, label, value = '', type = 'text', hint, placeholder = '' }) {
  return `
    <div class="field">
      <label class="field__label" for="${id}">${label}</label>
      <input class="field__input" id="${id}" name="${id}" type="${type}"
             value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"
             autocomplete="off" spellcheck="false" />
      ${hint ? `<p class="field__hint">${hint}</p>` : ''}
    </div>
  `;
}

function toggle({ id, label, checked }) {
  return `
    <label class="switch">
      <input type="checkbox" id="${id}" name="${id}" ${checked ? 'checked' : ''} />
      <span>${label}</span>
    </label>
  `;
}

export function renderNotifications(container) {
  let settings = null;

  const rulesPanel = document.createElement('section');
  rulesPanel.className = 'panel';

  const channelsPanel = document.createElement('section');
  channelsPanel.className = 'panel';

  container.append(rulesPanel, channelsPanel);

  function message(form, text, tone) {
    const box = form.querySelector('.server-form__message');
    box.textContent = text ?? '';
    box.dataset.tone = tone ?? 'info';
    box.hidden = !text;
  }

  async function save(patch, form, okText) {
    try {
      settings = await api.saveNotifications(patch);
      if (form) message(form, okText, 'good');
      return true;
    } catch (error) {
      if (form) message(form, error.message, 'error');
      return false;
    }
  }

  async function test(channel, config, form) {
    message(form, 'Testnachricht wird gesendet …', 'info');

    try {
      await api.testNotification(channel, config);
      message(form, 'Testnachricht wurde angenommen. Kommt sie nicht an, liegt es an der Gegenseite.', 'good');
    } catch (error) {
      message(form, `Fehlgeschlagen: ${error.message}`, 'error');
    }
  }

  function paintRules() {
    rulesPanel.innerHTML = `
      <div class="panel__head"><h2 class="section-title">Wann gemeldet wird</h2></div>
      <div class="panel__body">
        <form novalidate>
          <div class="field" style="max-width:16rem">
            <label class="field__label" for="minSeverity">Mindeststufe</label>
            <select class="field__input" id="minSeverity">
              ${SEVERITIES.map(
                ([value, label]) =>
                  `<option value="${value}" ${settings.minSeverity === value ? 'selected' : ''}>${label}</option>`,
              ).join('')}
            </select>
          </div>
          <div class="switch-list">
            ${toggle({ id: 'sendClears', label: 'Auch Entwarnungen senden', checked: settings.sendClears })}
            ${toggle({
              id: 'sendDisruptiveCommands',
              label: 'Befehle melden, die den Ausgang abschalten',
              checked: settings.sendDisruptiveCommands,
            })}
          </div>
          <div class="server-form__actions">
            <button class="button-primary" type="submit">Speichern</button>
          </div>
          <p class="server-form__message" role="status" hidden></p>
        </form>
      </div>
    `;

    const form = rulesPanel.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await save(
        {
          minSeverity: form.querySelector('#minSeverity').value,
          sendClears: form.querySelector('#sendClears').checked,
          sendDisruptiveCommands: form.querySelector('#sendDisruptiveCommands').checked,
        },
        form,
        'Gespeichert.',
      );
    });
  }

  function channelCard({ key, title, description, body }) {
    return `
      <form class="channel" data-channel="${key}" novalidate>
        <div class="channel__head">
          <div>
            <h3 class="channel__title">${title}</h3>
            <p class="field__hint">${description}</p>
          </div>
          ${toggle({ id: `${key}-enabled`, label: 'Aktiv', checked: settings[key].enabled })}
        </div>
        <div class="server-form__grid">${body}</div>
        <div class="server-form__actions">
          <button class="command" type="button" data-action="test">Testnachricht senden</button>
          <button class="button-primary" type="submit">Speichern</button>
        </div>
        <p class="server-form__message" role="status" hidden></p>
      </form>
    `;
  }

  function readChannel(key, form) {
    const value = (id) => form.querySelector(`#${key}-${id}`)?.value.trim() ?? '';
    const enabled = form.querySelector(`#${key}-enabled`).checked;

    if (key === 'webhook') return { enabled, url: value('url') };
    if (key === 'telegram') return { enabled, token: value('token'), chatId: value('chatId') };

    return {
      enabled,
      host: value('host'),
      port: Number(value('port')) || 587,
      secure: form.querySelector('#email-secure').checked,
      username: value('username'),
      password: form.querySelector('#email-password').value,
      from: value('from'),
      to: value('to'),
    };
  }

  function paintChannels() {
    channelsPanel.innerHTML = `
      <div class="panel__head"><h2 class="section-title">Meldewege</h2></div>
      <div class="panel__body channel-list">
        ${channelCard({
          key: 'email',
          title: 'E-Mail',
          description: 'Versand über einen SMTP-Server.',
          body: `
            ${field({ id: 'email-host', label: 'SMTP-Server', value: settings.email.host, placeholder: 'smtp.example.com' })}
            ${field({ id: 'email-port', label: 'Port', value: settings.email.port, type: 'number' })}
            <div class="field">
              <span class="field__label">Verschlüsselung</span>
              ${toggle({ id: 'email-secure', label: 'Direktes TLS', checked: settings.email.secure })}
              <p class="field__hint">An für Port 465, aus für Port 587 (STARTTLS).</p>
            </div>
            ${field({ id: 'email-username', label: 'Benutzername', value: settings.email.username })}
            ${field({
              id: 'email-password',
              label: 'Passwort',
              type: 'password',
              hint: settings.email.hasPassword ? 'Gespeichert. Leer lassen, um es zu behalten.' : '',
            })}
            ${field({ id: 'email-from', label: 'Absender', value: settings.email.from, placeholder: 'usv@example.com' })}
            ${field({
              id: 'email-to',
              label: 'Empfänger',
              value: settings.email.to,
              hint: 'Mehrere durch Komma trennen.',
            })}
          `,
        })}
        ${channelCard({
          key: 'telegram',
          title: 'Telegram',
          description: 'Über einen eigenen Bot. Token bekommst du von @BotFather.',
          body: `
            ${field({
              id: 'telegram-token',
              label: 'Bot-Token',
              type: 'password',
              hint: settings.telegram.hasToken ? 'Gespeichert. Leer lassen, um ihn zu behalten.' : '',
            })}
            ${field({
              id: 'telegram-chatId',
              label: 'Chat-ID',
              value: settings.telegram.chatId,
              hint: 'Deine eigene ID oder die einer Gruppe; Gruppen beginnen mit einem Minus.',
            })}
          `,
        })}
        ${channelCard({
          key: 'webhook',
          title: 'Webhook',
          description: 'JSON-POST an eine beliebige Adresse, etwa Home Assistant.',
          body: field({
            id: 'webhook-url',
            label: 'Adresse',
            value: settings.webhook.url,
            placeholder: 'https://homeassistant.local/api/webhook/ups-alert',
          }),
        })}
      </div>
    `;

    for (const form of channelsPanel.querySelectorAll('.channel')) {
      const key = form.dataset.channel;

      form.querySelector('[data-action="test"]').addEventListener('click', () =>
        void test(key, readChannel(key, form), form),
      );

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const saved = await save({ [key]: readChannel(key, form) }, form, 'Gespeichert.');
        // Nach dem Speichern zeigt das Feld wieder „gespeichert" statt leer.
        if (saved) paintChannels();
      });
    }
  }

  async function load() {
    try {
      settings = await api.notifications();
    } catch (error) {
      rulesPanel.innerHTML = `<div class="panel__body"><p class="note">Einstellungen nicht ladbar: ${escapeHtml(error.message)}</p></div>`;
      return;
    }
    paintRules();
    paintChannels();
  }

  void load();

  return { onState: () => {}, destroy() {} };
}
