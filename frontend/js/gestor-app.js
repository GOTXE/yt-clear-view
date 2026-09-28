// Dedicated manager page for admin operations.

document.addEventListener('DOMContentLoaded', async () => {
  const t = (key, vars) => (
    window.ytcvI18n && typeof window.ytcvI18n.t === 'function'
      ? window.ytcvI18n.t(key, vars)
      : key
  );

  const applyStaticI18n = () => {
    document.querySelectorAll('[data-i18n]').forEach(node => {
      const key = node.getAttribute('data-i18n');
      const translated = t(key);
      if (translated && translated !== key) {
        node.textContent = translated;
      }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
      const key = node.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated && translated !== key) {
        node.setAttribute('placeholder', translated);
      }
    });
  };

  const api = window.appApiClient || new window.APIClient(
    window.APP_CONFIG.API_BASE_URL,
    window.APP_CONFIG.REQUEST_TIMEOUT
  );
  window.appApiClient = api;

  const state = {
    user: null,
    loading: false,
    query: '',
    view: 'summary',
    summary: null,
    users: [],
    runtime: [],
    timezone: null,
    videoRefreshMode: null,
    summaryPoller: null,
    passwordPolicy: null,
    refreshSchedule: null,
    logs: {
      entries: [],
      hasMore: false,
      nextOffset: 0,
      stats: null,
      meta: null,
      live: true,
      liveTimer: null,
      filters: {
        level: '',
        search: '',
        tracking_id: ''
      }
    }
  };

  const ui = {
    status: document.getElementById('gestor-status'),
    refreshButton: document.getElementById('gestor-refresh'),
    logoutButtons: [document.getElementById('gestor-header-logout')].filter(Boolean),
    searchInput: document.getElementById('gestor-user-search'),
    searchButton: document.getElementById('gestor-user-search-button'),
    summaryGrid: document.getElementById('gestor-summary-grid'),
    timezoneContent: document.getElementById('gestor-timezone-content'),
    usersBody: document.getElementById('gestor-users-body'),
    security: document.getElementById('gestor-security-content'),
    runtime: document.getElementById('gestor-runtime-content'),
    navLinks: Array.from(document.querySelectorAll('.admin-page__nav-link')),
    sections: Array.from(document.querySelectorAll('.admin-page__section')),
    logsStats: document.getElementById('gestor-logs-stats'),
    logsLevelButtons: Array.from(document.querySelectorAll('#gestor-logs-levels .admin-page__level-chip')),
    logsSearch: document.getElementById('gestor-logs-search'),
    logsTracking: document.getElementById('gestor-logs-tracking'),
    logsLiveButton: document.getElementById('gestor-logs-live-button'),
    logsSearchButton: document.getElementById('gestor-logs-search-button'),
    logsRuntime: document.getElementById('gestor-logs-runtime'),
    logsEntries: document.getElementById('gestor-logs-entries'),
    logsErrors: document.getElementById('gestor-logs-errors'),
    logsCount: document.getElementById('gestor-logs-count'),
    logsMore: document.getElementById('gestor-logs-more')
  };

  const SUMMARY_POLL_INTERVAL_MS = 15000;

  function setStatus(message, type = 'info') {
    if (!ui.status) {
      return;
    }
    ui.status.textContent = message || '';
    ui.status.dataset.type = message ? type : '';
  }

  function applyStoredTheme() {
    // Gestor used to always force light mode, which made it look like a
    // different product from the main dark app. Match whatever theme the
    // user last chose instead (same storage key as theme-switcher.js).
    let theme = 'dark';
    try {
      const stored = localStorage.getItem('ytcv_theme');
      if (stored === 'dark' || stored === 'light') {
        theme = stored;
      }
    } catch (error) {
      // localStorage unavailable (private mode, etc.) - keep the dark default.
    }
    document.documentElement.setAttribute('data-theme', theme);
    const appRoot = document.getElementById('app');
    if (appRoot) {
      appRoot.setAttribute('data-theme', theme);
    }
  }

  function formatDate(value, timezone = null) {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    const options = timezone ? { timeZone: timezone } : undefined;
    return date.toLocaleString([], options);
  }

  function formatQuotaTimezoneLabel(timezone) {
    if (!timezone) {
      return '—';
    }
    if (timezone === 'America/Los_Angeles') {
      return t('quotaOfficialTimezoneLabel');
    }
    return timezone;
  }

  function getBrowserTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid';
    } catch (error) {
      return 'Europe/Madrid';
    }
  }

  function buildScheduleOptions(select) {
    if (!select) {
      return;
    }
    select.innerHTML = '';
    for (let hour = 0; hour < 24; hour += 1) {
      const option = document.createElement('option');
      option.value = String(hour);
      option.textContent = `${String(hour).padStart(2, '0')}:00`;
      select.appendChild(option);
    }
  }

  function getSupportedTimezones() {
    if (typeof Intl.supportedValuesOf === 'function') {
      try {
        return Intl.supportedValuesOf('timeZone');
      } catch (error) {
        return ['UTC', 'Europe/Madrid', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
      }
    }
    return ['UTC', 'Europe/Madrid', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
  }

  function makeBadge(label, tone = 'neutral') {
    const badge = document.createElement('span');
    badge.className = `admin-page__badge admin-page__badge--${tone}`;
    if (tone === 'google') {
      badge.setAttribute('aria-label', label);
      [
        ['G', 'blue'],
        ['o', 'red'],
        ['o', 'yellow'],
        ['g', 'blue'],
        ['l', 'green'],
        ['e', 'red']
      ].forEach(([letter, color]) => {
        const span = document.createElement('span');
        span.className = `admin-page__badge-letter admin-page__badge-letter--${color}`;
        span.textContent = letter;
        badge.appendChild(span);
      });
      return badge;
    }
    badge.textContent = label;
    return badge;
  }

  function getCurrentAnchor() {
    const hash = window.location.hash || '#summary';
    const clean = hash.replace(/^#/, '') || 'summary';
    return clean;
  }

  function updateVisibleSection() {
    state.view = getCurrentAnchor();
    ui.sections.forEach(section => {
      section.hidden = section.dataset.adminSection !== state.view;
    });
    if (!state.logs.filters.level && !state.logs.filters.search && !state.logs.filters.tracking_id) {
      state.logs.live = true;
    }
    syncLogsLivePolling();
  }

  function updateNavActiveState() {
    const active = getCurrentAnchor();
    ui.navLinks.forEach(link => {
      link.classList.toggle('is-active', link.dataset.adminAnchor === active);
    });
    updateVisibleSection();
  }

  function getDeviceIcon(type) {
    switch ((type || '').toLowerCase()) {
      case 'tv':
        return '📺';
      case 'tablet':
        return '📟';
      case 'mobile':
        return '📱';
      case 'desktop':
      default:
        return '🖥️';
    }
  }

  function splitLogContextBlocks(entry) {
    return String(entry || '')
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function renderSummary() {
    ui.summaryGrid.innerHTML = '';
    if (!state.summary) {
      return;
    }

    const quotaRows = [
      [t('adminQuotaUsedToday'), String(state.summary.quota_used || 0)],
      [t('adminQuotaRemainingToday'), String(state.summary.quota_remaining || 0)],
      [t('adminQuotaReservedScheduled'), String(state.summary.quota_reserved_for_scheduled || 0)],
      [
        t('adminQuotaState'),
        state.summary.quota_exhausted ? t('adminQuotaStatePaused') : t('adminQuotaStateActive')
      ],
      ...(state.summary.quota_exhausted && state.summary.quota_exhausted_until_app_timezone
        ? [[
          t('adminQuotaPausedUntil'),
          formatDate(state.summary.quota_exhausted_until_app_timezone, state.summary.quota_app_timezone)
        ]]
        : []),
      [
        t('adminQuotaResetAppTimezone'),
        formatDate(state.summary.quota_reset_at_app_timezone, state.summary.quota_app_timezone)
      ],
      [
        t('adminQuotaResetOfficial'),
        formatDate(state.summary.quota_reset_at_pt, state.summary.quota_official_timezone)
      ]
    ];

    const refreshModeValue = t(`adminSummaryRefreshModeValue${String(state.summary.video_refresh_mode || 'hybrid').replace(/[^a-z_]/gi, '')}`) || String(state.summary.video_refresh_mode || 'hybrid');

    const cards = [
      { label: t('adminSummaryUsersTotal'), value: state.summary.users_total || 0, tone: 'neutral' },
      { label: t('adminSummaryAdmins'), value: state.summary.users_admin || 0, tone: 'blue' },
      { label: t('adminSummaryChannels'), value: state.summary.channels_total || 0, tone: 'neutral' },
      { label: t('adminSummaryDevices'), value: state.summary.devices_total || 0, tone: 'neutral' },
      { label: t('adminSummaryUnclassified'), value: state.summary.channels_unclassified || 0, tone: (state.summary.channels_unclassified || 0) > 0 ? 'amber' : 'green' },
      {
        label: t('adminSummaryRefreshMode'),
        value: refreshModeValue,
        tone: 'blue'
      },
      {
        label: t('adminSummaryRssIncomplete'),
        value: state.summary.videos_rss_incomplete || 0,
        tone: (state.summary.videos_rss_incomplete || 0) > 0 ? 'amber' : 'green'
      },
      {
        label: t('adminSummaryFeedErrors'),
        value: state.summary.channels_feed_errors || 0,
        tone: (state.summary.channels_feed_errors || 0) > 0 ? 'amber' : 'green'
      },
      {
        label: t('adminSummaryQuotaUsed'),
        value: `${state.summary.quota_used || 0} / ${state.summary.quota_daily_limit || 0}`,
        tone: 'blue',
        rows: quotaRows
      }
    ];

    cards.forEach(card => {
      const article = document.createElement('article');
      article.className = `admin-page__metric-card admin-page__metric-card--${card.tone}`;

      const label = document.createElement('p');
      label.className = 'caption admin-page__metric-label';
      label.textContent = card.label;

      const value = document.createElement('p');
      value.className = 'admin-page__metric-value';
      value.textContent = String(card.value);

      article.appendChild(label);
      article.appendChild(value);

      if (Array.isArray(card.rows) && card.rows.length) {
        const rows = document.createElement('dl');
        rows.className = 'admin-page__metric-meta';
        card.rows.forEach(([rowLabel, rowValue]) => {
          const dt = document.createElement('dt');
          dt.textContent = rowLabel;
          const dd = document.createElement('dd');
          dd.textContent = rowValue;
          rows.appendChild(dt);
          rows.appendChild(dd);
        });
        article.appendChild(rows);
      }

      ui.summaryGrid.appendChild(article);
    });
  }

  function renderTimezone() {
    if (!ui.timezoneContent) {
      return;
    }
    const pendingSelectValues = Array.from(ui.timezoneContent.querySelectorAll('select')).map(node => node.value);
    const pendingTimezoneValue = pendingSelectValues[0] || null;
    const pendingModeValue = pendingSelectValues[1] || null;
    ui.timezoneContent.innerHTML = '';

    const card = document.createElement('article');
    card.className = 'admin-page__panel-card';

    const title = document.createElement('h4');
    title.className = 'heading-3';
    title.textContent = t('adminTimezoneTitle');

    const hint = document.createElement('p');
    hint.className = 'caption';
    hint.textContent = t('adminTimezoneDescription');

    const controls = document.createElement('div');
    controls.className = 'admin-page__inline-controls';

    const select = document.createElement('select');
    select.className = 'field__input field__input--compact';
    getSupportedTimezones().forEach(zone => {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone;
      select.appendChild(option);
    });
    select.value = pendingTimezoneValue || state.timezone?.timezone || state.refreshSchedule?.timezone || getBrowserTimezone();

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'admin-page__mini-btn admin-page__mini-btn--primary';
    saveButton.textContent = t('adminTimezoneApply');
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      const response = await api.updateAdminTimezone(select.value);
      saveButton.disabled = false;
      if (!response.ok || !response.data) {
        setStatus(response.error || t('adminTimezoneUpdateError'), 'error');
        return;
      }
      state.timezone = response.data;
      state.refreshSchedule = { ...(state.refreshSchedule || {}), timezone: response.data.timezone };
      renderTimezone();
      renderSecurity();
      setStatus(t('adminTimezoneUpdated'), 'success');
    });

    controls.appendChild(select);
    controls.appendChild(saveButton);
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(controls);
    ui.timezoneContent.appendChild(card);

    if (state.summary) {
      const quotaInfoCard = document.createElement('article');
      quotaInfoCard.className = 'admin-page__panel-card';

      const quotaInfoTitle = document.createElement('h4');
      quotaInfoTitle.className = 'heading-3';
      quotaInfoTitle.textContent = t('adminTimezoneQuotaInfoTitle');

      const quotaInfoText = document.createElement('p');
      quotaInfoText.className = 'caption';
      quotaInfoText.textContent = t('adminTimezoneQuotaInfoDescription', {
        appReset: formatDate(state.summary.quota_reset_at_app_timezone, state.summary.quota_app_timezone),
        appTimezone: state.summary.quota_app_timezone || select.value,
        officialReset: formatDate(state.summary.quota_reset_at_pt, state.summary.quota_official_timezone),
        officialTimezone: formatQuotaTimezoneLabel(state.summary.quota_official_timezone || 'America/Los_Angeles')
      });

      quotaInfoCard.appendChild(quotaInfoTitle);
      quotaInfoCard.appendChild(quotaInfoText);
      ui.timezoneContent.appendChild(quotaInfoCard);
    }

    const modeCard = document.createElement('article');
    modeCard.className = 'admin-page__panel-card';

    const modeTitle = document.createElement('h4');
    modeTitle.className = 'heading-3';
    modeTitle.textContent = t('adminVideoRefreshModeTitle');

    const modeHint = document.createElement('p');
    modeHint.className = 'caption';
    modeHint.textContent = t('adminVideoRefreshModeDescription');

    const modeInline = document.createElement('div');
    modeInline.className = 'admin-page__inline-controls';

    const modeSelect = document.createElement('select');
    modeSelect.className = 'field__input field__input--compact';
    const modeOptions = Array.isArray(state.videoRefreshMode?.options) ? state.videoRefreshMode.options : [];
    modeOptions.forEach(option => {
      const optionNode = document.createElement('option');
      optionNode.value = option.value;
      optionNode.textContent = t(`adminVideoRefreshModeLabel_${option.value}`);
      modeSelect.appendChild(optionNode);
    });
    modeSelect.value = pendingModeValue || state.videoRefreshMode?.video_refresh_mode || 'hybrid';

    const modeDetails = document.createElement('p');
    modeDetails.className = 'caption';
    const syncModeDetails = () => {
      const modeValue = modeSelect.value || 'hybrid';
      if (modeValue === 'rss_preferred') {
        modeDetails.innerHTML = `${escapeHtml(t('adminVideoRefreshModeHint_rss_preferred_prefix'))} <span class="admin-page__subtle-warning">${escapeHtml(t('adminVideoRefreshModeWarning_rss_preferred'))}</span>`;
        return;
      }
      modeDetails.textContent = t(`adminVideoRefreshModeHint_${modeValue}`);
    };
    syncModeDetails();
    modeSelect.addEventListener('change', syncModeDetails);

    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.className = 'admin-page__mini-btn admin-page__mini-btn--primary';
    modeButton.textContent = t('adminVideoRefreshModeApply');
    modeButton.addEventListener('click', async () => {
      const nextMode = modeSelect.value || 'hybrid';
      if (!window.confirm(t(`adminVideoRefreshModeConfirm_${nextMode}`))) {
        return;
      }
      modeButton.disabled = true;
      const response = await api.updateAdminVideoRefreshMode(nextMode);
      modeButton.disabled = false;
      if (!response.ok || !response.data) {
        setStatus(response.error || t('adminVideoRefreshModeUpdateError'), 'error');
        return;
      }
      state.videoRefreshMode = {
        ...(state.videoRefreshMode || {}),
        video_refresh_mode: response.data.video_refresh_mode,
        options: modeOptions
      };
      if (state.summary) {
        state.summary.video_refresh_mode = response.data.video_refresh_mode;
      }
      renderSummary();
      renderTimezone();
      setStatus(t('adminVideoRefreshModeUpdated'), 'success');
    });

    modeInline.appendChild(modeSelect);
    modeInline.appendChild(modeButton);
    modeCard.appendChild(modeTitle);
    modeCard.appendChild(modeHint);
    modeCard.appendChild(modeInline);
    modeCard.appendChild(modeDetails);
    ui.timezoneContent.appendChild(modeCard);
  }

  function getPasswordPolicyHint(option) {
    if (!option || !option.value) {
      return '';
    }
    return t(`adminPasswordPolicyHint_${option.value}`, {
      min: option.min_length || 0
    });
  }

  async function toggleUser(user) {
    if (user.is_active) {
      const confirmed = window.confirm(t('adminDisableUserConfirm', { user: user.display_name || user.username || `#${user.id}` }));
      if (!confirmed) {
        return;
      }
    }
    const response = user.is_active
      ? await api.disableAdminUser(user.id)
      : await api.enableAdminUser(user.id);
    if (!response.ok || !response.data) {
      setStatus(response.error || t('unableUpdateAdminUser'), 'error');
      return;
    }
    setStatus(t('adminUserUpdated'), 'success');
    await refresh(state.query);
  }

  async function resetUserPassword(user, temporaryPassword) {
    const response = await api.resetAdminUserPassword(user.id, temporaryPassword);
    if (!response.ok || !response.data) {
      setStatus(response.error || t('unableResetAdminPassword'), 'error');
      return;
    }
    setStatus(t('adminPasswordResetSuccess'), 'success');
    await refresh(state.query);
  }

  async function renameUser(user, newUsername) {
    const response = await api.updateAdminUser(user.id, { username: newUsername });
    if (!response.ok || !response.data) {
      setStatus(response.error || t('unableUpdateAdminUser'), 'error');
      return;
    }
    setStatus(t('adminUserUpdated'), 'success');
    await refresh(state.query);
  }

  async function deleteUser(user) {
    const confirmed = window.confirm(t('adminDeleteUserConfirm', { user: user.display_name || user.username || `#${user.id}` }));
    if (!confirmed) return;
    const response = await api.deleteAdminUser(user.id);
    if (!response.ok) {
      setStatus(response.error || t('unableUpdateAdminUser'), 'error');
      return;
    }
    setStatus(t('adminUserDeleted'), 'success');
    await refresh(state.query);
  }

  function renderUsers() {
    ui.usersBody.innerHTML = '';
    if (!state.users.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 9;
      cell.className = 'admin-page__table-empty';
      cell.textContent = t('adminNoUsers');
      row.appendChild(cell);
      ui.usersBody.appendChild(row);
      return;
    }

    state.users.forEach(user => {
      const row = document.createElement('tr');

      const authCell = document.createElement('td');
      const authTone = user.auth_provider === 'google' ? 'google' : 'neutral';
      authCell.appendChild(makeBadge(user.auth_provider || '—', authTone));

      const adminCell = document.createElement('td');
      adminCell.appendChild(makeBadge(user.is_admin ? t('yes') : t('no'), user.is_admin ? 'blue' : 'neutral'));

      const totpCell = document.createElement('td');
      totpCell.appendChild(makeBadge(user.totp_enabled ? t('yes') : t('no'), user.totp_enabled ? 'green' : 'neutral'));

      const activeCell = document.createElement('td');
      activeCell.appendChild(makeBadge(user.is_active ? t('yes') : t('no'), user.is_active ? 'green' : 'amber'));

      const actionsCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'admin-page__table-actions';

      const toggleButton = document.createElement('button');
      toggleButton.type = 'button';
      toggleButton.className = `admin-page__mini-btn ${user.is_active ? 'admin-page__mini-btn--danger' : 'admin-page__mini-btn--ghost'}`;
      toggleButton.textContent = user.is_active ? t('adminDisableUser') : t('adminEnableUser');
      toggleButton.addEventListener('click', async () => {
        toggleButton.disabled = true;
        await toggleUser(user);
        toggleButton.disabled = false;
      });

      const tempPasswordInput = document.createElement('input');
      tempPasswordInput.className = 'field__input admin-page__table-input';
      tempPasswordInput.type = 'text';
      tempPasswordInput.placeholder = t('adminTemporaryPasswordPlaceholder');

      const resetButton = document.createElement('button');
      resetButton.type = 'button';
      resetButton.className = 'admin-page__mini-btn admin-page__mini-btn--primary';
      resetButton.textContent = t('adminResetPassword');
      resetButton.addEventListener('click', async () => {
        const temporaryPassword = tempPasswordInput.value.trim();
        if (!temporaryPassword) {
          setStatus(t('adminTemporaryPasswordRequired'), 'error');
          tempPasswordInput.focus();
          return;
        }
        resetButton.disabled = true;
        await resetUserPassword(user, temporaryPassword);
        resetButton.disabled = false;
      });

      const renameInput = document.createElement('input');
      renameInput.className = 'field__input admin-page__table-input';
      renameInput.type = 'text';
      renameInput.placeholder = t('adminRenameUserPlaceholder');
      renameInput.value = user.username || '';

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'admin-page__mini-btn admin-page__mini-btn--ghost';
      renameButton.textContent = t('adminRenameUser');
      renameButton.addEventListener('click', async () => {
        const newUsername = renameInput.value.trim();
        if (!newUsername || newUsername === user.username) return;
        renameButton.disabled = true;
        await renameUser(user, newUsername);
        renameButton.disabled = false;
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'admin-page__mini-btn admin-page__mini-btn--danger';
      deleteButton.textContent = t('adminDeleteUser');
      deleteButton.addEventListener('click', async () => {
        deleteButton.disabled = true;
        await deleteUser(user);
        deleteButton.disabled = false;
      });

      actions.appendChild(toggleButton);
      actions.appendChild(renameInput);
      actions.appendChild(renameButton);
      actions.appendChild(tempPasswordInput);
      actions.appendChild(resetButton);
      actions.appendChild(deleteButton);
      actionsCell.appendChild(actions);

      [
        user.username || '—',
        user.display_name || '—',
        authCell,
        adminCell,
        totpCell,
        activeCell,
        formatDate(user.last_activity_at || user.session_created_at),
        String(user.device_count || 0),
        actionsCell
      ].forEach(value => {
        const cell = document.createElement('td');
        if (value instanceof HTMLElement) {
          cell.appendChild(value);
        } else {
          cell.textContent = value;
        }
        row.appendChild(cell);
      });

      ui.usersBody.appendChild(row);
    });
  }

  function renderSecurity() {
    ui.security.innerHTML = '';

    const policyCard = document.createElement('article');
    policyCard.className = 'admin-page__panel-card';
    policyCard.innerHTML = `
      <p class="caption">${t('adminPasswordPolicyDescription')}</p>
    `;

    const controls = document.createElement('div');
    controls.className = 'admin-page__inline-controls';

    const policySelect = document.createElement('select');
    policySelect.className = 'field__input';
    (state.passwordPolicy.options || []).forEach(option => {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = t(`adminPasswordPolicyLabel_${option.value}`);
      node.selected = option.value === state.passwordPolicy.password_policy;
      policySelect.appendChild(node);
    });

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'admin-page__mini-btn admin-page__mini-btn--primary';
    saveButton.textContent = t('saveSecuritySettings');
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      const response = await api.updateAdminPasswordPolicy(policySelect.value);
      saveButton.disabled = false;
      if (!response.ok || !response.data) {
        setStatus(response.error || t('unableSaveAdminPasswordPolicy'), 'error');
        return;
      }
      state.passwordPolicy = response.data;
      renderSecurity();
      setStatus(t('adminPasswordPolicyUpdated'), 'success');
    });

    controls.appendChild(policySelect);
    controls.appendChild(saveButton);
    policyCard.appendChild(controls);

    const selectedOption = (state.passwordPolicy.options || []).find(
      option => option.value === state.passwordPolicy.password_policy
    );

    const guidance = document.createElement('div');
    guidance.className = 'admin-page__policy-guidance';

    const item = document.createElement('div');
    item.className = 'admin-page__policy-item is-active';

    const title = document.createElement('p');
    title.className = 'admin-page__policy-title';
    title.textContent = selectedOption ? t(`adminPasswordPolicyLabel_${selectedOption.value}`) : '—';

    const hint = document.createElement('p');
    hint.className = 'caption admin-page__policy-hint';
    hint.textContent = getPasswordPolicyHint(selectedOption);

    item.appendChild(title);
    item.appendChild(hint);
    guidance.appendChild(item);
    policyCard.appendChild(guidance);

    policySelect.addEventListener('change', () => {
      const nextOption = (state.passwordPolicy.options || []).find(option => option.value === policySelect.value);
      title.textContent = nextOption ? t(`adminPasswordPolicyLabel_${nextOption.value}`) : '—';
      hint.textContent = getPasswordPolicyHint(nextOption);
    });

    ui.security.appendChild(policyCard);

    const scheduleCard = document.createElement('article');
    scheduleCard.className = 'admin-page__panel-card';
    scheduleCard.innerHTML = `
      <h4 class="heading-3">${t('adminRefreshScheduleTitle')}</h4>
      <p class="caption">${t('adminRefreshScheduleDescription')}</p>
    `;

    const scheduleControls = document.createElement('div');
    scheduleControls.className = 'admin-page__stack';

    const scheduleGrid = document.createElement('div');
    scheduleGrid.className = 'schedule-grid';
    scheduleGrid.setAttribute('role', 'group');
    scheduleGrid.setAttribute('aria-label', t('adminRefreshScheduleTitle'));

    const selectedHours = Array.isArray(state.refreshSchedule?.schedule_hours)
      ? state.refreshSchedule.schedule_hours
      : [7, 12, 17, 21];

    const hourSelects = Array.from({ length: 4 }, (_, index) => {
      const field = document.createElement('label');
      field.className = 'schedule-field';

      const label = document.createElement('span');
      label.className = 'caption';
      label.textContent = t('scheduleSlot', { index: index + 1 });

      const select = document.createElement('select');
      select.className = 'field__input field__input--compact';
      buildScheduleOptions(select);
      select.value = String(selectedHours[index] ?? selectedHours[selectedHours.length - 1] ?? 0);

      field.appendChild(label);
      field.appendChild(select);
      scheduleGrid.appendChild(field);
      return select;
    });

    const scheduleMeta = document.createElement('div');
    scheduleMeta.className = 'admin-page__policy-guidance';

    const scheduleInfo = document.createElement('div');
    scheduleInfo.className = 'admin-page__policy-item is-active';

    const scheduleInfoTitle = document.createElement('p');
    scheduleInfoTitle.className = 'admin-page__policy-title';
    scheduleInfoTitle.textContent = t('adminRefreshScheduleCurrent');

    const scheduleInfoHint = document.createElement('p');
    scheduleInfoHint.className = 'caption admin-page__policy-hint';
    scheduleInfoHint.textContent = state.refreshSchedule?.last_run_at
      ? t('adminRefreshScheduleLastRun', { value: formatDate(state.refreshSchedule.last_run_at) })
      : t('adminRefreshScheduleNotRunYet');

    scheduleInfo.appendChild(scheduleInfoTitle);
    scheduleInfo.appendChild(scheduleInfoHint);
    scheduleMeta.appendChild(scheduleInfo);

    const scheduleActions = document.createElement('div');
    scheduleActions.className = 'admin-page__inline-controls';

    const scheduleSaveButton = document.createElement('button');
    scheduleSaveButton.type = 'button';
    scheduleSaveButton.className = 'admin-page__mini-btn admin-page__mini-btn--primary';
    scheduleSaveButton.textContent = t('saveScheduleSettings');
    scheduleSaveButton.addEventListener('click', async () => {
      const nextHours = hourSelects
        .map(select => Number(select.value))
        .filter(hour => Number.isInteger(hour))
        .slice(0, 4);
      const timezone = state.timezone?.timezone || state.refreshSchedule?.timezone || getBrowserTimezone();
      scheduleSaveButton.disabled = true;
      const response = await api.updateAdminRefreshSchedule(nextHours, timezone);
      scheduleSaveButton.disabled = false;
      if (!response.ok || !response.data) {
        setStatus(response.error || t('unableSaveAdminRefreshSchedule'), 'error');
        return;
      }
      state.refreshSchedule = response.data;
      renderSecurity();
      setStatus(t('adminRefreshScheduleUpdated'), 'success');
    });

    scheduleActions.appendChild(scheduleSaveButton);
    scheduleControls.appendChild(scheduleGrid);
    scheduleControls.appendChild(scheduleMeta);
    scheduleControls.appendChild(scheduleActions);
    scheduleCard.appendChild(scheduleControls);

    ui.security.appendChild(scheduleCard);
  }

  function renderRuntime() {
    ui.runtime.innerHTML = '';
    if (!state.runtime.length) {
      const empty = document.createElement('article');
      empty.className = 'admin-page__panel-card';
      empty.innerHTML = `<p class="caption">${t('adminNoRuntimeUsers')}</p>`;
      ui.runtime.appendChild(empty);
      return;
    }

    state.runtime.forEach(user => {
      const card = document.createElement('article');
      card.className = 'admin-page__panel-card admin-page__runtime-card';

      const header = document.createElement('div');
      header.className = 'admin-page__runtime-header';

      const copy = document.createElement('div');
      copy.className = 'admin-page__runtime-copy';

      const title = document.createElement('h4');
      title.className = 'heading-3';
      title.textContent = user.display_name || user.username || user.email || `#${user.id}`;

      const summary = document.createElement('p');
      summary.className = 'caption';
      summary.textContent = t('adminRuntimeUserSummary', {
        devices: user.device_count || 0,
        session: user.has_active_session ? t('yes') : t('no')
      });

      const meta = document.createElement('div');
      meta.className = 'admin-page__runtime-meta';
      meta.appendChild(makeBadge(user.has_active_session ? t('adminRuntimeSessionOpen') : t('adminRuntimeSessionClosed'), user.has_active_session ? 'green' : 'neutral'));
      meta.appendChild(makeBadge(`${user.device_count || 0} ${t('adminTableDevices').toLowerCase()}`, 'blue'));

      copy.appendChild(title);
      copy.appendChild(summary);
      header.appendChild(copy);
      header.appendChild(meta);
      card.appendChild(header);

      const devices = Array.isArray(user.devices) ? user.devices : [];
      if (devices.length) {
        const list = document.createElement('div');
        list.className = 'admin-page__device-grid';
        devices.forEach(device => {
          const item = document.createElement('div');
          item.className = 'admin-page__device-card';
          item.innerHTML = `
            <div class="admin-page__device-icon" aria-hidden="true">${getDeviceIcon(device.device_type)}</div>
            <div class="admin-page__device-copy">
              <p class="admin-page__device-name">${device.display_name || device.device_identifier}</p>
              <p class="caption admin-page__device-meta">${t(`deviceType${(device.device_type || 'desktop').replace(/^./, c => c.toUpperCase())}`) || device.device_type} · ${device.frontend_mode || '—'}</p>
            </div>
          `;
          list.appendChild(item);
        });
        card.appendChild(list);
      }

      ui.runtime.appendChild(card);
    });
  }

  function renderMetaList(container, rows) {
    if (!container) {
      return;
    }
    container.innerHTML = '';
    rows.forEach(([label, value]) => {
      const cell = document.createElement('div');
      cell.className = 'admin-page__meta-cell';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      cell.appendChild(dt);
      cell.appendChild(dd);
      container.appendChild(cell);
    });
  }

  function setLevelButtonState(button, active) {
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function syncLogLevelButtons() {
    const allButton = ui.logsLevelButtons.find(button => button.dataset.level === 'ALL');
    const valueButtons = ui.logsLevelButtons.filter(button => button.dataset.level !== 'ALL');
    const activeValues = valueButtons.filter(button => button.classList.contains('is-active'));

    if (activeValues.length === 0) {
      if (allButton) {
        setLevelButtonState(allButton, true);
      }
      return;
    }

    if (activeValues.length === valueButtons.length) {
      if (allButton) {
        setLevelButtonState(allButton, true);
      }
      activeValues.forEach(button => setLevelButtonState(button, false));
      return;
    }

    if (allButton) {
      setLevelButtonState(allButton, false);
    }
  }

  function getSelectedLogLevels() {
    const allButton = ui.logsLevelButtons.find(button => button.dataset.level === 'ALL');
    if (allButton && allButton.classList.contains('is-active')) {
      return '';
    }
    return ui.logsLevelButtons
      .filter(button => button.dataset.level !== 'ALL' && button.classList.contains('is-active'))
      .map(button => button.dataset.level)
      .join(',');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
      return '—';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getLogEntryLevel(entry) {
    return ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].find(level => entry.includes(`[${level}]`)) || '';
  }

  /**
   * Parse a log line into structured parts: timestamp, level, module, message.
   * Supported formats:
   * - "[2026-03-22 19:42:44,451] [DEBUG] [-] [urllib3.connectionpool] ..."
   * - "2026-03-18 17:34:56,981 [ERROR] | module | message"
   */
  function parseLogEntry(entry) {
    const currentMatch = entry.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]\s+\[(\w+)\]\s+\[([^\]]*)\]\s+\[([^\]]+)\]\s*([\s\S]*)$/);
    if (currentMatch) {
      const tracking = currentMatch[3].trim();
      const module = currentMatch[4].trim();
      const message = currentMatch[5].trim();
      return {
        timestamp: currentMatch[1],
        level: currentMatch[2],
        module: tracking && tracking !== '-' ? `${module} · ${tracking}` : module,
        message
      };
    }

    const legacyMatch = entry.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s+\[(\w+)]\s*\|\s*([^|]+?)\s*\|\s*([\s\S]*)$/);
    if (legacyMatch) {
      return {
        timestamp: legacyMatch[1],
        level: legacyMatch[2],
        module: legacyMatch[3].trim(),
        message: legacyMatch[4].trim()
      };
    }

    return null;
  }

  function buildStructuredLogEntry(text, levelOverride) {
    const parsed = parseLogEntry(text);
    const level = (levelOverride || getLogEntryLevel(text)).toLowerCase();

    if (!parsed) {
      const line = document.createElement('div');
      line.className = `admin-page__log-entry${level ? ` admin-page__log-entry--${level}` : ''}`;
      line.textContent = text;
      return line;
    }

    const entry = document.createElement('div');
    entry.className = `admin-page__log-entry${level ? ` admin-page__log-entry--${level}` : ''}`;

    const header = document.createElement('div');
    header.className = 'admin-page__log-entry-header';

    const ts = document.createElement('time');
    ts.className = 'admin-page__log-ts';
    ts.textContent = parsed.timestamp;

    const badge = document.createElement('span');
    badge.className = `admin-page__log-badge admin-page__log-badge--${level}`;
    badge.textContent = parsed.level;

    const mod = document.createElement('span');
    mod.className = 'admin-page__log-module';
    mod.textContent = parsed.module;

    header.appendChild(ts);
    header.appendChild(badge);
    header.appendChild(mod);

    const body = document.createElement('div');
    body.className = 'admin-page__log-body';
    body.textContent = parsed.message;

    entry.appendChild(header);
    entry.appendChild(body);
    return entry;
  }

  function stopLogsLivePolling() {
    if (state.logs.liveTimer) {
      window.clearInterval(state.logs.liveTimer);
      state.logs.liveTimer = null;
    }
  }

  function syncLogsLivePolling() {
    stopLogsLivePolling();
    if (!state.logs.live) {
      return;
    }
    state.logs.liveTimer = window.setInterval(async () => {
      if (!state.logs.live) {
        stopLogsLivePolling();
        return;
      }
      await fetchLogs();
    }, 5000);
  }

  function setLogsLiveState(enabled) {
    state.logs.live = Boolean(enabled);
    if (ui.logsLiveButton) {
      ui.logsLiveButton.classList.toggle('admin-page__toolbar-btn--live-on', state.logs.live);
      ui.logsLiveButton.classList.toggle('admin-page__toolbar-btn--live-off', !state.logs.live);
      ui.logsLiveButton.setAttribute('aria-pressed', state.logs.live ? 'true' : 'false');
      ui.logsLiveButton.textContent = t('adminLogsLive');
    }
    syncLogsLivePolling();
  }

  function resetLogsFiltersToLiveDefaults() {
    state.logs.filters.level = '';
    state.logs.filters.search = '';
    state.logs.filters.tracking_id = '';
    state.logs.entries = [];
    state.logs.hasMore = false;
    state.logs.nextOffset = 0;
    if (ui.logsSearch) {
      ui.logsSearch.value = '';
    }
    if (ui.logsTracking) {
      ui.logsTracking.value = '';
    }
    const allButton = ui.logsLevelButtons.find(button => button.dataset.level === 'ALL');
    if (allButton) {
      setLevelButtonState(allButton, true);
    }
    ui.logsLevelButtons
      .filter(button => button.dataset.level !== 'ALL')
      .forEach(button => setLevelButtonState(button, false));
  }

  function renderLogs() {
    if (ui.logsStats) {
      ui.logsStats.innerHTML = '';
      const levels = state.logs.stats && state.logs.stats.levels ? state.logs.stats.levels : {};
      ['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'].forEach(level => {
        const card = document.createElement('article');
        card.className = `admin-page__logs-stat-card admin-page__logs-stat-card--${level.toLowerCase()}`;
        const label = document.createElement('p');
        label.className = 'caption';
        label.textContent = level;
        const value = document.createElement('p');
        value.className = 'admin-page__logs-stat-value';
        value.textContent = String(levels[level] ?? 0);
        card.appendChild(label);
        card.appendChild(value);
        ui.logsStats.appendChild(card);
      });
    }

    if (ui.logsRuntime) {
      const runtime = state.logs.meta && state.logs.meta.log_runtime ? state.logs.meta.log_runtime : {};
      const activeLevel = runtime.level || 'INFO';
      const configuredLevel = runtime.configured_level || activeLevel;
      const levelMismatch = activeLevel !== configuredLevel;

      const rows = [
        [t('adminLogsRuntimeLevel'), activeLevel],
        [t('adminLogsRuntimeRotate'), runtime.rotate_enabled ? t('adminLogsEnabled') : t('adminLogsDisabled')],
        [t('adminLogsRuntimeMaxFileSize'), formatBytes(runtime.max_size_bytes || 0)],
        [t('adminLogsRuntimeBackupsKept'), String(runtime.backup_count ?? 0)],
        [t('adminLogsRuntimeTimestamps'), runtime.timestamps_timezone || t('adminLogsLocalServerTime')]
      ];
      renderMetaList(ui.logsRuntime, rows);

      const levelRow = document.createElement('div');
      levelRow.className = 'admin-page__runtime-level-row';

      const levelLabel = document.createElement('span');
      levelLabel.className = 'admin-page__runtime-level-label';
      levelLabel.textContent = t('adminLogsRuntimeLevel');

      const select = document.createElement('select');
      select.className = 'field__input field__input--compact';
      ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].forEach(level => {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = level;
        select.appendChild(option);
      });
      select.value = configuredLevel;

      const applyButton = document.createElement('button');
      applyButton.type = 'button';
      applyButton.className = 'admin-page__mini-btn admin-page__mini-btn--primary';
      applyButton.textContent = t('adminLogsApplyLevel');
      applyButton.addEventListener('click', async () => {
        applyButton.disabled = true;
        const response = await api.updateAdminLogLevel(select.value);
        applyButton.disabled = false;
        if (!response.ok || !response.data) {
          setStatus(response.error || t('adminLogsLevelUpdateError'), 'error');
          return;
        }
        if (state.logs.meta && state.logs.meta.log_runtime) {
          state.logs.meta.log_runtime.level = response.data.level;
          state.logs.meta.log_runtime.configured_level = response.data.configured_level || response.data.level;
        }
        renderLogs();
        setStatus(
          response.data.restart_required ? t('adminLogsLevelUpdatedRestart') : t('adminLogsLevelUpdated'),
          response.data.restart_required ? 'warning' : 'success'
        );
      });

      levelRow.appendChild(levelLabel);
      levelRow.appendChild(select);
      levelRow.appendChild(applyButton);

      if (levelMismatch) {
        const hint = document.createElement('span');
        hint.className = 'admin-page__runtime-level-hint';
        hint.textContent = t('adminLogsRuntimeLevelMismatch') || `Active: ${activeLevel}`;
        levelRow.appendChild(hint);
      }

      const toolbar = ui.logsRuntime.closest('.admin-page__section')?.querySelector('.admin-page__logs-toolbar');
      if (toolbar) {
        const existing = toolbar.querySelector('.admin-page__runtime-level-row');
        if (existing) {
          existing.replaceWith(levelRow);
        } else {
          toolbar.appendChild(levelRow);
        }
      }
    }

    if (ui.logsEntries) {
      ui.logsEntries.innerHTML = '';
      state.logs.entries.forEach(entry => {
        const blocks = state.logs.filters.tracking_id ? splitLogContextBlocks(entry) : [entry];
        const wrapper = document.createElement('article');
        wrapper.className = 'admin-page__log-entry-group';

        blocks.forEach(block => {
          wrapper.appendChild(buildStructuredLogEntry(block));
        });

        ui.logsEntries.appendChild(wrapper);
      });
    }

    if (ui.logsErrors) {
      ui.logsErrors.innerHTML = '';
      const recentErrors = state.logs.stats && Array.isArray(state.logs.stats.recent_errors)
        ? state.logs.stats.recent_errors
        : [];
      if (recentErrors.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'admin-page__log-empty';
        empty.textContent = t('adminLogsNoRecentErrors') || 'No recent errors';
        ui.logsErrors.appendChild(empty);
      } else {
        recentErrors.forEach(entry => {
          ui.logsErrors.appendChild(buildStructuredLogEntry(entry, 'ERROR'));
        });
      }
    }

    if (ui.logsCount) {
      ui.logsCount.textContent = state.logs.live
        ? `${state.logs.entries.length} ${t('adminLogsEntriesCount')} · ${t('adminLogsLive')}`
        : `${state.logs.entries.length} ${t('adminLogsEntriesCount')} · ${t('adminLogsReview')}`;
    }
    if (ui.logsMore) {
      ui.logsMore.disabled = !state.logs.hasMore;
    }
  }

  async function fetchLogs({ append = false } = {}) {
    const params = {
      limit: 200,
      offset: append ? state.logs.nextOffset || 0 : 0,
      level: state.logs.filters.level || undefined,
      search: state.logs.filters.search || undefined,
      tracking_id: state.logs.filters.tracking_id || undefined
    };
    const [entriesResponse, statsResponse, metaResponse] = await Promise.all([
      api.getAdminLogEntries(params),
      api.getAdminLogStats(),
      api.getAdminLogsMeta()
    ]);

    if (!entriesResponse.ok || !statsResponse.ok || !metaResponse.ok) {
      setStatus(t('adminLogsLoadError'), 'error');
      return;
    }

    const nextEntries = Array.isArray(entriesResponse.data?.entries) ? entriesResponse.data.entries : [];
    state.logs.entries = append ? state.logs.entries.concat(nextEntries) : nextEntries;
    state.logs.hasMore = Boolean(entriesResponse.data?.has_more);
    state.logs.nextOffset = Number(entriesResponse.data?.next_offset || 0);
    state.logs.stats = statsResponse.data || null;
    state.logs.meta = metaResponse.data || null;
    renderLogs();
  }

  async function refreshSummaryData() {
    if (!state.user) {
      return;
    }
    const response = await api.getAdminSummary();
    if (!response.ok || !response.data) {
      return;
    }
    state.summary = response.data;
    renderSummary();
    renderTimezone();
  }

  function stopSummaryPolling() {
    if (state.summaryPoller) {
      window.clearInterval(state.summaryPoller);
      state.summaryPoller = null;
    }
  }

  function startSummaryPolling() {
    if (state.summaryPoller || !state.user) {
      return;
    }
    refreshSummaryData().catch(() => {});
    state.summaryPoller = window.setInterval(() => {
      refreshSummaryData().catch(() => {});
    }, SUMMARY_POLL_INTERVAL_MS);
  }

  function renderAll() {
    updateNavActiveState();
    renderSummary();
    renderTimezone();
    renderUsers();
    renderSecurity();
    renderRuntime();
    renderLogs();
  }

  async function refresh(query = state.query) {
    if (state.loading) {
      return;
    }

    state.loading = true;
    state.query = query;
    setStatus(t('adminPageLoading'));

    const [summaryResponse, timezoneResponse, usersResponse, runtimeResponse, passwordPolicyResponse, refreshScheduleResponse, videoRefreshModeResponse] = await Promise.all([
      api.getAdminSummary(),
      api.getAdminTimezone(),
      api.getAdminUsers(query),
      api.getAdminRuntimeState(),
      api.getAdminPasswordPolicy(),
      api.getAdminRefreshSchedule(),
      api.getAdminVideoRefreshMode()
    ]);

    state.loading = false;

    if (
      !summaryResponse.ok
      || !timezoneResponse.ok
      || !usersResponse.ok
      || !runtimeResponse.ok
      || !passwordPolicyResponse.ok
      || !refreshScheduleResponse.ok
      || !videoRefreshModeResponse.ok
    ) {
      setStatus(t('adminPageLoadError'), 'error');
      return;
    }

    state.summary = summaryResponse.data;
    state.timezone = timezoneResponse.data || null;
    state.users = Array.isArray(usersResponse.data && usersResponse.data.users) ? usersResponse.data.users : [];
    state.runtime = Array.isArray(runtimeResponse.data && runtimeResponse.data.users) ? runtimeResponse.data.users : [];
    state.passwordPolicy = passwordPolicyResponse.data || {};
    state.refreshSchedule = refreshScheduleResponse.data || {};
    state.videoRefreshMode = videoRefreshModeResponse.data || {};
    renderAll();
    startSummaryPolling();
    setStatus('');
    if (state.logs.live) {
      await fetchLogs();
    }
  }

  function showLogin(options = {}) {
    if (window.ytcvLoginPage) {
      window.ytcvLoginPage.show(options);
    }
  }

  function hideLogin() {
    if (window.ytcvLoginPage) {
      window.ytcvLoginPage.hide();
    }
  }

  async function bootstrapPage() {
    if (typeof window.initAuth !== 'function') {
      return;
    }

    await (window.ytcvI18nReady || Promise.resolve());
    applyStaticI18n();
    applyStoredTheme();
    state.user = await window.initAuth();
    const authStatus = window.ytcvLoginPage ? window.ytcvLoginPage.checkAuthStatusParam() : null;

    if (!state.user) {
      const options = authStatus === 'needs_setup' ? { wizard: true } : {};
      showLogin(options);
      return;
    }

    if (!state.user.is_admin) {
      window.location.assign('/');
      return;
    }

    applyStoredTheme();
    hideLogin();
    if (window.ytcvLoginPage && typeof window.ytcvLoginPage.releaseAuthGate === 'function') {
      window.ytcvLoginPage.releaseAuthGate();
    }
    await refresh();
  }

  ui.refreshButton.addEventListener('click', async () => {
    await refresh();
  });

  ui.logoutButtons.forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      stopSummaryPolling();
      await api.adminLogout();
      window.location.assign('/gestor/');
    });
  });

  ui.searchButton.addEventListener('click', async () => {
    await refresh(ui.searchInput.value.trim());
  });

  ui.searchInput.addEventListener('keydown', async event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await refresh(ui.searchInput.value.trim());
    }
  });

  function scrollToAdminAnchor(targetId) {
    if (targetId === '#summary') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const section = document.querySelector(targetId);
    if (!section) {
      return;
    }

    const top = Math.max(0, window.scrollY + section.getBoundingClientRect().top - 16);
    window.scrollTo({ top, behavior: 'smooth' });
  }

  ui.navLinks.forEach(link => {
    link.addEventListener('click', event => {
      const targetId = link.getAttribute('href');
      if (!targetId || !targetId.startsWith('#')) {
        return;
      }
      event.preventDefault();
      window.history.replaceState({}, document.title, `${window.location.pathname}${targetId}`);
      window.setTimeout(async () => {
        updateNavActiveState();
        scrollToAdminAnchor(targetId);
        if (targetId === '#logs') {
          await fetchLogs();
        }
      }, 0);
    });
  });

  function applyLogsSearch() {
    setLogsLiveState(false);
    state.logs.filters.level = getSelectedLogLevels();
    state.logs.filters.search = ui.logsSearch ? ui.logsSearch.value.trim() : '';
    state.logs.filters.tracking_id = ui.logsTracking ? ui.logsTracking.value.trim() : '';
    fetchLogs();
  }

  if (ui.logsSearchButton) {
    ui.logsSearchButton.addEventListener('click', applyLogsSearch);
  }

  [ui.logsSearch, ui.logsTracking].forEach(input => {
    if (input) {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          applyLogsSearch();
        }
      });
    }
  });

  ui.logsLevelButtons.forEach(button => {
    button.addEventListener('click', async () => {
      if (button.dataset.level === 'ALL') {
        ui.logsLevelButtons
          .filter(other => other.dataset.level !== 'ALL')
          .forEach(other => setLevelButtonState(other, false));
        setLevelButtonState(button, true);
      } else {
        setLevelButtonState(button, !button.classList.contains('is-active'));
        syncLogLevelButtons();
      }
      setLogsLiveState(false);
      state.logs.filters.level = getSelectedLogLevels();
      await fetchLogs();
    });
  });

  if (ui.logsLiveButton) {
    ui.logsLiveButton.addEventListener('click', async () => {
      resetLogsFiltersToLiveDefaults();
      setLogsLiveState(true);
      await fetchLogs();
    });
  }

  if (ui.logsMore) {
    ui.logsMore.addEventListener('click', async () => {
      if (!state.logs.hasMore) {
        return;
      }
      setLogsLiveState(false);
      await fetchLogs({ append: true });
    });
  }

  window.addEventListener('auth:changed', async event => {
    const user = event.detail ? event.detail.user : null;
    state.user = user;
    if (!user) {
      stopSummaryPolling();
      showLogin();
      return;
    }
    if (!user.is_admin) {
      window.location.assign('/');
      return;
    }
    applyStoredTheme();
    hideLogin();
    startSummaryPolling();
    await refresh();
  });

  window.addEventListener('auth-required', () => {
    stopSummaryPolling();
    showLogin();
  });

  window.addEventListener('hashchange', async () => {
    updateNavActiveState();
    scrollToAdminAnchor(`#${getCurrentAnchor()}`);
    if (getCurrentAnchor() === 'logs') {
      await fetchLogs();
    }
  });

  applyStoredTheme();
  setLogsLiveState(true);
  await bootstrapPage();
});
