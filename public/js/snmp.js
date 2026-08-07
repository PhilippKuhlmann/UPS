/**
 * USVs, die direkt per SNMP abgefragt werden — Netzwerkkarten wie die APC NMC.
 * Anders als bei NUT steht ein Eintrag hier für genau ein Gerät.
 */
import { api } from './api.js';
import { dateTime, duration, escapeHtml, number } from './format.js';

const BLANK = {
  name: '',
  host: '',
  port: 161,
  version: '2c',
  community: 'public',
  securityLevel: 'authPriv',
  securityName: '',
  authProtocol: 'sha',
  privProtocol: 'aes',
  profile: '',
};

function field({ id, label, value = '', type = 'text', hint, placeholder = '' }) {
  return `
    <div class="field">
      <label class="field__label" for="${id}">${label}</label>
      <input class="field__input" id="${id}" type="${type}" value="${escapeHtml(value)}"
             placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
      ${hint ? `<p class="field__hint">${hint}</p>` : ''}
    </div>
  `;
}

function select({ id, label, value, options, hint }) {
  return `
    <div class="field">
      <label class="field__label" for="${id}">${label}</label>
      <select class="field__input" id="${id}">
        ${options
          .map(
            ([v, text]) => `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(text)}</option>`,
          )
          .join('')}
      </select>
      ${hint ? `<p class="field__hint">${hint}</p>` : ''}
    </div>
  `;
}

export function renderSnmpSection(container, { onChanged }) {
  let devices = [];
  let meta = { profiles: [], securityLevels: [], authProtocols: [], privProtocols: [] };
  let editingId = null;
  let busy = false;

  const listPanel = document.createElement('section');
  listPanel.className = 'panel';

  const formPanel = document.createElement('section');
  formPanel.className = 'panel';

  container.append(listPanel, formPanel);

  function setMessage(text, tone) {
    const box = formPanel.querySelector('.server-form__message');
    if (!box) return;
    box.innerHTML = text ?? '';
    box.dataset.tone = tone ?? 'info';
    box.hidden = !text;
  }

  function paintForm() {
    const editing = editingId === null ? null : devices.find((device) => device.id === editingId);
    const v = editing ? { ...BLANK, ...editing, community: '' } : { ...BLANK };
    const isV3 = v.version === '3';

    formPanel.innerHTML = `
      <div class="panel__head">
        <h2 class="section-title">${editing ? `„${escapeHtml(editing.name)}" bearbeiten` : 'USV per SNMP hinzufügen'}</h2>
      </div>
      <div class="panel__body">
        <form class="server-form" novalidate>
          <div class="server-form__grid">
            ${field({ id: 'sn-name', label: 'Name', value: v.name, placeholder: 'z. B. apc-rack', hint: 'Wird Teil der Geräte-ID.' })}
            ${field({ id: 'sn-host', label: 'Adresse der Karte', value: v.host, placeholder: '192.168.1.20' })}
            ${field({ id: 'sn-port', label: 'Port', value: v.port, type: 'number' })}
            ${select({
              id: 'sn-version',
              label: 'SNMP-Version',
              value: v.version,
              options: [
                ['1', 'v1'],
                ['2c', 'v2c'],
                ['3', 'v3'],
              ],
            })}
            ${select({
              id: 'sn-profile',
              label: 'MIB-Profil',
              value: v.profile ?? '',
              options: [['', 'automatisch erkennen'], ...meta.profiles.map((p) => [p.name, p.label])],
            })}
          </div>

          <div class="server-form__grid" data-group="v1" ${isV3 ? 'hidden' : ''} style="margin-top:0.9rem">
            ${field({
              id: 'sn-community',
              label: 'Community',
              type: 'password',
              hint: editing?.hasCommunity ? 'Gespeichert. Leer lassen, um sie zu behalten.' : 'Meist „public".',
            })}
          </div>

          <div class="server-form__grid" data-group="v3" ${isV3 ? '' : 'hidden'} style="margin-top:0.9rem">
            ${field({ id: 'sn-securityName', label: 'Benutzername', value: v.securityName ?? '' })}
            ${select({
              id: 'sn-securityLevel',
              label: 'Sicherheitsstufe',
              value: v.securityLevel ?? 'authPriv',
              options: meta.securityLevels.map((s) => [s, s]),
            })}
            ${select({
              id: 'sn-authProtocol',
              label: 'Auth-Verfahren',
              value: v.authProtocol ?? 'sha',
              options: meta.authProtocols.map((s) => [s, s.toUpperCase()]),
            })}
            ${field({
              id: 'sn-authPassword',
              label: 'Auth-Passwort',
              type: 'password',
              hint: editing?.hasAuthPassword ? 'Gespeichert. Leer lassen, um es zu behalten.' : '',
            })}
            ${select({
              id: 'sn-privProtocol',
              label: 'Verschlüsselung',
              value: v.privProtocol ?? 'aes',
              options: meta.privProtocols.map((s) => [s, s.toUpperCase()]),
            })}
            ${field({
              id: 'sn-privPassword',
              label: 'Verschlüsselungs-Passwort',
              type: 'password',
              hint: editing?.hasPrivPassword ? 'Gespeichert. Leer lassen, um es zu behalten.' : '',
            })}
          </div>

          <div class="server-form__actions">
            <button class="command" type="button" data-action="test">Verbindung testen</button>
            <button class="button-primary" type="submit">${editing ? 'Änderungen speichern' : 'Gerät hinzufügen'}</button>
            ${editing ? '<button class="command" type="button" data-action="cancel">Abbrechen</button>' : ''}
          </div>
          <p class="server-form__message" role="status" hidden></p>
        </form>
      </div>
    `;

    const form = formPanel.querySelector('form');

    // v3 braucht andere Felder als v1/v2c — nur die passenden zeigen.
    form.querySelector('#sn-version').addEventListener('change', (event) => {
      const three = event.target.value === '3';
      form.querySelector('[data-group="v1"]').hidden = three;
      form.querySelector('[data-group="v3"]').hidden = !three;
    });

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

  function readForm(form) {
    const value = (id) => form.querySelector(`#sn-${id}`)?.value.trim() ?? '';
    const device = {
      name: value('name'),
      host: value('host'),
      port: Number(value('port')) || 161,
      version: value('version'),
      profile: value('profile'),
    };

    if (device.version === '3') {
      Object.assign(device, {
        securityName: value('securityName'),
        securityLevel: value('securityLevel'),
        authProtocol: value('authProtocol'),
        authPassword: form.querySelector('#sn-authPassword').value,
        privProtocol: value('privProtocol'),
        privPassword: form.querySelector('#sn-privPassword').value,
      });
    } else {
      device.community = form.querySelector('#sn-community').value;
    }

    return device;
  }

  async function test(form) {
    if (busy) return;
    busy = true;
    setMessage('Verbindung wird getestet …', 'info');

    const values = readForm(form);
    if (editingId !== null) values.id = editingId;

    try {
      const r = await api.testSnmpDevice(values);
      const m = r.metrics ?? {};
      const teile = [
        `Profil: ${r.profile.label}`,
        r.identity?.model ? `Modell: ${r.identity.model}` : null,
        r.statusFlags?.length ? `Status: ${r.statusFlags.join(' ')}` : null,
        m.charge !== undefined ? `Ladung ${number(m.charge)} %` : null,
        m.load !== undefined ? `Last ${number(m.load)} %` : null,
        m.runtimeSeconds !== undefined ? `Restlaufzeit ${duration(m.runtimeSeconds)}` : null,
        m.inputVoltage !== undefined ? `Eingang ${number(m.inputVoltage, 1)} V` : null,
      ].filter(Boolean);

      setMessage(`Verbindung steht.<br>${escapeHtml(teile.join(' · '))}`, 'good');
    } catch (error) {
      setMessage(`Keine Verbindung: ${escapeHtml(error.message)}`, 'error');
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
        await api.createSnmpDevice(values);
        setMessage(`„${escapeHtml(values.name)}" hinzugefügt.`, 'good');
      } else {
        // Leere Geheimnisse heißen „behalten", nicht „löschen".
        for (const key of ['community', 'authPassword', 'privPassword']) {
          if (!values[key]) delete values[key];
        }
        await api.updateSnmpDevice(editingId, values);
        editingId = null;
        setMessage('Änderungen gespeichert.', 'good');
      }

      await refresh();
      onChanged?.();
    } catch (error) {
      setMessage(escapeHtml(error.message), 'error');
    } finally {
      busy = false;
    }
  }

  async function remove(device) {
    const ok = window.confirm(
      `„${device.name}" entfernen?\n\nVerlauf und Ereignisse dieses Geräts werden mitgelöscht.`,
    );
    if (!ok) return;

    try {
      await api.deleteSnmpDevice(device.id);
      await refresh();
      onChanged?.();
    } catch (error) {
      setMessage(escapeHtml(error.message), 'error');
    }
  }

  function paintList() {
    listPanel.innerHTML = `
      <div class="panel__head">
        <h2 class="section-title">USV per SNMP <span class="eyebrow">${devices.length}</span></h2>
      </div>
      ${
        devices.length === 0
          ? `<div class="panel__body"><div class="empty-state">
               <div class="empty-state__title">Noch kein SNMP-Gerät</div>
               <p class="empty-state__text">Für USVs mit Netzwerkkarte, die keinen NUT-Server mitbringen — etwa APC. Adresse eintragen, „Verbindung testen", fertig.</p>
             </div></div>`
          : devices
              .map(
                (device) => `<div class="server-row" data-id="${device.id}">
                  <div>
                    <div class="server-row__name">${escapeHtml(device.name)}</div>
                    <div class="server-row__meta">${escapeHtml(device.host)}:${device.port} · SNMP ${escapeHtml(device.version)}${
                      device.version === '3' && device.securityName ? ` · Benutzer ${escapeHtml(device.securityName)}` : ''
                    } · ${device.profile ? escapeHtml(device.profile.toUpperCase()) : 'Profil automatisch'} · seit ${escapeHtml(dateTime(device.createdAt))}</div>
                  </div>
                  <span class="status-chip" data-severity="${device.enabled ? 'good' : 'warning'}">
                    ${device.enabled ? 'aktiv' : 'pausiert'}
                  </span>
                  <div class="server-row__actions">
                    <button class="command" type="button" data-act="toggle">${device.enabled ? 'Pausieren' : 'Aktivieren'}</button>
                    <button class="command" type="button" data-act="edit">Bearbeiten</button>
                    <button class="command" type="button" data-act="delete">Entfernen</button>
                  </div>
                </div>`,
              )
              .join('')
      }
    `;

    for (const row of listPanel.querySelectorAll('.server-row')) {
      const device = devices.find((entry) => entry.id === Number(row.dataset.id));

      row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
        await api.updateSnmpDevice(device.id, { enabled: !device.enabled });
        await refresh();
        onChanged?.();
      });
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        editingId = device.id;
        paintForm();
        formPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', () => void remove(device));
    }
  }

  async function refresh() {
    try {
      [devices, meta] = await Promise.all([api.snmpDevices(), api.snmpProfiles()]);
    } catch (error) {
      listPanel.innerHTML = `<div class="panel__body"><p class="note">SNMP-Geräte nicht ladbar: ${escapeHtml(error.message)}</p></div>`;
      return;
    }
    paintList();
    if (editingId !== null && !devices.some((device) => device.id === editingId)) editingId = null;
    paintForm();
  }

  void refresh();
}
