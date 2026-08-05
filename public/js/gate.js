/**
 * The screens shown before the dashboard: signing in, and replacing the
 * starting password. Both share the panel language of the rest of the app.
 */
import { api } from './api.js';

function field({ id, label, type = 'text', autocomplete, hint }) {
  return `
    <div class="field">
      <label class="field__label" for="${id}">${label}</label>
      <input class="field__input" id="${id}" name="${id}" type="${type}"
             autocomplete="${autocomplete}" required spellcheck="false" />
      ${hint ? `<p class="field__hint">${hint}</p>` : ''}
    </div>
  `;
}

function gatePanel(inner) {
  const wrapper = document.createElement('div');
  wrapper.className = 'gate';
  wrapper.innerHTML = `<section class="gate__panel">${inner}</section>`;
  return wrapper;
}

function showError(form, message) {
  const box = form.querySelector('.gate__error');
  box.textContent = message ?? '';
  box.hidden = !message;
}

/** @param onSuccess Receives the signed-in user. */
export function renderLogin(container, onSuccess) {
  const view = gatePanel(`
    <p class="eyebrow">Zugang</p>
    <h2 class="gate__title">Anmelden</h2>
    <p class="gate__text">Die Überwachung ist nur nach Anmeldung erreichbar.</p>
    <form class="gate__form" novalidate>
      ${field({ id: 'username', label: 'Benutzername', autocomplete: 'username' })}
      ${field({ id: 'password', label: 'Passwort', type: 'password', autocomplete: 'current-password' })}
      <p class="gate__error" role="alert" hidden></p>
      <button class="button-primary" type="submit">Anmelden</button>
    </form>
  `);

  container.replaceChildren(view);

  const form = view.querySelector('form');
  const button = form.querySelector('button');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(form, null);

    const username = form.username.value.trim();
    const password = form.password.value;

    if (!username || !password) {
      showError(form, 'Benutzername und Passwort eingeben.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Wird geprüft …';

    try {
      const result = await api.login(username, password);
      onSuccess(result.user);
    } catch (error) {
      showError(form, error.message);
      form.password.value = '';
      form.password.focus();
    } finally {
      button.disabled = false;
      button.textContent = 'Anmelden';
    }
  });

  form.username.focus();
}

/**
 * The password form itself, used twice: full-screen while the starting password
 * is still in place, and inside the account panel afterwards.
 *
 * @param onSuccess Receives the updated user.
 */
function createPasswordForm({ onSuccess, submitLabel = 'Passwort speichern', resetAfterSuccess = false }) {
  const form = document.createElement('form');
  form.className = 'gate__form';
  form.noValidate = true;
  form.innerHTML = `
    ${field({ id: 'currentPassword', label: 'Aktuelles Passwort', type: 'password', autocomplete: 'current-password' })}
    ${field({
      id: 'newPassword',
      label: 'Neues Passwort',
      type: 'password',
      autocomplete: 'new-password',
      hint: 'Mindestens 8 Zeichen.',
    })}
    ${field({ id: 'repeatPassword', label: 'Neues Passwort wiederholen', type: 'password', autocomplete: 'new-password' })}
    <p class="gate__error" role="alert" hidden></p>
    <button class="button-primary" type="submit">${submitLabel}</button>
  `;

  const button = form.querySelector('button');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(form, null);

    const current = form.currentPassword.value;
    const next = form.newPassword.value;

    if (next.length < 8) {
      showError(form, 'Das neue Passwort braucht mindestens 8 Zeichen.');
      return;
    }
    if (next !== form.repeatPassword.value) {
      showError(form, 'Die beiden neuen Passwörter stimmen nicht überein.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Wird gespeichert …';

    try {
      const result = await api.changePassword(current, next);
      if (resetAfterSuccess) form.reset();
      onSuccess(result.user);
    } catch (error) {
      showError(form, error.message);
    } finally {
      button.disabled = false;
      button.textContent = submitLabel;
    }
  });

  return form;
}

/** Shown while the account still carries the password it was created with. */
export function renderPasswordChange(container, user, onSuccess) {
  const view = gatePanel(`
    <p class="eyebrow">Angemeldet als ${user.username}</p>
    <h2 class="gate__title">Passwort ersetzen</h2>
    <p class="gate__text">Dieses Konto hat noch das Startpasswort. Vergib ein eigenes, dann geht es weiter.</p>
  `);

  const form = createPasswordForm({ onSuccess });
  view.querySelector('.gate__panel').append(form);
  container.replaceChildren(view);
  form.currentPassword.focus();
}

/** The account view: who is signed in, and changing the password. */
export function renderAccount(container, { user, onChanged }) {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel__head">
      <h2 class="section-title">Konto</h2>
      <span class="eyebrow">angemeldet als ${user?.username ?? '—'}</span>
    </div>
    <div class="panel__body">
      <h3 class="eyebrow">Passwort ändern</h3>
      <p class="gate__text" style="margin-bottom:1.2rem">
        Nach dem Speichern bleibst du hier angemeldet. Alle anderen Sitzungen
        dieses Kontos werden beendet — wer sonst noch eingeloggt ist, muss sich
        neu anmelden.
      </p>
    </div>
  `;

  const body = panel.querySelector('.panel__body');
  const done = document.createElement('p');
  done.className = 'server-form__message';
  done.dataset.tone = 'good';
  done.hidden = true;
  done.textContent = 'Passwort geändert.';

  const form = createPasswordForm({
    submitLabel: 'Passwort ändern',
    resetAfterSuccess: true,
    onSuccess: (updated) => {
      done.hidden = false;
      onChanged?.(updated);
    },
  });

  // A fresh attempt hides the previous confirmation.
  form.addEventListener('input', () => {
    done.hidden = true;
  });

  body.append(form, done);
  container.replaceChildren(panel);

  return { onState: () => {}, destroy() {} };
}
