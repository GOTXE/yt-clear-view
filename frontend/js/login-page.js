// Login page overlay — blocks access until authenticated.
// Handles: login, register, Google OAuth, passkey, device pairing, setup wizard.

(() => {
  const t = (key, vars) => (
    window.ytcvI18n && typeof window.ytcvI18n.t === 'function'
      ? window.ytcvI18n.t(key, vars)
      : key
  );

  function getApi() {
    if (window.appApiClient) return window.appApiClient;
    if (window.APIClient && window.APP_CONFIG) {
      window.appApiClient = new window.APIClient(
        window.APP_CONFIG.API_BASE_URL,
        window.APP_CONFIG.REQUEST_TIMEOUT
      );
      return window.appApiClient;
    }
    return null;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let overlay = null;
  let currentView = 'login'; // 'login' | 'wizard' | 'pairing' | 'bootstrap' | 'password-change'
  let authProviderData = null;
  let visible = false;
  let _pairingPollTimer = null;
  let _pairingPublicId = null;
  let _bootstrapCountdownTimer = null;
  let _deviceFlowPollTimer = null;
  let _deviceFlowPending = false; // true when wizard is used after device flow
  let _deviceFlowIntent = 'login'; // 'login' or 'link'

  // ── Helpers ───────────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  function isGestorSurface() {
    return document.body && document.body.classList.contains('gestor-body');
  }

  function releaseAuthGate() {
    document.documentElement.classList.remove('auth-pending');
    const scrim = el('startup-scrim');
    if (scrim) {
      scrim.hidden = true;
    }
  }

  function setError(containerId, message) {
    const container = el(containerId);
    if (!container) return;
    container.textContent = message || '';
    container.hidden = !message;
  }

  function setSubmitting(buttonId, labelId, loadingKey, isSubmitting) {
    const btn = el(buttonId);
    const lbl = el(labelId);
    if (!btn) return;
    btn.disabled = isSubmitting;
    if (lbl) lbl.textContent = isSubmitting ? t(loadingKey) : t(labelId === 'login-submit-label' ? 'loginSubmit' : labelId === 'register-submit-label' ? 'registerSubmit' : 'setupWizardSave');
  }

  function resolveOAuthUrl(path) {
    if (!path) return null;
    try {
      return new URL(path, window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL).toString();
    } catch (_) {
      return path;
    }
  }

  function notifyAuthSuccess(user) {
    // Prefer auth.js's setAuthenticated so it updates its internal state + UI
    if (typeof window.notifyAuthenticated === 'function') {
      window.notifyAuthenticated(user);
    } else {
      window.dispatchEvent(new CustomEvent('auth:changed', { detail: { user } }));
    }
  }

  // ── Show / Hide ───────────────────────────────────────────────────────────

  function show(options = {}) {
    if (!overlay) build();
    visible = true;
    overlay.hidden = false;
    document.body.classList.add('login-page-open');
    releaseAuthGate();

    if (options.bootstrap || (authProviderData && authProviderData.bootstrap_required)) {
      showView('bootstrap', options);
    } else if (options.passwordChange) {
      showView('password-change', options);
    } else if (options.wizard) {
      showView('wizard', options);
    } else {
      showView('login');
    }
    applyI18n();
    applyAuthProviderButtons();
  }

  function hide() {
    if (!overlay) return;
    visible = false;
    overlay.hidden = true;
    document.body.classList.remove('login-page-open');
    clearErrors();
  }

  function isVisible() { return visible; }

  // ── View switching ────────────────────────────────────────────────────────

  function showView(view, options = {}) {
    if (currentView === 'pairing' && view !== 'pairing') _stopPairingPoll();
    if (currentView === 'device-flow' && view !== 'device-flow') _stopDeviceFlowPoll();
    currentView = view;
    const views = ['login', 'wizard', 'pairing', 'bootstrap', 'password-change', 'device-flow', 'device-flow-confirm'];
    views.forEach(v => {
      const panel = el(`lp-${v}`);
      if (panel) panel.hidden = v !== view;
    });

    if (view === 'wizard' && options.username) {
      const input = el('lp-wizard-username');
      if (input) input.value = options.username;
    }
    if (view === 'bootstrap') {
      const input = el('lp-bootstrap-username');
      if (input) window.setTimeout(() => input.focus(), 0);
      const bw = authProviderData && authProviderData.bootstrap_window;
      if (bw && bw.locked) {
        _showBootstrapLocked();
      } else if (bw && bw.remaining_seconds > 0) {
        _startBootstrapCountdown(bw.remaining_seconds);
      }
    } else {
      _stopBootstrapCountdown();
    }

    clearErrors();
  }

  function clearErrors() {
    ['lp-login-error', 'lp-register-error', 'lp-wizard-error', 'lp-bootstrap-error', 'lp-password-change-error', 'lp-device-flow-error', 'lp-device-flow-confirm-error'].forEach(id => {
      const node = el(id);
      if (node) { node.textContent = ''; node.hidden = true; }
    });
  }

  function togglePasswordVisibility(inputId, buttonId) {
    const input = el(inputId);
    const button = el(buttonId);
    if (!input || !button) {
      return;
    }

    const nextType = input.type === 'password' ? 'text' : 'password';
    input.type = nextType;
    const isVisible = nextType === 'text';
    button.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
    button.setAttribute('aria-label', t(isVisible ? 'hidePassword' : 'showPassword'));
    button.textContent = isVisible ? '🙈' : '👁';
  }

  // ── Build DOM ─────────────────────────────────────────────────────────────

  function build() {
    const gestorSurface = isGestorSurface();
    overlay = document.createElement('section');
    overlay.id = 'login-page';
    overlay.className = 'login-page-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-labelledby', 'lp-title');
    overlay.hidden = true;

    overlay.innerHTML = `
      <header class="login-page__masthead" aria-hidden="true">
        <p class="login-page__masthead-title">YT CLEAR VIEW</p>
      </header>

      <div class="login-page__body">
        <div class="login-page__pitch" aria-hidden="true">
          <p class="login-page__pitch-eyebrow" data-i18n="loginPitchEyebrow">YT Clear View</p>
          <h2 class="login-page__pitch-title" data-i18n="loginPitchTitle">Your subscriptions, actually organized.</h2>
          <p class="login-page__pitch-lead" data-i18n="loginPitchLead">A calmer way to keep up with the channels you follow — grouped, filtered, and free of noise.</p>
          <ul class="login-page__pitch-features">
            <li>
              <span class="login-page__pitch-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span>
              <span data-i18n="loginPitchFeature1">Group channels into your own categories</span>
            </li>
            <li>
              <span class="login-page__pitch-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg></span>
              <span data-i18n="loginPitchFeature2">Filter out Shorts everywhere, not just per search</span>
            </li>
            <li>
              <span class="login-page__pitch-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg></span>
              <span data-i18n="loginPitchFeature3">See what's new at a glance, then move on</span>
            </li>
          </ul>
        </div>

        <div class="login-page__card">
        <div class="login-page__brand">
          <h1 class="heading-1 login-page__app-name">YT Clear View</h1>
        </div>

        <!-- LOGIN PANEL -->
        <div id="lp-login" class="login-page__panel">
          <h2 id="lp-title" class="heading-2 login-page__title" data-i18n="loginPageTitle">Sign in</h2>
          <form id="lp-login-form" class="login-page__form" novalidate>
            <label class="field">
              <span class="field__label" data-i18n="loginUsername">Username</span>
              <input id="lp-login-username" class="field__input" type="text" autocomplete="username" autocapitalize="none" required>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="loginPassword">Password</span>
              <div class="field__control">
                <input id="lp-login-password" class="field__input field__input--with-toggle" type="password" autocomplete="current-password" required>
                <button
                  id="lp-login-password-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-login-password"
                >👁</button>
              </div>
            </label>
            <p id="lp-login-error" class="login-page__error body" role="alert" hidden></p>
            <button id="lp-login-submit" class="button login-page__submit" type="submit">
              <span id="login-submit-label" data-i18n="loginSubmit">Sign in</span>
            </button>
          </form>
          <div class="login-page__divider" id="lp-divider" hidden>
            <span data-i18n="loginOrDivider">or</span>
          </div>
          <div class="login-page__alt-actions" id="lp-alt-actions">
            ${!gestorSurface ? `
            <button id="lp-google-button" class="button button--ghost login-page__alt-button login-page__google-btn" type="button" hidden>
              <span class="login-page__alt-icon login-page__alt-icon--google" aria-hidden="true">G</span>
              <span class="login-page__alt-label" data-i18n="loginWithGoogle">Google</span>
            </button>
            ` : ''}
            <button id="lp-passkey-button" class="button button--ghost login-page__alt-button" type="button" hidden>
              <span class="login-page__alt-icon login-page__alt-icon--passkey" aria-hidden="true">🔑</span>
              <span class="login-page__alt-label" data-i18n="loginWithPasskey">Passkey</span>
            </button>
            ${!gestorSurface ? `
            <button id="lp-device-button" class="button button--ghost login-page__alt-button" type="button" hidden>
              <span class="login-page__alt-icon login-page__alt-icon--code" aria-hidden="true">⌗</span>
              <span class="login-page__alt-label" data-i18n="signInWithDeviceCode">Code</span>
            </button>
            ` : ''}
          </div>
          <p class="login-page__switch caption">
            <span data-i18n="loginNoAccount">No account yet?</span>
            <button id="lp-go-register" class="login-page__link" type="button" data-i18n="loginRegisterLink">Create one</button>
          </p>
        </div>

        <!-- ADMIN BOOTSTRAP PANEL -->
        <div id="lp-bootstrap" class="login-page__panel" hidden>
          <h2 class="heading-2 login-page__title" data-i18n="adminBootstrapTitle">Configure administrator</h2>
          <p class="body login-page__subtitle" data-i18n="adminBootstrapSubtitle">This is the first startup. Create the administrator account for this site.</p>
          <p id="lp-bootstrap-countdown" class="body login-page__countdown" hidden></p>
          <div id="lp-bootstrap-locked-msg" class="login-page__locked" hidden>
            <p class="body" data-i18n="adminBootstrapLocked">Bootstrap window expired. Restart the application to try again.</p>
          </div>
          <form id="lp-bootstrap-form" class="login-page__form" novalidate>
            <label class="field">
              <span class="field__label" data-i18n="adminBootstrapUsername">Username</span>
              <input id="lp-bootstrap-username" class="field__input" type="text" autocomplete="username" autocapitalize="none" required>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="adminBootstrapDisplayName">Display name</span>
              <input id="lp-bootstrap-display-name" class="field__input" type="text" autocomplete="name">
            </label>
            <label class="field">
              <span class="field__label" data-i18n="adminBootstrapPassword">Password</span>
              <div class="field__control">
                <input id="lp-bootstrap-password" class="field__input field__input--with-toggle" type="password" autocomplete="new-password" required>
                <button
                  id="lp-bootstrap-password-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-bootstrap-password"
                >👁</button>
              </div>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="adminBootstrapPasswordConfirm">Confirm password</span>
              <div class="field__control">
                <input id="lp-bootstrap-password-confirm" class="field__input field__input--with-toggle" type="password" autocomplete="new-password" required>
                <button
                  id="lp-bootstrap-password-confirm-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-bootstrap-password-confirm"
                >👁</button>
              </div>
            </label>
            <p id="lp-bootstrap-error" class="login-page__error body" role="alert" hidden></p>
            <button id="lp-bootstrap-submit" class="button login-page__submit" type="submit">
              <span id="bootstrap-submit-label" data-i18n="adminBootstrapSubmit">Create administrator</span>
            </button>
            <p class="login-page__switch caption" data-i18n="adminBootstrapFootnote">Only shown while no administrator account exists.</p>
          </form>
        </div>

        <!-- DEVICE FLOW PANEL -->
        <div id="lp-device-flow" class="login-page__panel" hidden>
          <h2 class="heading-2 login-page__title" data-i18n="deviceFlowTitle">Sign in with Google</h2>
          <p class="body login-page__subtitle" data-i18n="deviceFlowSubtitle">Authorize this app using your Google account.</p>
          <div id="lp-device-flow-code-box" class="login-page__device-flow-code" hidden>
            <p class="login-page__device-flow-instruction" data-i18n="deviceFlowInstruction">Go to the URL below and enter this code:</p>
            <p class="login-page__device-flow-user-code" id="lp-device-flow-user-code"></p>
            <p class="login-page__device-flow-url" id="lp-device-flow-url"></p>
            <div class="login-page__device-flow-qr" id="lp-device-flow-qr"></div>
            <p class="caption login-page__device-flow-status" id="lp-device-flow-status" data-i18n="deviceFlowWaiting">Waiting for authorization...</p>
          </div>
          <p id="lp-device-flow-loading" class="body" data-i18n="deviceFlowStarting">Starting device flow...</p>
          <p id="lp-device-flow-error" class="login-page__error body" role="alert" hidden></p>
          <div class="login-page__alt-actions">
            <button id="lp-device-flow-cancel" class="button button--ghost" type="button" data-i18n="cancel">Cancel</button>
          </div>
        </div>

        <!-- DEVICE FLOW CONFIRM PANEL -->
        <div id="lp-device-flow-confirm" class="login-page__panel" hidden>
          <h2 class="heading-2 login-page__title" data-i18n="deviceFlowConfirmTitle">Confirm Google account</h2>
          <div class="login-page__device-flow-identity" id="lp-device-flow-identity">
            <img id="lp-device-flow-avatar" class="login-page__device-flow-avatar" src="" alt="" width="64" height="64">
            <p class="body" id="lp-device-flow-name"></p>
            <p class="caption" id="lp-device-flow-email"></p>
          </div>
          <p id="lp-device-flow-confirm-msg" class="body" hidden></p>
          <p id="lp-device-flow-confirm-error" class="login-page__error body" role="alert" hidden></p>
          <div class="login-page__alt-actions">
            <button id="lp-device-flow-confirm-yes" class="button login-page__submit" type="button" data-i18n="deviceFlowConfirmLink">Link account</button>
            <button id="lp-device-flow-confirm-cancel" class="button button--ghost" type="button" data-i18n="cancel">Cancel</button>
          </div>
        </div>

        <!-- PAIRING PANEL -->
        <div id="lp-pairing" class="login-page__panel" hidden>
          <h2 class="heading-2 login-page__title" data-i18n="pairingLoginTitle">Sign in with device code</h2>
          <p class="body login-page__subtitle" data-i18n="pairingLoginDescription">Use a device code when another signed-in device is nearby to approve this sign-in.</p>
          <div id="lp-pairing-code-box" class="login-page__pairing-code" hidden>
            <p class="login-page__pairing-code-value" id="lp-pairing-code-display"></p>
            <p class="caption login-page__pairing-status" id="lp-pairing-status"></p>
          </div>
          <p id="lp-pairing-loading" class="body login-page__pairing-loading" data-i18n="pairingCodeStarting">Generating device code...</p>
          <p id="lp-pairing-error" class="login-page__error body" role="alert" hidden></p>
          <div class="login-page__alt-actions">
            <button id="lp-pairing-cancel" class="button button--ghost" type="button" data-i18n="cancel">Cancel</button>
            <button id="lp-pairing-new" class="button button--ghost" type="button" data-i18n="generateNewDeviceCode" hidden>Generate new code</button>
          </div>
        </div>

        <!-- SETUP WIZARD PANEL -->
        <div id="lp-wizard" class="login-page__panel" hidden>
          <h2 class="heading-2 login-page__title" data-i18n="setupWizardTitle">Welcome! Set up your account</h2>
          <p class="body login-page__subtitle" data-i18n="setupWizardSubtitle">You signed in with Google. Customize your local identity.</p>
          <form id="lp-wizard-form" class="login-page__form" novalidate>
            <label class="field">
              <span class="field__label" data-i18n="setupWizardUsernameLabel">Choose a username</span>
              <input id="lp-wizard-username" class="field__input" type="text" autocomplete="username" autocapitalize="none" required>
              <span class="field__hint caption" data-i18n="setupWizardUsernameHint">This is how you sign in locally.</span>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="setupWizardPasswordLabel">Set a password</span>
              <div class="field__control">
                <input id="lp-wizard-password" class="field__input field__input--with-toggle" type="password" autocomplete="new-password" required>
                <button
                  id="lp-wizard-password-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-wizard-password"
                >👁</button>
              </div>
              <span class="field__hint caption" data-i18n="setupWizardPasswordHint">Required for local sign-in on LAN devices.</span>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="setupWizardPasswordConfirmLabel">Confirm password</span>
              <div class="field__control">
                <input id="lp-wizard-password-confirm" class="field__input field__input--with-toggle" type="password" autocomplete="new-password" required>
                <button
                  id="lp-wizard-password-confirm-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-wizard-password-confirm"
                >👁</button>
              </div>
            </label>
            <p id="lp-wizard-error" class="login-page__error body" role="alert" hidden></p>
            <button id="lp-wizard-submit" class="button login-page__submit" type="submit">
              <span id="wizard-submit-label" data-i18n="setupWizardSave">Save and continue</span>
            </button>
          </form>
        </div>

        <!-- PASSWORD CHANGE PANEL -->
        <div id="lp-password-change" class="login-page__panel" hidden>
          <h2 class="heading-2 login-page__title" data-i18n="passwordChangeRequiredTitle">Change your password</h2>
          <p class="body login-page__subtitle" data-i18n="passwordChangeRequiredSubtitle">Your temporary password must be changed before entering the app.</p>
          <form id="lp-password-change-form" class="login-page__form" novalidate>
            <label class="field">
              <span class="field__label" data-i18n="accountPasswordCurrent">Current password</span>
              <input id="lp-password-change-current" class="field__input" type="password" autocomplete="current-password" required>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="accountPasswordNew">New password</span>
              <div class="field__control">
                <input id="lp-password-change-new" class="field__input field__input--with-toggle" type="password" autocomplete="new-password" required>
                <button
                  id="lp-password-change-new-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-password-change-new"
                >👁</button>
              </div>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="accountPasswordConfirm">Confirm new password</span>
              <div class="field__control">
                <input id="lp-password-change-confirm" class="field__input field__input--with-toggle" type="password" autocomplete="new-password" required>
                <button
                  id="lp-password-change-confirm-toggle"
                  class="field__toggle"
                  type="button"
                  aria-label="Show password"
                  aria-pressed="false"
                  data-i18n-aria-label="showPassword"
                  data-password-toggle-for="lp-password-change-confirm"
                >👁</button>
              </div>
            </label>
            <p id="lp-password-change-error" class="login-page__error body" role="alert" hidden></p>
            <button id="lp-password-change-submit" class="button login-page__submit" type="submit">
              <span id="password-change-submit-label" data-i18n="passwordChangeRequiredSubmit">Update password</span>
            </button>
          </form>
        </div>
        </div>
      </div>

      <footer class="login-page__footer app-footer" role="contentinfo">
        <p class="caption">GOTXE + ❤️ + IA 🤖</p>
        <div class="footer-links">
          <a class="footer-link" href="https://github.com/GOTXE/youtube-clear-view/issues/new?template=bug_report.yml" target="_blank" rel="noreferrer">
            <span data-i18n="reportIssue">Report issue</span>
          </a>
          <a class="footer-link" href="https://github.com/GOTXE/youtube-clear-view" target="_blank" rel="noreferrer">
            <svg class="footer-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38C13.71 14.53 16 11.54 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            <span class="sr-only" data-i18n="viewOnGitHub">View project on GitHub</span>
          </a>
        </div>
      </footer>
    `;

    document.body.appendChild(overlay);
    attachEvents();
  }

  // ── i18n apply ────────────────────────────────────────────────────────────

  function applyI18n() {
    if (!overlay) return;
    overlay.querySelectorAll('[data-i18n]').forEach(node => {
      const key = node.getAttribute('data-i18n');
      const translated = t(key);
      if (translated && translated !== key) {
        node.textContent = translated;
      }
    });
    overlay.querySelectorAll('[data-i18n-aria-label]').forEach(node => {
      const key = node.getAttribute('data-i18n-aria-label');
      const translated = t(key);
      if (translated && translated !== key) {
        node.setAttribute('aria-label', translated);
      }
    });

    if (isGestorSurface()) {
      const title = overlay.querySelector('#lp-login .login-page__title');
      if (title) {
        title.textContent = t('gestorLoginTitle');
      }
      const googleButton = el('lp-google-button');
      if (googleButton) {
        googleButton.style.display = 'none';
      }
      const deviceButton = el('lp-device-button');
      if (deviceButton) {
        deviceButton.style.display = 'none';
      }
      const switchLine = overlay.querySelector('#lp-login .login-page__switch');
      if (switchLine) {
        switchLine.hidden = true;
      }
    }
  }

  // ── Auth provider buttons ─────────────────────────────────────────────────

  async function loadAuthProvider() {
    const api = getApi();
    if (!api) return;
    try {
      const resp = await api.getAuthProvider();
      if (resp.ok && resp.data) {
        authProviderData = resp.data;
        // Store CSRF token in the API client for subsequent auth requests
        if (resp.data.csrf_token && typeof api.setCsrfToken === 'function') {
          api.setCsrfToken(resp.data.csrf_token);
        }
        // If bootstrap is locked, enforce locked state now (authProviderData
        // may not have been available when showView('bootstrap') ran).
        const bw = resp.data.bootstrap_window;
        if (currentView === 'bootstrap' && bw) {
          if (bw.locked) {
            _showBootstrapLocked();
          } else if (bw.remaining_seconds > 0 && !_bootstrapCountdownTimer) {
            _startBootstrapCountdown(bw.remaining_seconds);
          }
        }
      }
    } catch (_) { /* ignore */ }
    applyAuthProviderButtons();
  }

  function applyAuthProviderButtons() {
    const googleBtn = el('lp-google-button');
    const passkeyBtn = el('lp-passkey-button');
    const deviceBtn = el('lp-device-button');
    const divider = el('lp-divider');

    const gestorSurface = isGestorSurface();
    const hasGoogle = !gestorSurface && authProviderData && authProviderData.google_login_url;
    const hasPasskeys = Boolean(
      window.ytcvPasskeys
      && typeof window.ytcvPasskeys.isSupported === 'function'
      && window.ytcvPasskeys.isSupported()
      && typeof window.ytcvPasskeys.authenticateWithPasskey === 'function'
    );
    const hasDeviceCodes = !gestorSurface && Boolean(authProviderData && authProviderData.device_pairing_enabled);

    // Google button temporarily hidden (code kept for future use)
    // Use style.display because CSS inline-flex on .login-page__alt-button
    // overrides the hidden attribute.
    if (googleBtn) googleBtn.style.display = 'none';
    if (passkeyBtn) passkeyBtn.style.display = hasPasskeys ? '' : 'none';
    if (deviceBtn) deviceBtn.style.display = hasDeviceCodes ? '' : 'none';

    const anyAlt = hasPasskeys || hasDeviceCodes;
    if (divider) divider.hidden = !anyAlt;
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  function attachEvents() {
    // Login form
    const loginForm = el('lp-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        await handleLogin();
      });
    }

    // Wizard form
    const wizardForm = el('lp-wizard-form');
    if (wizardForm) {
      wizardForm.addEventListener('submit', async e => {
        e.preventDefault();
        await handleWizardSave();
      });
    }

    const bootstrapForm = el('lp-bootstrap-form');
    if (bootstrapForm) {
      bootstrapForm.addEventListener('submit', async e => {
        e.preventDefault();
        await handleBootstrapSave();
      });
    }

    const passwordChangeForm = el('lp-password-change-form');
    if (passwordChangeForm) {
      passwordChangeForm.addEventListener('submit', async e => {
        e.preventDefault();
        await handlePasswordChangeSave();
      });
    }

    const goRegister = el('lp-go-register');
    if (goRegister) {
      goRegister.addEventListener('click', () => {
        startDeviceFlow('login');
      });
    }

    // Google (device flow)
    const googleBtn = el('lp-google-button');
    if (googleBtn) {
      googleBtn.addEventListener('click', () => {
        startDeviceFlow('login');
      });
    }

    // Passkey
    const passkeyBtn = el('lp-passkey-button');
    if (passkeyBtn) {
      passkeyBtn.addEventListener('click', async () => {
        await handlePasskeyLogin();
      });
    }

    // Device pairing
    const deviceBtn = el('lp-device-button');
    if (deviceBtn) {
      deviceBtn.addEventListener('click', () => {
        showView('pairing');
        startPairingFlow();
      });
    }

    // Device flow cancel
    const deviceFlowCancel = el('lp-device-flow-cancel');
    if (deviceFlowCancel) {
      deviceFlowCancel.addEventListener('click', () => {
        _stopDeviceFlowPoll();
        showView('login');
      });
    }

    // Device flow confirm link
    const deviceFlowConfirmYes = el('lp-device-flow-confirm-yes');
    if (deviceFlowConfirmYes) {
      deviceFlowConfirmYes.addEventListener('click', async () => {
        const data = deviceFlowConfirmYes._deviceFlowData;
        if (!data) return;

        if (data.status === 'confirm_link') {
          // Link Google to existing user via API.
          const api = getApi();
          if (!api) return;
          deviceFlowConfirmYes.disabled = true;
          const resp = await api.confirmDeviceFlowLink();
          deviceFlowConfirmYes.disabled = false;
          if (resp.ok && resp.data && resp.data.user) {
            notifyAuthSuccess(resp.data.user);
            hide();
          } else {
            setError('lp-device-flow-confirm-error', resp.error || t('deviceFlowError'));
          }
        } else if (data.status === 'new_user') {
          _deviceFlowPending = true;
          showView('wizard');
        }
      });
    }

    // Device flow confirm cancel
    const deviceFlowConfirmCancel = el('lp-device-flow-confirm-cancel');
    if (deviceFlowConfirmCancel) {
      deviceFlowConfirmCancel.addEventListener('click', () => showView('login'));
    }

    // Pairing cancel
    const pairingCancel = el('lp-pairing-cancel');
    if (pairingCancel) {
      pairingCancel.addEventListener('click', () => showView('login'));
    }

    // Pairing new code
    const pairingNew = el('lp-pairing-new');
    if (pairingNew) {
      pairingNew.addEventListener('click', () => startPairingFlow());
    }

    [
      'lp-login-password-toggle',
      'lp-wizard-password-toggle',
      'lp-wizard-password-confirm-toggle',
      'lp-bootstrap-password-toggle',
      'lp-bootstrap-password-confirm-toggle',
      'lp-password-change-new-toggle',
      'lp-password-change-confirm-toggle'
    ].forEach(buttonId => {
      const button = el(buttonId);
      if (!button) {
        return;
      }
      button.addEventListener('click', () => {
        const inputId = button.getAttribute('data-password-toggle-for');
        togglePasswordVisibility(inputId, buttonId);
      });
    });
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  async function handleLogin() {
    const username = (el('lp-login-username') || {}).value || '';
    const password = (el('lp-login-password') || {}).value || '';
    const submitBtn = el('lp-login-submit');
    const labelEl = el('login-submit-label');

    if (!username.trim()) return;

    if (submitBtn) submitBtn.disabled = true;
    if (labelEl) labelEl.textContent = t('loginSigningIn');
    setError('lp-login-error', '');

    const api = getApi();
    if (!api) return;

    const resp = isGestorSurface()
      ? await api.adminLogin(username.trim(), password)
      : await api.login(username.trim(), password);

    if (submitBtn) submitBtn.disabled = false;
    if (labelEl) labelEl.textContent = t('loginSubmit');

    if (resp.ok && resp.data) {
      if (resp.data.mfa_required) {
        window.dispatchEvent(new CustomEvent('login-page:mfa-required', { detail: resp.data }));
        return;
      }
      if (resp.data.password_change_required) {
        window.dispatchEvent(new CustomEvent('login-page:password-change-required', { detail: resp.data }));
        return;
      }
      if (resp.data.needs_setup) {
        showView('wizard', { username: resp.data.username || username });
        return;
      }
      // Successful login — auth.js will fire auth:changed
      notifyAuthSuccess(resp.data);
      return;
    }

    if (resp.status === 423) {
      setError('lp-login-error', t('loginLocked'));
      return;
    }
    setError('lp-login-error', t('loginFailed'));
  }

  async function handleWizardSave() {
    const username = (el('lp-wizard-username') || {}).value || '';
    const password = (el('lp-wizard-password') || {}).value || '';
    const passwordConfirm = (el('lp-wizard-password-confirm') || {}).value || '';
    const submitBtn = el('lp-wizard-submit');
    const labelEl = el('wizard-submit-label');

    if (!username.trim() || !password || !passwordConfirm) {
      setError('lp-wizard-error', t('setupWizardError'));
      return;
    }
    if (password !== passwordConfirm) {
      setError('lp-wizard-error', t('registerPasswordMismatch'));
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (labelEl) labelEl.textContent = t('setupWizardSaving');
    setError('lp-wizard-error', '');

    const api = getApi();
    if (!api) return;

    let resp;
    if (_deviceFlowPending) {
      resp = await api.createDeviceFlowAccount(username.trim(), password, passwordConfirm);
    } else {
      resp = await api.completeSetup(username.trim(), password);
    }

    if (submitBtn) submitBtn.disabled = false;
    if (labelEl) labelEl.textContent = t('setupWizardSave');

    if (resp.ok && resp.data) {
      _deviceFlowPending = false;
      try {
        window.sessionStorage.setItem('ytcv_onboarding_ready_modal', 'pending');
      } catch (_) { /* ignore */ }
      window.__ytcvOnboardingReadyModalPending = true;
      hide();
      window.dispatchEvent(new CustomEvent('onboarding:setup-completed'));
      const userData = resp.data.user || resp.data;
      notifyAuthSuccess(userData);
      return;
    }

    if (resp.status === 409) {
      setError('lp-wizard-error', t('registerUsernameTaken'));
      return;
    }
    setError('lp-wizard-error', resp.error || t('setupWizardError'));
  }

  function _startBootstrapCountdown(remainingSeconds) {
    _stopBootstrapCountdown();
    const countdownEl = el('lp-bootstrap-countdown');
    if (!countdownEl || remainingSeconds <= 0) {
      _showBootstrapLocked();
      return;
    }

    let remaining = remainingSeconds;
    countdownEl.hidden = false;
    const update = () => {
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      const time = `${min}:${String(sec).padStart(2, '0')}`;
      countdownEl.textContent = t('adminBootstrapCountdown').replace('{time}', time);
    };
    update();

    _bootstrapCountdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        _stopBootstrapCountdown();
        _showBootstrapLocked();
        return;
      }
      update();
    }, 1000);
  }

  function _stopBootstrapCountdown() {
    if (_bootstrapCountdownTimer) {
      window.clearInterval(_bootstrapCountdownTimer);
      _bootstrapCountdownTimer = null;
    }
  }

  function _showBootstrapLocked() {
    _stopBootstrapCountdown();
    const countdownEl = el('lp-bootstrap-countdown');
    if (countdownEl) countdownEl.hidden = true;
    const lockedEl = el('lp-bootstrap-locked-msg');
    if (lockedEl) lockedEl.hidden = false;
    // Hide everything inside the bootstrap panel except the locked message.
    // Use style.display because the hidden attribute is overridden by CSS
    // rules that set explicit display values (e.g. display:flex on the form).
    const panel = el('lp-bootstrap');
    if (panel) {
      Array.from(panel.children).forEach(child => {
        if (child.id !== 'lp-bootstrap-locked-msg') {
          child.style.display = 'none';
        }
      });
    }
  }

  async function handleBootstrapSave() {
    const username = (el('lp-bootstrap-username') || {}).value || '';
    const displayName = (el('lp-bootstrap-display-name') || {}).value || '';
    const password = (el('lp-bootstrap-password') || {}).value || '';
    const passwordConfirm = (el('lp-bootstrap-password-confirm') || {}).value || '';
    const submitBtn = el('lp-bootstrap-submit');
    const labelEl = el('bootstrap-submit-label');

    if (!username.trim() || !password || !passwordConfirm) {
      setError('lp-bootstrap-error', t('adminBootstrapError'));
      return;
    }
    if (password !== passwordConfirm) {
      setError('lp-bootstrap-error', t('registerPasswordMismatch'));
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (labelEl) labelEl.textContent = t('adminBootstrapSubmitting');
    setError('lp-bootstrap-error', '');

    const api = getApi();
    if (!api) return;

    const resp = await api.bootstrapAdmin(username.trim(), displayName.trim(), password, passwordConfirm);

    if (submitBtn) submitBtn.disabled = false;
    if (labelEl) labelEl.textContent = t('adminBootstrapSubmit');

    if (resp.ok && resp.data) {
      // Admin created in DB but NOT logged in — show the normal login page
      // so the user can create their first account via Google device flow.
      authProviderData = { ...(authProviderData || {}), bootstrap_required: false };
      await loadAuthProvider();
      showView('login');
      return;
    }

    if (resp.status === 423) {
      _showBootstrapLocked();
      return;
    }

    if (resp.status === 409) {
      authProviderData = { ...(authProviderData || {}), bootstrap_required: false };
      showView('login');
      setError('lp-login-error', t('adminBootstrapAlreadyCompleted'));
      return;
    }

    setError('lp-bootstrap-error', resp.error || t('adminBootstrapError'));
  }

  // ── Device Flow ──────────────────────────────────────────────────────────

  async function startDeviceFlow(intent) {
    _deviceFlowIntent = intent || 'login';
    showView('device-flow');
    const loadingEl = el('lp-device-flow-loading');
    const codeBox = el('lp-device-flow-code-box');
    if (loadingEl) loadingEl.hidden = false;
    if (codeBox) codeBox.hidden = true;

    const api = getApi();
    if (!api) return;

    const resp = await api.startDeviceFlow(intent || 'login');
    if (!resp.ok || !resp.data) {
      if (loadingEl) loadingEl.hidden = true;
      setError('lp-device-flow-error', resp.error || t('deviceFlowError'));
      return;
    }

    const { user_code, verification_url, qr_code, interval } = resp.data;
    if (loadingEl) loadingEl.hidden = true;
    if (codeBox) codeBox.hidden = false;

    const codeEl = el('lp-device-flow-user-code');
    if (codeEl) codeEl.textContent = user_code || '';

    const urlEl = el('lp-device-flow-url');
    if (urlEl && verification_url && verification_url.startsWith('https://')) {
      urlEl.innerHTML = '';
      const link = document.createElement('a');
      link.href = verification_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = verification_url;
      urlEl.appendChild(link);
    }

    const qrEl = el('lp-device-flow-qr');
    if (qrEl && qr_code) {
      qrEl.innerHTML = `<img src="${qr_code}" alt="QR" width="180" height="180">`;
    }

    const statusEl = el('lp-device-flow-status');
    if (statusEl) statusEl.textContent = t('deviceFlowWaiting');

    _startDeviceFlowPoll(interval || 5);
  }

  function _startDeviceFlowPoll(intervalSec) {
    _stopDeviceFlowPoll();
    const pollMs = Math.min(Math.max(intervalSec, 5), 60) * 1000;

    _deviceFlowPollTimer = window.setInterval(async () => {
      const api = getApi();
      if (!api) return;

      const resp = await api.pollDeviceFlowStatus();
      if (!resp.ok && !resp.data) {
        // Network error — keep polling.
        return;
      }

      const data = resp.data || {};

      if (data.status === 'pending') {
        if (data.slow_down) {
          // Back off: restart with longer interval.
          _startDeviceFlowPoll(intervalSec + 5);
        }
        return;
      }

      _stopDeviceFlowPoll();

      if (data.status === 'error') {
        setError('lp-device-flow-error', t('deviceFlowExpired'));
        return;
      }

      // Intent 'link': if backend already authenticated with the new tokens,
      // finish immediately; otherwise call explicit relink endpoint.
      if (_deviceFlowIntent === 'link') {
        if (data.status === 'authenticated') {
          if (data.user) {
            notifyAuthSuccess(data.user);
          }
          hide();
          return;
        }
        const api2 = getApi();
        if (api2) {
          const relinkResp = await api2.relinkDeviceFlow();
          if (relinkResp.ok) {
            hide();
            return;
          }
          setError('lp-device-flow-error', relinkResp.error || t('deviceFlowError'));
        }
        return;
      }

      if (data.status === 'authenticated') {
        notifyAuthSuccess(data.user);
        if (data.setup_completed) {
          hide();
        } else {
          showView('wizard', { username: data.user.username });
        }
        return;
      }

      if (data.status === 'confirm_link' || data.status === 'new_user') {
        _showDeviceFlowConfirm(data);
        return;
      }

      // Unexpected status — treat as error.
      setError('lp-device-flow-error', data.error || t('deviceFlowError'));
    }, pollMs);
  }

  function _stopDeviceFlowPoll() {
    if (_deviceFlowPollTimer) {
      window.clearInterval(_deviceFlowPollTimer);
      _deviceFlowPollTimer = null;
    }
  }

  function _showDeviceFlowConfirm(data) {
    showView('device-flow-confirm');
    const identity = data.google_identity || {};

    const avatarEl = el('lp-device-flow-avatar');
    if (avatarEl) {
      if (identity.picture) {
        avatarEl.src = identity.picture;
        avatarEl.hidden = false;
        avatarEl.onerror = () => { avatarEl.hidden = true; };
      } else {
        avatarEl.hidden = true;
      }
    }

    const nameEl = el('lp-device-flow-name');
    if (nameEl) nameEl.textContent = identity.name || '';

    const emailEl = el('lp-device-flow-email');
    if (emailEl) emailEl.textContent = identity.email || '';

    const msgEl = el('lp-device-flow-confirm-msg');
    if (msgEl) {
      if (data.status === 'confirm_link') {
        msgEl.textContent = t('deviceFlowConfirmLinkMsg').replace('{username}', data.existing_username || '');
        msgEl.hidden = false;
      } else {
        msgEl.hidden = true;
      }
    }

    // Store data for the confirm action.
    const confirmBtn = el('lp-device-flow-confirm-yes');
    if (confirmBtn) {
      confirmBtn._deviceFlowData = data;
    }
  }

  async function handlePasswordChangeSave() {
    const currentPassword = (el('lp-password-change-current') || {}).value || '';
    const newPassword = (el('lp-password-change-new') || {}).value || '';
    const confirmPassword = (el('lp-password-change-confirm') || {}).value || '';
    const submitBtn = el('lp-password-change-submit');
    const labelEl = el('password-change-submit-label');

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('lp-password-change-error', t('passwordChangeRequiredError'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('lp-password-change-error', t('registerPasswordMismatch'));
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (labelEl) labelEl.textContent = t('passwordChangeRequiredSubmitting');
    setError('lp-password-change-error', '');

    const api = getApi();
    if (!api) return;

    const resp = isGestorSurface()
      ? await api.adminChangePassword(currentPassword, newPassword)
      : await api.changePassword(currentPassword, newPassword);

    if (submitBtn) submitBtn.disabled = false;
    if (labelEl) labelEl.textContent = t('passwordChangeRequiredSubmit');

    if (resp.ok && resp.data) {
      notifyAuthSuccess(resp.data);
      return;
    }

    setError('lp-password-change-error', resp.error || t('passwordChangeRequiredError'));
  }

  // ── Pairing flow (device code login) ─────────────────────────────────────

  function _stopPairingPoll() {
    if (_pairingPollTimer) { clearInterval(_pairingPollTimer); _pairingPollTimer = null; }
    _pairingPublicId = null;
  }

  async function startPairingFlow() {
    _stopPairingPoll();

    const codeBox = el('lp-pairing-code-box');
    const loading = el('lp-pairing-loading');
    const newBtn = el('lp-pairing-new');
    const errEl = el('lp-pairing-error');
    const statusEl = el('lp-pairing-status');

    if (codeBox) codeBox.hidden = true;
    if (loading) loading.hidden = false;
    if (newBtn) newBtn.hidden = true;
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }

    const api = getApi();
    if (!api) return;

    const resp = await api.startPairing(null);
    if (!resp.ok || !resp.data) {
      if (loading) loading.hidden = true;
      if (errEl) { errEl.textContent = t('unableStartDeviceCode'); errEl.hidden = false; }
      if (newBtn) newBtn.hidden = false;
      return;
    }

    const { public_id, pairing_code, expires_at } = resp.data;
    _pairingPublicId = public_id;

    const codeDisplay = el('lp-pairing-code-display');
    if (codeDisplay) codeDisplay.textContent = pairing_code;
    if (statusEl) statusEl.textContent = t('pairingCodeWaiting');
    if (loading) loading.hidden = true;
    if (codeBox) codeBox.hidden = false;

    // Countdown display (mm:ss)
    const expiresMs = expires_at ? new Date(expires_at).getTime() : Date.now() + 600_000;
    const countdownId = setInterval(() => {
      if (currentView !== 'pairing') { clearInterval(countdownId); return; }
      const remaining = Math.max(0, Math.round((expiresMs - Date.now()) / 1000));
      if (statusEl) {
        if (remaining > 0) {
          const mins = Math.floor(remaining / 60);
          const secs = remaining % 60;
          const ts = `${mins}:${String(secs).padStart(2, '0')}`;
          statusEl.textContent = `${t('pairingCodeWaiting')} (${ts})`;
        } else {
          statusEl.textContent = t('unableClaimDeviceCode');
        }
      }
      if (remaining === 0) {
        clearInterval(countdownId);
        _stopPairingPoll();
        if (newBtn) newBtn.hidden = false;
      }
    }, 1000);

    // Poll for approval
    _pairingPollTimer = setInterval(async () => {
      if (!_pairingPublicId || currentView !== 'pairing') {
        _stopPairingPoll(); clearInterval(countdownId); return;
      }
      const pollResp = await api.claimPairing(_pairingPublicId);
      if (pollResp.status === 410 || pollResp.status === 409) {
        // Expired or already used
        clearInterval(countdownId);
        _stopPairingPoll();
        if (statusEl) statusEl.textContent = t('unableClaimDeviceCode');
        if (newBtn) newBtn.hidden = false;
        return;
      }
      if (!pollResp.ok) return; // network error, keep polling
      if (pollResp.data && pollResp.data.pairing_claimed) {
        clearInterval(countdownId);
        _stopPairingPoll();
        if (statusEl) statusEl.textContent = t('pairingCodeApproved');
        notifyAuthSuccess(pollResp.data);
        hide();
      }
      // status === 'pending' → keep polling
    }, 3000);
  }

  async function handlePasskeyLogin() {
    if (!window.ytcvPasskeys || typeof window.ytcvPasskeys.authenticateWithPasskey !== 'function') {
      return;
    }
    const passkeyBtnEl = el('lp-passkey-button');
    if (passkeyBtnEl) passkeyBtnEl.disabled = true;

    const passkeyApi = getApi();
    let passkeyResp = null;
    try {
      passkeyResp = await window.ytcvPasskeys.authenticateWithPasskey(passkeyApi);
    } catch (_) { /* user cancelled or error */ }

    if (passkeyBtnEl) passkeyBtnEl.disabled = false;

    if (passkeyResp && passkeyResp.ok && passkeyResp.data) {
      notifyAuthSuccess(passkeyResp.data);
      hide();
    }
  }

  // ── URL param handling ────────────────────────────────────────────────────

  function checkAuthStatusParam() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('auth_status');
    if (!status) return null;

    params.delete('auth_status');
    const newQuery = params.toString();
    const newUrl = newQuery ? `${window.location.pathname}?${newQuery}` : window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);

    return status;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    // Listen for successful auth to hide login page
    window.addEventListener('auth:changed', event => {
      const user = event.detail ? event.detail.user : null;
      if (user && visible) {
        hide();
      }
    });
    window.addEventListener('login-page:password-change-required', event => {
      if (event && event.detail) {
        show({ passwordChange: true });
      }
    });

    // Load auth provider data early (for Google button)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadAuthProvider);
    } else {
      loadAuthProvider();
    }
  }

  init();

  // ── Public API ────────────────────────────────────────────────────────────

  window.ytcvLoginPage = {
    show,
    hide,
    isVisible,
    checkAuthStatusParam,
    showView,
    releaseAuthGate,
    startDeviceFlow,
  };
})();
