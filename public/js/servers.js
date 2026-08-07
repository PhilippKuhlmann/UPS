/**
 * Managing NUT servers from the interface. Adding one is deliberately a two-step
 * move: test the connection first, see which UPS devices answer, then save.
 */
import { api } from './api.js';
import { dateTime, escapeHtml } from './format.js';
import { renderSnmpSection } from './snmp.js';

const BLANK = { name: '', host: '', port: 3493, username: '', password: '' };

function formMarkup(values, { editing }) {
  return `
    <div class="server-form__grid">
      <div class="field">
        <label class="field__label" for="sf-name">Name</label>
        <input class="field__input" id="sf-name" name="name" value="${escapeHtml(values.name)}"
               placeholder="z. B. rack" spellcheck="false" />
        <p class="field__hint">Wird Teil der Geräte-ID, z. B. <code>rack/ups01</code>.</p>
      </div>
      <div class="field">
        <label class="field__label" for="sf-host">Adresse</label>
        <input class="field__input" id="sf-host" name="host" value="${escapeHtml(values.host)}"
               placeholder="192.168.1.10" spellcheck="false" />
      </div>
      <div class="field field--narrow">
        <label class="field__label" for="sf-port">Port</label>
        <input class="field__input" id="sf-port" name="port" type="number" min="1" max="65535"
               value="${escapeHtml(values.port)}" />
      </div>
      <div class="field">
        <label class="field__label" for="sf-username">Benutzername</label>
        <input class="field__input" id="sf-username" name="username" value="${escapeHtml(values.username ?? '')}"
               autocomplete="off" spellcheck="false" />
        <p class="field__hint">Nur für Befehle nötig.</p>
      </div>
      <div class="field">
        <label class="field__label" for="sf-password">Passwort</label>
        <input class="field__input" id="sf-password" name="password" type="password" autocomplete="new-password"
               placeholder="${editing ? 'unverändert lassen' : ''}" />
      </div>
    </div>
    <div class="server-form__actions">
      <button class="command" type="button" data-action="test">Verbindung testen</button>
      <button class="button-primary" type="submit">${editing ? 'Änderungen speichern' : 'Server hinzufügen'}</button>
      ${editing ? '<button class="command" type="button" data-action="cancel">Abbrechen</button>' : ''}
    </div>
    <p class="server-form__message" role="status" hidden></p>
  `;
}

function readForm(form) {
  return {
    name: form.name.value.trim(),
    host: form.host.value.trim(),
    port: Number(form.port.value) || 3493,
    username: form.username.value.trim(),
    password: form.password.value,
  };
}

export function renderServers(container, { onChanged }) {
  let servers = [];
  let editingId = null;
  let busy = false;

  const listPanel = document.createElement('section');
  listPanel.className = 'panel';

  const formPanel = document.createElement('section');
  formPanel.className = 'panel';

  container.append(listPanel, formPanel);

  // Direkt per SNMP abgefragte Geräte stehen darunter — für USVs, deren
  // Netzwerkkarte kein NUT spricht.
  const snmpSection = document.createElement('div');
  snmpSection.style.marginTop = '2rem';
  container.append(snmpSection);
  renderSnmpSection(snmpSection, { onChanged });

  function setMessage(text, tone) {
    const box = formPanel.querySelector('.server-form__message');
    if (!box) return;
    box.textContent = text ?? '';
    box.dataset.tone = tone ?? 'info';
    box.hidden = !text;
  }

  function paintForm() {
    const editing = editingId === null ? null : servers.find((server) => server.id === editingId);
    const values = editing
      ? { ...editing, username: editing.username ?? '', password: '' }
      : { ...BLANK };

    formPanel.innerHTML = `
      <div class="panel__head">
        <h2 class="section-title">${editing ? `Server „${escapeHtml(editing.name)}" bearbeiten` : 'USV-Server hinzufügen'}</h2>
      </div>
      <div class="panel__body">
        <form class="server-form" novalidate>${formMarkup(values, { editing: Boolean(editing) })}</form>
      </div>
    `;

    const form = formPanel.querySelector('form');

    form.querySelector('[data-action="test"]').addEventListener('click', () => void test(form));
    form.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      editingId = null;
      paintForm();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void save(form);
    });
  }

  async function test(form) {
    if (busy) return;
    busy = true;
    setMessage('Verbindung wird getestet …', 'info');

    const values = readForm(form);
    if (editingId !== null && !values.password) values.id = editingId;

    try {
      const result = await api.testServer(values);
      const names = result.devices.map((device) => device.name);
      setMessage(
        names.length === 0
          ? `Verbindung steht (${result.version || 'NUT'}), der Server meldet aber keine USV.`
          : `Verbindung steht (${result.version || 'NUT'}) · gefunden: ${names.join(', ')}`,
        names.length === 0 ? 'warning' : 'good',
      );
    } catch (error) {
      setMessage(`Keine Verbindung: ${error.message}`, 'error');
    } finally {
      busy = false;
    }
  }

  async function save(form) {
    if (busy) return;
    busy = true;

    const values = readForm(form);
    if (!values.name || !values.host) {
      setMessage('Name und Adresse werden gebraucht.', 'error');
      busy = false;
      return;
    }

    try {
      if (editingId === null) {
        await api.createServer(values);
        setMessage(`„${values.name}" hinzugefügt.`, 'good');
      } else {
        const patch = { ...values };
        // An empty field means "keep the stored password", not "clear it".
        if (!patch.password) delete patch.password;
        await api.updateServer(editingId, patch);
        editingId = null;
        setMessage('Änderungen gespeichert.', 'good');
      }

      await refresh();
      onChanged?.();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      busy = false;
    }
  }

  async function remove(server) {
    const confirmed = window.confirm(
      `„${server.name}" entfernen?\n\nDer Verlauf und die Ereignisse aller Geräte dieses Servers werden mitgelöscht.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteServer(server.id);
      await refresh();
      onChanged?.();
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  async function toggleEnabled(server) {
    try {
      await api.updateServer(server.id, { enabled: !server.enabled });
      await refresh();
      onChanged?.();
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  function paintList() {
    listPanel.innerHTML = `
      <div class="panel__head">
        <h2 class="section-title">NUT-Server <span class="eyebrow">${servers.length}</span></h2>
      </div>
      ${
        servers.length === 0
          ? `<div class="panel__body"><div class="empty-state">
               <div class="empty-state__title">Noch kein Server</div>
               <p class="empty-state__text">Trag unten die Adresse deines NUT-Servers ein. Über „Verbindung testen" siehst du sofort, welche USV er meldet.</p>
             </div></div>`
          : servers
              .map(
                (server) => `<div class="server-row" data-id="${server.id}">
                  <div>
                    <div class="server-row__name">${escapeHtml(server.name)}</div>
                    <div class="server-row__meta">${escapeHtml(server.host)}:${server.port}${
                      server.username ? ` · Benutzer ${escapeHtml(server.username)}` : ' · ohne Anmeldung'
                    } · seit ${escapeHtml(dateTime(server.createdAt))}</div>
                  </div>
                  <span class="status-chip" data-severity="${server.enabled ? 'good' : 'warning'}">
                    ${server.enabled ? 'aktiv' : 'pausiert'}
                  </span>
                  <div class="server-row__actions">
                    <button class="command" type="button" data-act="toggle">${server.enabled ? 'Pausieren' : 'Aktivieren'}</button>
                    <button class="command" type="button" data-act="edit">Bearbeiten</button>
                    <button class="command" type="button" data-act="delete">Entfernen</button>
                  </div>
                </div>`,
              )
              .join('')
      }
    `;

    for (const row of listPanel.querySelectorAll('.server-row')) {
      const server = servers.find((entry) => entry.id === Number(row.dataset.id));
      row.querySelector('[data-act="toggle"]').addEventListener('click', () => void toggleEnabled(server));
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        editingId = server.id;
        paintForm();
        formPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', () => void remove(server));
    }
  }

  async function refresh() {
    try {
      servers = await api.servers();
    } catch (error) {
      listPanel.innerHTML = `<div class="panel__body"><p class="note">Serverliste nicht ladbar: ${escapeHtml(error.message)}</p></div>`;
      return;
    }
    paintList();
    if (editingId !== null && !servers.some((server) => server.id === editingId)) editingId = null;
  }

  paintForm();
  void refresh();

  return { onState: () => {}, destroy() {} };
}
