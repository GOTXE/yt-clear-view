// Main application orchestrator for YT Clear View.

// Registro del service worker para soporte PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const hadControllerAtLoad = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;
    let userAcceptedUpdate = false;
    let updateReady = false;
    const announceUpdate = registration => {
      updateReady = true;
      window.dispatchEvent(new CustomEvent('ytcv:update-available', {
        detail: { registration }
      }));
    };
    const observeInstallingWorker = (registration, installing) => {
      if (!registration || !installing || installing.__ytcvObserved) {
        return;
      }
      installing.__ytcvObserved = true;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          announceUpdate(registration);
        }
      });
    };
    const watchRegistration = registration => {
      if (!registration) {
        return;
      }
      if (registration.waiting) {
        announceUpdate(registration);
      }
      if (registration.installing) {
        observeInstallingWorker(registration, registration.installing);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        observeInstallingWorker(registration, installing);
      });
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) {
        return;
      }
      // First service worker install also triggers controllerchange.
      // Only surface an update if there was already a controller before.
      if (!hadControllerAtLoad) {
        return;
      }
      if (!userAcceptedUpdate) {
        if (!updateReady) {
          announceUpdate(null);
        }
        return;
      }
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('/sw.js').then(registration => {
      watchRegistration(registration);
      window.addEventListener('ytcv:update-apply', () => {
        userAcceptedUpdate = true;
      });
      registration.update().catch(() => {});
      window.setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 1000);
    }).catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('app');
  if (!root) {
    return;
  }

  const t = (key, vars) => (
    window.ytcvI18n && typeof window.ytcvI18n.t === 'function'
      ? window.ytcvI18n.t(key, vars)
      : key
  );
  const markI18nReady = () => {
    document.documentElement.classList.add('i18n-ready');
  };

  if (typeof window.APP_CONFIG === 'undefined') {
    const message = document.createElement('p');
    message.className = 'body';
    message.textContent = t('missingConfig');
    root.appendChild(message);
    markI18nReady();
    return;
  }

  const api = window.appApiClient || new window.APIClient(
    window.APP_CONFIG.API_BASE_URL,
    window.APP_CONFIG.REQUEST_TIMEOUT
  );
  window.appApiClient = api;
  const initialAuthStatusFromUrl = new URLSearchParams(window.location.search).get('auth_status');
  const ONBOARDING_READY_MODAL_KEY = 'ytcv_onboarding_ready_modal';

  const state = {
    currentUser: null,
    currentDevice: null,
    channels: [],
    selectedChannelId: null,
    selectedChannelYtId: null,
    selectedCategoryId: null,
    selectedCategoryName: '',
    prefetchedThumbnails: new Set(),
    filters: {
      unwatched: false,
      month: false,
      hideShorts: false
    },
    carousels: [],
    searchActive: false,
    searchQuery: '',
    channelFilterQuery: '',
    autoImportAttempted: false,
    autoRefreshAttempted: false,
    unclassifiedMetric: {
      active: false,
      remaining: null
    },
    categoryManager: null,
    categorySelector: null,
    categoriesLoaded: false,
    settings: null,
    presets: null,
    refreshProgress: null,
    initialContentReady: false,
    autoRefreshPromise: null,
    autoRefreshKeepsLoadingState: false,
    setMenuOpen: null,
    deferAuthenticatedBootstrap: initialAuthStatusFromUrl === 'needs_setup',
    authenticatedDataBootstrapPromise: null,
    classificationActive: false,
    refreshStatusPoller: null,
    quotaPoller: null,
    refreshStatusSource: null,
    lastUpdatedTicker: null,
    showInProgressCarousel: true,
    showWatchedCarousel: false,
    mobileView: 'home'
  };

  const ui = {
    appLayout: document.getElementById('library-view'),
    appContent: document.getElementById('home-mobile-view'),
    channelsMobileView: document.getElementById('channels-mobile-view'),
    mobileSettingsView: document.getElementById('mobile-settings-view'),
    appSubtitle: document.getElementById('app-subtitle'),
    appSubtitleSecondary: document.getElementById('app-subtitle-secondary'),
    headerContext: document.getElementById('header-context'),
    headerContextMedia: document.getElementById('header-context-media'),
    headerContextImage: document.getElementById('header-context-image'),
    headerContextEyebrow: document.getElementById('header-context-eyebrow'),
    headerContextTitle: document.getElementById('header-context-title'),
    headerContextDescription: document.getElementById('header-context-description'),
    headerContextMetrics: document.getElementById('header-context-metrics'),
    subscriptionsTitle: document.getElementById('subscriptions-title'),
    filtersTitle: document.getElementById('filters-title'),
    filtersSearchLabel: document.getElementById('filters-search-label'),
    channelSidebar: document.querySelector('.channel-sidebar'),
    channelSidebarBackdrop: document.getElementById('channel-sidebar-backdrop'),
    phoneNav: document.getElementById('phone-nav'),
    phoneNavHome: document.getElementById('phone-nav-home'),
    phoneNavChannels: document.getElementById('phone-nav-channels'),
    phoneNavCategories: document.getElementById('phone-nav-categories'),
    phoneNavSettings: document.getElementById('phone-nav-settings'),
    tvActionBar: document.getElementById('tv-action-bar'),
    tvActionInProgress: document.getElementById('tv-action-in-progress'),
    tvActionWatched: document.getElementById('tv-action-watched'),
    tvRefreshProgress: document.getElementById('tv-refresh-progress'),
    themeToggle: document.getElementById('theme-toggle'),
    menuToggle: document.getElementById('menu-toggle'),
    menuPanel: document.getElementById('menu-panel'),
    menuHeadingAccount: document.getElementById('menu-heading-account'),
    menuHeadingChannels: document.getElementById('menu-heading-channels'),
    menuHeadingViewing: document.getElementById('menu-heading-viewing'),
    menuHeadingSystem: document.getElementById('menu-heading-system'),
    menuGestor: document.getElementById('menu-gestor'),
    menuFilters: document.getElementById('menu-filters'),
    menuCategoryGuide: document.getElementById('menu-category-guide'),
    menuDisplayMode: document.getElementById('menu-display-mode'),
    menuSettings: document.getElementById('menu-settings'),
    myAccountButton: document.getElementById('my-account-button'),
    logoutButton: document.getElementById('logout-button'),
    languageButtons: document.querySelectorAll('.menu-language__button'),
    mobileCategoryGuideButton: document.getElementById('mobile-category-guide-button'),
    mobileSettingsCategoryGuideButton: document.getElementById('mobile-settings-category-guide-button'),
    mobileGoogleLoginButton: document.getElementById('mobile-google-login-button'),
    mobileMyAccountButton: document.getElementById('mobile-my-account-button'),
    mobileLogoutButton: document.getElementById('mobile-logout-button'),
    mobileImportButton: document.getElementById('mobile-import-subscriptions-button'),
    mobileRefreshButton: document.getElementById('mobile-refresh-videos'),
    mobileClassifyButton: document.getElementById('mobile-classify-channels-button'),
    mobileFiltersButton: document.getElementById('mobile-filters-button'),
    mobileDisplayModeButton: document.getElementById('mobile-display-mode-button'),
    mobileThemeToggle: document.getElementById('mobile-theme-toggle'),
    mobileGestorButton: document.getElementById('mobile-gestor-button'),
    mobileSettingsTitle: document.getElementById('mobile-settings-title'),
    mobileSettingsIdentityEyebrow: document.getElementById('mobile-settings-identity-eyebrow'),
    mobileSettingsIdentityTitle: document.getElementById('mobile-settings-identity-title'),
    mobileSettingsIdentitySummary: document.getElementById('mobile-settings-identity-summary'),
    mobileSettingsStatusLabel: document.getElementById('mobile-settings-status-label'),
    mobileSettingsStatusValue: document.getElementById('mobile-settings-status-value'),
    mobileSettingsVersionLabel: document.getElementById('mobile-settings-version-label'),
    mobileSettingsVersionValue: document.getElementById('mobile-settings-version-value'),
    mobileSettingsAccountTitle: document.getElementById('mobile-settings-account-title'),
    mobileSettingsAccountCopy: document.getElementById('mobile-settings-account-copy'),
    mobileSettingsChannelsTitle: document.getElementById('mobile-settings-channels-title'),
    mobileSettingsChannelsCopy: document.getElementById('mobile-settings-channels-copy'),
    mobileSettingsViewingTitle: document.getElementById('mobile-settings-viewing-title'),
    mobileSettingsViewingCopy: document.getElementById('mobile-settings-viewing-copy'),
    mobileSettingsSystemTitle: document.getElementById('mobile-settings-system-title'),
    mobileSettingsSystemCopy: document.getElementById('mobile-settings-system-copy'),
    filterPanel: document.getElementById('filter-panel'),
    filterPanelClose: document.getElementById('filters-close'),
    filterPanelClear: document.getElementById('filters-clear'),
    guidePanel: document.getElementById('category-guide'),
    guideClose: document.getElementById('guide-close'),
    settingsModal: document.getElementById('settings-modal'),
    settingsClose: document.getElementById('settings-close'),
    settingsCancel: document.getElementById('settings-cancel'),
    settingsSave: document.getElementById('settings-save'),
    confirmModal: document.getElementById('confirm-modal'),
    confirmTitle: document.getElementById('confirm-title'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmAccept: document.getElementById('confirm-accept'),
    confirmCancel: document.getElementById('confirm-cancel'),
    confirmClose: document.getElementById('confirm-close'),
    presetRadios: document.querySelectorAll('input[name="preset"]'),
    presetTitle: document.getElementById('preset-title'),
    quotaTitle: document.getElementById('quota-title'),
    quotaStatus: document.getElementById('quota-status'),
    quotaHint: document.getElementById('quota-hint'),
    backfillStatus: document.getElementById('backfill-status'),
    inProgressCarousel: document.getElementById('in-progress-carousel'),
    inProgressSection: document.getElementById('in-progress-section'),
    inProgressCount: document.getElementById('in-progress-count'),
    inProgressLabel: document.getElementById('in-progress-label'),
    latestCarousel: document.getElementById('latest-carousel'),
    latestTitle: document.getElementById('latest-title'),
    shortsCarousel: document.getElementById('shorts-carousel'),
    olderCarousel: document.getElementById('older-carousel'),
    watchedCarousel: document.getElementById('watched-carousel'),
    shortsSection: document.getElementById('shorts-section'),
    olderSection: document.getElementById('older-section'),
    watchedSection: document.getElementById('watched-section'),
    olderTitle: document.getElementById('older-title'),
    watchedLabel: document.getElementById('watched-label'),
    watchedCount: document.getElementById('watched-count'),
    refreshButton: document.getElementById('refresh-videos'),
    importButton: document.getElementById('import-subscriptions-button'),
    refreshProgress: document.getElementById('refresh-progress'),
    updateAvailableBanner: document.getElementById('update-available-banner'),
    lastUpdatedLabel: document.getElementById('last-updated'),
    channelList: document.getElementById('channel-list'),
    channelCount: document.getElementById('channel-count'),
    channelSearchLabel: document.getElementById('channel-search-label'),
    channelSearchInput: document.getElementById('channel-search-input'),
    channelSearchClear: document.getElementById('channel-search-clear'),
    videosCount: document.getElementById('videos-count'),
    shortsCount: document.getElementById('shorts-count'),
    videosLabel: document.getElementById('videos-label'),
    shortsLabel: document.getElementById('shorts-label'),
    searchInput: document.getElementById('search-input'),
    filterUnwatched: document.getElementById('filter-unwatched'),
    filterMonth: document.getElementById('filter-month'),
    filterHideShorts: document.getElementById('filter-hide-shorts'),
    githubLabel: document.getElementById('github-label'),
    footerUpdateLink: document.getElementById('footer-update-link'),
    sessionInfo: document.querySelector('.session-info'),
    currentUserName: document.getElementById('current-user-name'),
    categoriesSection: document.getElementById('categories-section'),
    categoryCarousels: document.getElementById('category-carousels'),
    categoriesLabel: document.getElementById('categories-label'),
    categoriesDescription: document.getElementById('categories-description'),
    classifyButton: document.getElementById('classify-channels-button')
  };

  function isPhoneMode() {
    return document.documentElement.dataset.mode === 'phone';
  }

  function getSelectedCategoryChannels() {
    if (state.selectedCategoryId === null) {
      return [];
    }

    return state.channels.filter(channel => {
      const categoryId = channel
        && channel.category
        && channel.category.category
        && channel.category.category.id != null
        ? Number(channel.category.category.id)
        : null;
      return categoryId !== null && categoryId === Number(state.selectedCategoryId);
    });
  }

  function matchesSelectedCategory(channel) {
    if (state.selectedCategoryId === null) {
      return true;
    }

    const categoryId = channel
      && channel.category
      && channel.category.category
      && channel.category.category.id != null
      ? Number(channel.category.category.id)
      : null;
    return categoryId !== null && categoryId === Number(state.selectedCategoryId);
  }

  function getSelectedCategoryLabel() {
    if (state.selectedCategoryName) {
      return state.selectedCategoryName;
    }

    const firstChannel = getSelectedCategoryChannels()[0];
    if (firstChannel && firstChannel.category && firstChannel.category.category) {
      const category = firstChannel.category.category;
      return category.display_name_es || category.display_name_en || category.name || '';
    }

    return '';
  }

  function setMobileView(nextView) {
    const normalizedView = ['home', 'channels', 'categories', 'settings'].includes(nextView)
      ? nextView
      : 'home';
    state.mobileView = normalizedView;

    if (!ui.appLayout) {
      return;
    }

    const effectiveView = isPhoneMode() ? normalizedView : 'desktop';
    ui.appLayout.dataset.mobileView = effectiveView;
    document.body.dataset.mobileView = effectiveView;

    document.querySelectorAll('.mobile-home-section').forEach(section => {
      section.classList.toggle('phone-view-off', isPhoneMode() && normalizedView !== 'home');
    });

    if (ui.categoriesSection) {
      ui.categoriesSection.hidden = isPhoneMode() ? normalizedView !== 'categories' : false;
    }

    if (ui.mobileSettingsView) {
      ui.mobileSettingsView.hidden = !(isPhoneMode() && normalizedView === 'settings');
    }

    if (ui.channelsMobileView) {
      ui.channelsMobileView.hidden = isPhoneMode() ? normalizedView !== 'channels' : false;
    }

    if (ui.appContent) {
      ui.appContent.hidden = isPhoneMode() ? normalizedView === 'channels' : false;
    }

    if (isPhoneMode()) {
      window.requestAnimationFrame(() => {
        const target = normalizedView === 'channels'
          ? ui.channelsMobileView
          : normalizedView === 'categories'
            ? ui.categoriesSection
            : normalizedView === 'settings'
              ? ui.mobileSettingsView
              : ui.appContent;

        if (target && !target.hidden && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'start', inline: 'nearest' });
        } else {
          window.scrollTo({ top: 0, behavior: 'auto' });
        }
      });
    }
  }

  const swUpdateState = {
    registration: null,
    reloading: false,
    pendingBanner: false,
    presentTimerId: null,
    backendBuildId: null,
    backendVersionPoller: null,
    versionInfo: null
  };

  const AUTO_REFRESH_STALE_HOURS = 6;
  const deferredTask = callback => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => {
        callback();
      }, { timeout: 1200 });
      return;
    }

    window.setTimeout(() => {
      callback();
    }, 0);
  };

  const isVisibleForKeyboardNav = element => {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getKeyboardNavigableElements = () => (
    Array.from(document.querySelectorAll(
      [
        '.menu-toggle',
        '.menu-item:not([hidden])',
        '.filter-panel__close',
        '.filter-pill',
        '.button',
        '.channel-item',
        '.video-card',
        '.carousel-control',
        '.field__input',
        '.menu-language__button'
      ].join(', ')
    )).filter(element => !element.disabled && isVisibleForKeyboardNav(element))
  );

  const getDirectionalCandidate = (current, direction) => {
    if (!current) {
      return null;
    }

    const currentRect = current.getBoundingClientRect();
    const currentCenterX = currentRect.left + currentRect.width / 2;
    const currentCenterY = currentRect.top + currentRect.height / 2;

    const candidates = getKeyboardNavigableElements()
      .filter(element => element !== current)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2
        };
      })
      .filter(candidate => {
        if (direction === 'left') {
          return candidate.centerX < currentCenterX - 4;
        }
        if (direction === 'right') {
          return candidate.centerX > currentCenterX + 4;
        }
        if (direction === 'up') {
          return candidate.centerY < currentCenterY - 4;
        }
        if (direction === 'down') {
          return candidate.centerY > currentCenterY + 4;
        }
        return false;
      });

    if (!candidates.length) {
      return null;
    }

    candidates.sort((a, b) => {
      const primaryA = direction === 'left' || direction === 'right'
        ? Math.abs(a.centerX - currentCenterX)
        : Math.abs(a.centerY - currentCenterY);
      const primaryB = direction === 'left' || direction === 'right'
        ? Math.abs(b.centerX - currentCenterX)
        : Math.abs(b.centerY - currentCenterY);

      if (primaryA !== primaryB) {
        return primaryA - primaryB;
      }

      const secondaryA = direction === 'left' || direction === 'right'
        ? Math.abs(a.centerY - currentCenterY)
        : Math.abs(a.centerX - currentCenterX);
      const secondaryB = direction === 'left' || direction === 'right'
        ? Math.abs(b.centerY - currentCenterY)
        : Math.abs(b.centerX - currentCenterX);

      return secondaryA - secondaryB;
    });

    return candidates[0].element;
  };

  function applyLocalizedCopy() {
    if (ui.appSubtitle) {
      ui.appSubtitle.textContent = t('subtitlePrimary');
    }
    if (ui.appSubtitleSecondary) {
      ui.appSubtitleSecondary.textContent = t('subtitleSecondary');
    }
    if (ui.subscriptionsTitle) {
      ui.subscriptionsTitle.textContent = t('subscriptions');
    }
    if (ui.filtersTitle) {
      ui.filtersTitle.textContent = t('filters');
    }
    if (ui.filtersSearchLabel) {
      ui.filtersSearchLabel.textContent = t('searchLabel');
    }
    if (ui.channelSearchLabel) {
      ui.channelSearchLabel.textContent = t('searchChannelsLabel');
    }
    if (ui.searchInput) {
      ui.searchInput.placeholder = t('searchPlaceholder');
      ui.searchInput.setAttribute('aria-label', t('searchAriaLabel'));
    }
    if (ui.channelSearchInput) {
      ui.channelSearchInput.placeholder = t('searchChannelsPlaceholder');
      ui.channelSearchInput.setAttribute('aria-label', t('searchChannelsAriaLabel'));
    }
    if (ui.channelSearchClear) {
      ui.channelSearchClear.setAttribute('aria-label', t('clearChannelSearch'));
      ui.channelSearchClear.title = t('clearChannelSearch');
    }
    if (ui.refreshButton) {
      ui.refreshButton.textContent = t('refresh');
    }
    if (ui.inProgressLabel) {
      ui.inProgressLabel.textContent = t('continueWatching');
    }
    if (ui.videosLabel) {
      ui.videosLabel.textContent = t('videosRecent30Days');
    }
    if (ui.shortsLabel) {
      ui.shortsLabel.textContent = t('shortsRecent30Days');
    }
    if (ui.olderTitle) {
      ui.olderTitle.textContent = t('olderVideosShorts');
    }
    if (ui.watchedLabel) {
      ui.watchedLabel.textContent = t('watchedVideos');
    }
    if (ui.tvActionInProgress) {
      ui.tvActionInProgress.textContent = state.showInProgressCarousel
        ? t('hideContinueWatching')
        : t('showContinueWatching');
      ui.tvActionInProgress.setAttribute('aria-pressed', String(state.showInProgressCarousel));
    }
    if (ui.tvActionWatched) {
      ui.tvActionWatched.textContent = state.showWatchedCarousel
        ? t('hideWatchedVideos')
        : t('showWatchedVideos');
      ui.tvActionWatched.setAttribute('aria-pressed', String(state.showWatchedCarousel));
    }
    if (ui.menuFilters) {
      ui.menuFilters.textContent = t('filters');
    }
    if (ui.menuHeadingAccount) {
      ui.menuHeadingAccount.textContent = t('menuSectionAccount');
    }
    if (ui.menuHeadingChannels) {
      ui.menuHeadingChannels.textContent = t('menuSectionChannels');
    }
    if (ui.menuHeadingViewing) {
      ui.menuHeadingViewing.textContent = t('menuSectionViewing');
    }
    if (ui.menuHeadingSystem) {
      ui.menuHeadingSystem.textContent = t('menuSectionSystem');
    }
    if (ui.menuGestor) {
      ui.menuGestor.textContent = t('menuGestorLabel');
    }
    if (ui.menuCategoryGuide) {
      ui.menuCategoryGuide.textContent = t('categoryGuideLabel');
    }
    if (ui.menuDisplayMode) {
      ui.menuDisplayMode.textContent = t('displayModeMenuLabel');
    }
    if (ui.menuSettings) {
      ui.menuSettings.textContent = t('autoUpdatesLabel');
    }
    if (ui.myAccountButton) {
      ui.myAccountButton.textContent = t('myAccount');
    }
    if (ui.importButton) {
      ui.importButton.textContent = t('importChannels');
    }
    if (ui.classifyButton) {
      ui.classifyButton.textContent = t('classifyChannels');
    }
    updateHeaderContext();
    const googleButton = document.getElementById('google-login-button');
    if (googleButton) {
      googleButton.textContent = t('signInWithGoogle');
    }
    if (ui.filterUnwatched) {
      ui.filterUnwatched.textContent = t('unwatched');
    }
    if (ui.filterMonth) {
      ui.filterMonth.textContent = t('lastMonth');
    }
    if (ui.filterHideShorts) {
      ui.filterHideShorts.textContent = t('hideShorts');
      ui.filterHideShorts.title = t('hideShortsHint');
    }
    if (ui.filterPanelClear) {
      ui.filterPanelClear.textContent = t('clear');
    }
    if (ui.filterPanelClose) {
      ui.filterPanelClose.setAttribute('aria-label', t('close'));
    }
    if (ui.guideClose) {
      ui.guideClose.setAttribute('aria-label', t('close'));
    }
    if (ui.settingsClose) {
      ui.settingsClose.setAttribute('aria-label', t('close'));
    }
    if (ui.confirmClose) {
      ui.confirmClose.setAttribute('aria-label', t('close'));
    }
    if (ui.settingsCancel) {
      ui.settingsCancel.textContent = t('cancel');
    }
    if (ui.settingsSave) {
      ui.settingsSave.textContent = t('save');
    }
    if (ui.confirmTitle) {
      ui.confirmTitle.textContent = t('confirmTitle');
    }
    if (ui.confirmCancel) {
      ui.confirmCancel.textContent = t('cancel');
    }
    if (ui.confirmAccept) {
      ui.confirmAccept.textContent = t('confirm');
    }
    const settingsTitle = document.getElementById('settings-title');
    if (settingsTitle) {
      settingsTitle.textContent = t('autoUpdatesLabel');
    }
    if (ui.presetTitle) {
      ui.presetTitle.textContent = t('presetTitle');
    }
    if (ui.quotaTitle) {
      ui.quotaTitle.textContent = t('quotaTitle');
    }
    if (ui.quotaHint) {
      ui.quotaHint.textContent = t('quotaHint');
    }
    const presetLabels = document.querySelectorAll('[data-preset-label]');
    presetLabels.forEach(node => {
      const key = node.dataset.presetLabel;
      node.textContent = t(`presetLabel${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    });
    const presetDescs = document.querySelectorAll('[data-preset-desc]');
    presetDescs.forEach(node => {
      const key = node.dataset.presetDesc;
      node.textContent = t(`presetDesc${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    });
    if (ui.themeToggle) {
      const activeTheme = document.documentElement.getAttribute('data-theme') === 'light'
        ? 'light'
        : 'dark';
      const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
      const icon = nextTheme === 'dark' ? '🌙' : '☀️';
      const modeKey = nextTheme === 'dark' ? 'themeDark' : 'themeLight';
      const label = t('themeLabel', { mode: t(modeKey), icon });
      const labelSpan = ui.themeToggle.querySelector('.button__label');
      if (labelSpan) {
        labelSpan.textContent = label;
      } else {
        ui.themeToggle.textContent = label;
      }
    }
    if (ui.channelSidebar) {
      ui.channelSidebar.setAttribute('aria-label', t('subscriptionsAria'));
    }
    if (ui.filterPanel) {
      ui.filterPanel.setAttribute('aria-label', t('filtersAria'));
    }
    if (ui.phoneNav) {
      ui.phoneNav.setAttribute('aria-label', t('mobileNavigationLabel'));
    }
    if (ui.phoneNavHome) {
      ui.phoneNavHome.textContent = t('mobileTabHome');
    }
    if (ui.phoneNavChannels) {
      ui.phoneNavChannels.textContent = t('mobileTabChannels');
    }
    if (ui.phoneNavCategories) {
      ui.phoneNavCategories.textContent = t('mobileTabCategories');
    }
    if (ui.phoneNavSettings) {
      ui.phoneNavSettings.textContent = t('mobileTabSettings');
    }
    const tvActionBar = ui.tvActionBar;
    if (tvActionBar) {
      tvActionBar.setAttribute('aria-label', t('tvQuickActionsLabel'));
    }
    const tvChannels = document.getElementById('tv-action-channels');
    if (tvChannels) {
      tvChannels.setAttribute('aria-label', t('subscriptions'));
      tvChannels.setAttribute('title', t('subscriptions'));
    }
    const tvFilters = document.getElementById('tv-action-filters');
    if (tvFilters) {
      tvFilters.textContent = t('filters');
    }
    const sidebarClose = document.getElementById('channel-sidebar-close');
    if (sidebarClose) {
      sidebarClose.setAttribute('aria-label', t('close'));
    }
    if (ui.githubLabel) {
      ui.githubLabel.textContent = t('viewOnGitHub');
    }
    const issuesLabel = document.getElementById('issues-label');
    if (issuesLabel) {
      issuesLabel.textContent = t('reportIssue');
    }
    const currentUser = document.getElementById('current-user');
    if (currentUser) {
      currentUser.textContent = t('notSignedIn');
    }
    if (ui.sessionInfo) {
      ui.sessionInfo.classList.add('session-info--alert');
    }
    const menuToggleLabel = document.querySelector('#menu-toggle .sr-only');
    if (menuToggleLabel) {
      menuToggleLabel.textContent = t('openMenu');
    }
    if (ui.menuPanel) {
      ui.menuPanel.setAttribute('aria-label', t('menuLabel'));
    }

    const guideTitle = document.getElementById('guide-title');
    if (guideTitle) {
      guideTitle.textContent = t('categoryGuideTitle');
    }
    const guideIntro = document.getElementById('guide-intro');
    if (guideIntro) {
      guideIntro.textContent = t('categoryGuideIntro');
    }
    const guideSteps = document.getElementById('guide-steps');
    if (guideSteps) {
      const steps = [
        t('categoryGuideStep1'),
        t('categoryGuideStep2'),
        t('categoryGuideStep3'),
        t('categoryGuideStep4')
      ];
      guideSteps.innerHTML = steps.map(step => `<li>${step}</li>`).join('');
    }
    if (ui.mobileCategoryGuideButton) {
      ui.mobileCategoryGuideButton.textContent = t('categoryGuideLabel');
    }
    if (ui.mobileSettingsCategoryGuideButton) {
      ui.mobileSettingsCategoryGuideButton.textContent = t('categoryGuideLabel');
    }
    if (ui.mobileSettingsTitle) {
      ui.mobileSettingsTitle.textContent = t('mobileSettingsTitle');
    }
    if (ui.mobileSettingsIdentityEyebrow) {
      ui.mobileSettingsIdentityEyebrow.textContent = t('deviceTypeMenuLabel');
    }
    if (ui.mobileSettingsIdentityTitle) {
      ui.mobileSettingsIdentityTitle.textContent = t('mobileSettingsHeroTitle');
    }
    if (ui.mobileSettingsIdentitySummary) {
      ui.mobileSettingsIdentitySummary.textContent = t('mobileSettingsHeroGuest');
    }
    if (ui.mobileSettingsStatusLabel) {
      ui.mobileSettingsStatusLabel.textContent = t('mobileSettingsStatusLabel');
    }
    if (ui.mobileSettingsVersionLabel) {
      ui.mobileSettingsVersionLabel.textContent = t('mobileSettingsVersionLabel');
    }
    if (ui.mobileSettingsAccountTitle) {
      ui.mobileSettingsAccountTitle.textContent = t('menuSectionAccount');
    }
    if (ui.mobileSettingsAccountCopy) {
      ui.mobileSettingsAccountCopy.textContent = t('mobileSettingsAccountCopy');
    }
    if (ui.mobileSettingsChannelsTitle) {
      ui.mobileSettingsChannelsTitle.textContent = t('subscriptions');
    }
    if (ui.mobileSettingsChannelsCopy) {
      ui.mobileSettingsChannelsCopy.textContent = t('mobileSettingsChannelsCopy');
    }
    if (ui.mobileSettingsViewingTitle) {
      ui.mobileSettingsViewingTitle.textContent = t('menuSectionViewing');
    }
    if (ui.mobileSettingsViewingCopy) {
      ui.mobileSettingsViewingCopy.textContent = t('mobileSettingsViewingCopy');
    }
    if (ui.mobileSettingsSystemTitle) {
      ui.mobileSettingsSystemTitle.textContent = t('menuSectionSystem');
    }
    if (ui.mobileSettingsSystemCopy) {
      ui.mobileSettingsSystemCopy.textContent = t('mobileSettingsSystemCopy');
    }
    if (ui.mobileGoogleLoginButton) {
      ui.mobileGoogleLoginButton.textContent = t('signInWithGoogle');
    }
    if (ui.mobileMyAccountButton) {
      ui.mobileMyAccountButton.textContent = t('myAccount');
    }
    if (ui.mobileLogoutButton) {
      ui.mobileLogoutButton.textContent = t('signOut');
    }
    if (ui.mobileImportButton) {
      ui.mobileImportButton.textContent = t('importSubscriptions');
    }
    if (ui.mobileRefreshButton) {
      ui.mobileRefreshButton.textContent = t('refresh');
    }
    if (ui.mobileClassifyButton) {
      ui.mobileClassifyButton.textContent = t('classifyChannels');
    }
    if (ui.mobileFiltersButton) {
      ui.mobileFiltersButton.textContent = t('filters');
    }
    if (ui.mobileDisplayModeButton) {
      ui.mobileDisplayModeButton.textContent = t('displayModeMenuLabel');
    }
    if (ui.mobileThemeToggle) {
      ui.mobileThemeToggle.textContent = t('themeLabel', {
        mode: document.documentElement.getAttribute('data-theme') === 'light' ? t('themeLight') : t('themeDark'),
        icon: document.documentElement.getAttribute('data-theme') === 'light' ? '☀️' : '🌙'
      });
    }
    if (ui.mobileGestorButton) {
      ui.mobileGestorButton.textContent = t('menuGestorLabel');
    }

    renderQuotaSnapshot();
  }

  (window.ytcvI18nReady || Promise.resolve()).then(() => {
    applyLocalizedCopy();
    markI18nReady();
  });

  function showNotification(message, type = 'info') {
    if (typeof window.showNotification === 'function') {
      window.showNotification(message, type);
      return;
    }

    // Fallback for environments without toast utilities.
    alert(message);
  }

  function openGuide() {
    if (!ui.guidePanel) {
      return;
    }
    ui.guidePanel.hidden = false;
    if (ui.guideClose) {
      ui.guideClose.focus();
    }
  }

  function closeGuide() {
    if (!ui.guidePanel) {
      return;
    }
    ui.guidePanel.hidden = true;
  }

  function setupGuide() {
    if (!ui.guidePanel) {
      return;
    }

    const onClose = () => closeGuide();

    if (ui.guideClose) {
      ui.guideClose.addEventListener('click', onClose);
    }

    ui.guidePanel.addEventListener('click', event => {
      if (event.target === ui.guidePanel) {
        onClose();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !ui.guidePanel.hidden) {
        onClose();
      }
    });
  }

  function setupMobileSettingsView() {
    const clickProxy = (sourceButton, targetButton) => {
      if (!sourceButton || !targetButton) {
        return;
      }
      sourceButton.addEventListener('click', () => {
        targetButton.click();
      });
    };

    clickProxy(ui.mobileGoogleLoginButton, document.getElementById('google-login-button'));
    clickProxy(ui.mobileMyAccountButton, ui.myAccountButton);
    clickProxy(ui.mobileLogoutButton, ui.logoutButton);
    clickProxy(ui.mobileImportButton, ui.importButton);
    clickProxy(ui.mobileRefreshButton, ui.refreshButton);
    clickProxy(ui.mobileClassifyButton, ui.classifyButton);
    clickProxy(ui.mobileDisplayModeButton, ui.menuDisplayMode);
    clickProxy(ui.mobileThemeToggle, ui.themeToggle);

    if (ui.mobileFiltersButton) {
      ui.mobileFiltersButton.addEventListener('click', () => {
        openFilterPanel();
      });
    }

    if (ui.mobileCategoryGuideButton) {
      ui.mobileCategoryGuideButton.addEventListener('click', () => {
        openGuide();
      });
    }

    if (ui.mobileSettingsCategoryGuideButton) {
      ui.mobileSettingsCategoryGuideButton.addEventListener('click', () => {
        openGuide();
      });
    }

    if (ui.mobileGestorButton) {
      ui.mobileGestorButton.addEventListener('click', () => {
        window.open('/gestor/', '_blank', 'noopener');
      });
    }

    const syncMobileAuthActions = user => {
      if (ui.mobileMyAccountButton) {
        ui.mobileMyAccountButton.hidden = !user;
      }
      if (ui.mobileLogoutButton) {
        ui.mobileLogoutButton.hidden = !user;
      }
      if (ui.mobileGoogleLoginButton) {
        ui.mobileGoogleLoginButton.hidden = Boolean(user);
      }
      if (ui.mobileImportButton) {
        ui.mobileImportButton.hidden = !user || user.auth_provider !== 'google';
      }
      if (ui.mobileRefreshButton) {
        ui.mobileRefreshButton.hidden = !user;
      }
      if (ui.mobileClassifyButton) {
        ui.mobileClassifyButton.hidden = !user;
      }
      if (ui.mobileDisplayModeButton) {
        ui.mobileDisplayModeButton.hidden = !user || !ui.menuDisplayMode || ui.menuDisplayMode.hidden;
      }
      refreshMobileSettingsSummary(user);
    };

    syncMobileAuthActions(state.currentUser);
    window.addEventListener('auth:changed', event => {
      syncMobileAuthActions(event.detail ? event.detail.user : null);
    });
  }

  async function refreshMobileSettingsSummary(user = state.currentUser) {
    if (ui.mobileSettingsIdentitySummary) {
      ui.mobileSettingsIdentitySummary.textContent = user
        ? t('mobileSettingsHeroSignedIn', {
            name: user.display_name || user.username || t('myAccount')
          })
        : t('mobileSettingsHeroGuest');
    }
    if (ui.mobileSettingsStatusValue) {
      ui.mobileSettingsStatusValue.textContent = user
        ? (user.auth_provider === 'google' ? 'Google' : t('menuSectionAccount'))
        : t('notSignedIn');
    }

    if (!ui.mobileSettingsVersionValue) {
      return;
    }

    if (swUpdateState.backendBuildId) {
      ui.mobileSettingsVersionValue.textContent = String(swUpdateState.backendBuildId);
      return;
    }

    const versionInfo = await fetchVersionInfo();
    if (!versionInfo || !versionInfo.backend_build_id) {
      ui.mobileSettingsVersionValue.textContent = '-';
      return;
    }

    swUpdateState.backendBuildId = String(versionInfo.backend_build_id);
    ui.mobileSettingsVersionValue.textContent = swUpdateState.backendBuildId;
  }

  async function fetchVersionInfo(force = false) {
    if (!force && swUpdateState.versionInfo) {
      return swUpdateState.versionInfo;
    }

    const response = await api.getVersion();
    if (!response.ok || !response.data) {
      return null;
    }

    swUpdateState.versionInfo = response.data;
    return swUpdateState.versionInfo;
  }

  function renderFooterUpdateNotice(versionInfo) {
    if (!ui.footerUpdateLink) {
      return;
    }

    const hasUpdate = Boolean(versionInfo && versionInfo.update_available && versionInfo.latest_version);
    if (!hasUpdate) {
      ui.footerUpdateLink.hidden = true;
      return;
    }

    const href = versionInfo.changelog_url || versionInfo.latest_version_url;
    if (!href) {
      ui.footerUpdateLink.hidden = true;
      return;
    }

    ui.footerUpdateLink.textContent = `Update ${String(versionInfo.latest_version)}`;
    ui.footerUpdateLink.href = href;
    ui.footerUpdateLink.hidden = false;
  }

  async function refreshVersionUi() {
    const versionInfo = await fetchVersionInfo();
    renderFooterUpdateNotice(versionInfo);
  }

  function getTimezone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz || 'UTC';
    } catch (error) {
      return 'UTC';
    }
  }

  function formatLocalizedDateTime(value, timezone) {
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

  function renderQuotaSnapshot() {
    const quota = state.settings && state.settings.quota ? state.settings.quota : null;
    if (!quota) {
      if (ui.quotaHint) {
        ui.quotaHint.textContent = t('quotaHint');
      }
      return;
    }

    if (ui.quotaStatus) {
      if (quota.quota_exhausted && quota.quota_exhausted_until_app_timezone) {
        ui.quotaStatus.textContent = t('quotaStatusPaused', {
          used: quota.used,
          dailyLimit: quota.daily_limit,
          pausedUntil: formatLocalizedDateTime(quota.quota_exhausted_until_app_timezone, quota.app_timezone)
        });
      } else {
        ui.quotaStatus.textContent = t('quotaStatus', {
          used: quota.used,
          dailyLimit: quota.daily_limit
        });
      }
    }

    if (ui.quotaHint) {
      ui.quotaHint.textContent = t('quotaHintDetailed', {
        appReset: formatLocalizedDateTime(quota.reset_at_app_timezone, quota.app_timezone),
        appTimezone: quota.app_timezone || getTimezone(),
        officialReset: formatLocalizedDateTime(quota.reset_at_pt, quota.official_timezone),
        officialTimezone: formatQuotaTimezoneLabel(quota.official_timezone || 'America/Los_Angeles')
      });
    }
  }

  async function refreshQuotaStatus() {
    if (!state.currentUser || !api.getQuotaStatus) {
      return;
    }
    const response = await api.getQuotaStatus();
    if (!response.ok || !response.data) {
      return;
    }

    state.settings = {
      ...(state.settings || {}),
      quota: {
        ...(state.settings && state.settings.quota ? state.settings.quota : {}),
        daily_limit: response.data.daily_limit,
        cap: response.data.app_cap,
        used: response.data.used,
        remaining: response.data.remaining_app_cap,
        quota_day_pt: response.data.quota_day_pt,
        reset_at_pt: response.data.reset_at_pt,
        reset_at_app_timezone: response.data.reset_at_app_timezone,
        app_timezone: response.data.app_timezone,
        official_timezone: response.data.official_timezone,
        quota_exhausted: response.data.quota_exhausted,
        quota_exhausted_until_pt: response.data.quota_exhausted_until_pt,
        quota_exhausted_until_app_timezone: response.data.quota_exhausted_until_app_timezone
      }
    };
    renderQuotaSnapshot();
  }

  function stopQuotaPolling() {
    if (state.quotaPoller) {
      window.clearInterval(state.quotaPoller);
      state.quotaPoller = null;
    }
  }

  function startQuotaPolling() {
    if (state.quotaPoller || !state.currentUser || !api.getQuotaStatus) {
      return;
    }
    refreshQuotaStatus().catch(() => {});
    state.quotaPoller = window.setInterval(() => {
      refreshQuotaStatus().catch(() => {});
    }, 15000);
  }

  let confirmResolver = null;

  function closeConfirmModal(result) {
    if (!ui.confirmModal) {
      return;
    }
    ui.confirmModal.hidden = true;
    const resolver = confirmResolver;
    confirmResolver = null;
    if (resolver) {
      resolver(Boolean(result));
    }
  }

  function openConfirmModal(message) {
    if (!ui.confirmModal || !ui.confirmMessage) {
      return Promise.resolve(false);
    }
    ui.confirmMessage.textContent = message;
    ui.confirmModal.hidden = false;
    if (ui.confirmAccept) {
      ui.confirmAccept.focus();
    }
    return new Promise(resolve => {
      confirmResolver = resolve;
    });
  }

  function openSettingsModal() {
    if (!ui.settingsModal) {
      return;
    }
    if (state.currentUser) {
      loadSettings();
    }
    ui.settingsModal.hidden = false;
  }

  function closeSettingsModal() {
    if (!ui.settingsModal) {
      return;
    }
    ui.settingsModal.hidden = true;
  }

  function populateSettingsForm() {
    if (!state.settings) {
      return;
    }
    ui.presetRadios.forEach(radio => {
      const isActive = radio.value === state.settings.preset;
      radio.checked = isActive;
      const option = radio.closest('.preset-option');
      if (option) {
        option.classList.toggle('is-selected', isActive);
      }
    });
    renderQuotaSnapshot();
    if (ui.backfillStatus) {
      ui.backfillStatus.textContent = state.settings.backfill_active
        ? t('backfillRunning')
        : '';
    }
  }

  async function loadSettings() {
    if (!state.currentUser || !api.getSettings) {
      return;
    }
    const response = await api.getSettings();
    if (!response.ok) {
      return;
    }
    state.settings = response.data;
    state.presets = response.data.presets || {};
    populateSettingsForm();
  }

  async function saveSettings() {
    if (!state.settings || !api.updateSettings) {
      return;
    }

    const selectedPreset = Array.from(ui.presetRadios).find(radio => radio.checked);
    const nextPreset = selectedPreset ? selectedPreset.value : state.settings.preset;
    const presetChanged = nextPreset !== state.settings.preset;
    const changed = presetChanged;

    if (!changed) {
      closeSettingsModal();
      return;
    }

    if (!(await openConfirmModal(t('settingsConfirm1')))) {
      return;
    }
    if (!(await openConfirmModal(t('settingsConfirm2')))) {
      return;
    }

    const payload = {
      preset: nextPreset,
      timezone: getTimezone(),
      start_backfill: presetChanged,
      run_now: false
    };

    const response = await api.updateSettings(payload);
    if (!response.ok) {
      showNotification(response.error || t('settingsSaveFailed'), 'error');
      return;
    }
    await loadSettings();
    await loadApp();
    closeSettingsModal();
    showNotification(t('settingsSaved'), 'success');
  }

  function setupSettingsModal() {
    if (!ui.settingsModal) {
      return;
    }

    ui.presetRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        ui.presetRadios.forEach(node => {
          const option = node.closest('.preset-option');
          if (option) {
            option.classList.toggle('is-selected', node.checked);
          }
        });
      });
    });

    if (ui.settingsClose) {
      ui.settingsClose.addEventListener('click', closeSettingsModal);
    }
    if (ui.settingsCancel) {
      ui.settingsCancel.addEventListener('click', closeSettingsModal);
    }
    if (ui.settingsSave) {
      ui.settingsSave.addEventListener('click', saveSettings);
    }

    ui.settingsModal.addEventListener('click', event => {
      if (event.target === ui.settingsModal) {
        closeSettingsModal();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && ui.settingsModal && !ui.settingsModal.hidden) {
        closeSettingsModal();
      }
    });
  }

  function setupConfirmModal() {
    if (!ui.confirmModal) {
      return;
    }

    if (ui.confirmAccept) {
      ui.confirmAccept.addEventListener('click', () => closeConfirmModal(true));
    }
    if (ui.confirmCancel) {
      ui.confirmCancel.addEventListener('click', () => closeConfirmModal(false));
    }
    if (ui.confirmClose) {
      ui.confirmClose.addEventListener('click', () => closeConfirmModal(false));
    }

    ui.confirmModal.addEventListener('click', event => {
      if (event.target === ui.confirmModal) {
        closeConfirmModal(false);
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && ui.confirmModal && !ui.confirmModal.hidden) {
        closeConfirmModal(false);
      }
    });
  }

  function setLoading(show, containerId) {
    if (typeof window.loadingSpinner === 'function') {
      window.loadingSpinner(show, containerId);
    }
  }

  function isVisibleNode(node) {
    if (!node || node.hidden) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return true;
  }

  function hasUpdatePresentationBlocker() {
    if (document.body.classList.contains('player-overlay-open') || document.body.classList.contains('login-page-open')) {
      return true;
    }

    if (isVisibleNode(ui.refreshProgress) || isVisibleNode(ui.tvRefreshProgress)) {
      return true;
    }

    const blockers = document.querySelectorAll(
      '.player-overlay, .confirm-modal-overlay, .guide-modal-overlay, .settings-modal-overlay, .category-modal-overlay, .modal, #login-page'
    );

    return Array.from(blockers).some(node => isVisibleNode(node));
  }

  function stopUpdateBannerRetryLoop() {
    if (swUpdateState.presentTimerId) {
      window.clearInterval(swUpdateState.presentTimerId);
      swUpdateState.presentTimerId = null;
    }
  }

  function ensureUpdateBannerRetryLoop() {
    if (swUpdateState.presentTimerId) {
      return;
    }
    swUpdateState.presentTimerId = window.setInterval(() => {
      if (!swUpdateState.pendingBanner || swUpdateState.reloading) {
        stopUpdateBannerRetryLoop();
        return;
      }
      maybePresentUpdateAvailableBanner();
    }, 500);
  }

  function maybePresentUpdateAvailableBanner() {
    if (!ui.updateAvailableBanner) {
      return;
    }
    if (hasUpdatePresentationBlocker()) {
      ui.updateAvailableBanner.hidden = true;
      ensureUpdateBannerRetryLoop();
      return;
    }

    stopUpdateBannerRetryLoop();
    ui.updateAvailableBanner.textContent = `${t('updateAvailableReload')} ${t('updateAvailableClick')}`;
    ui.updateAvailableBanner.hidden = false;
    ui.updateAvailableBanner.disabled = false;
  }

  function showUpdateAvailableBanner(registration) {
    swUpdateState.registration = registration || swUpdateState.registration;
    swUpdateState.pendingBanner = true;
    maybePresentUpdateAvailableBanner();
  }

  async function checkBackendVersion() {
    const versionInfo = await fetchVersionInfo(true);
    renderFooterUpdateNotice(versionInfo);
    if (!versionInfo || !versionInfo.backend_build_id) {
      return;
    }

    const buildId = String(versionInfo.backend_build_id);
    if (!swUpdateState.backendBuildId) {
      swUpdateState.backendBuildId = buildId;
      return;
    }

    if (swUpdateState.backendBuildId !== buildId) {
      swUpdateState.backendBuildId = buildId;
      showUpdateAvailableBanner(null);
    }
  }

  function startBackendVersionPolling() {
    if (swUpdateState.backendVersionPoller) {
      return;
    }

    checkBackendVersion().catch(() => {});
    swUpdateState.backendVersionPoller = window.setInterval(() => {
      checkBackendVersion().catch(() => {});
    }, 60 * 1000);
  }

  async function applyUpdateAvailableBanner() {
    if (swUpdateState.reloading) {
      return;
    }
    swUpdateState.reloading = true;
    swUpdateState.pendingBanner = false;
    stopUpdateBannerRetryLoop();

    if (ui.updateAvailableBanner) {
      ui.updateAvailableBanner.disabled = true;
      ui.updateAvailableBanner.textContent = t('updateAvailableReloading');
    }

    window.dispatchEvent(new CustomEvent('ytcv:update-apply'));

    const waitingWorker = swUpdateState.registration && swUpdateState.registration.waiting
      ? swUpdateState.registration.waiting
      : null;

    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }

    window.location.reload();
  }

  function renderSectionLoadingState(container, messageKey = 'loadingContent') {
    if (!container) {
      return;
    }

    container.innerHTML = `
      <div class="section-loading" role="status" aria-live="polite">
        <span class="section-loading__text">${t(messageKey)}</span>
      </div>
    `;
  }

  function renderPrimaryLoadingStates() {
    renderSectionLoadingState(ui.latestCarousel, 'loadingVideos');
    updateShortsSectionVisibility();
    renderSectionLoadingState(ui.shortsCarousel, 'loadingShorts');
    if (ui.olderSection) {
      ui.olderSection.hidden = false;
    }
    renderSectionLoadingState(ui.olderCarousel, 'loadingOlder');
    if (ui.watchedSection) {
      ui.watchedSection.hidden = false;
    }
    renderSectionLoadingState(ui.watchedCarousel, 'loadingWatched');
  }

  function renderChannelListLoading() {
    if (!ui.channelList) {
      return;
    }
    ui.channelList.innerHTML = `
      <p class="channel-list__loading caption" role="status" aria-live="polite">
        ${t('loadingChannels')}
      </p>
    `;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function reportImportStatus(message, type = 'info') {
    if (typeof window.setAuthStatus === 'function') {
      window.setAuthStatus(message, type);
      return;
    }

    if (message) {
      showNotification(message, type);
    }
  }

  function resolveHeaderMediaUrl(media) {
    if (!media || !media.url) {
      return '';
    }
    if (/^https?:\/\//.test(media.url)) {
      return media.url;
    }
    const configuredBase = window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL
      ? window.APP_CONFIG.API_BASE_URL.replace(/\/$/, '')
      : '';
    return configuredBase ? `${configuredBase}${media.url}` : media.url;
  }

  function updateHeaderContext() {
    if (!ui.headerContext || typeof window.buildHeaderContext !== 'function') {
      return;
    }

    if (state.selectedCategoryId !== null) {
      const channelsInCategory = getSelectedCategoryChannels();
      const latest = channelsInCategory
        .map(channel => channel.last_checked_at || channel.last_refreshed_at || channel.latest_video_published_at)
        .filter(Boolean)
        .map(value => new Date(value))
        .filter(date => !Number.isNaN(date.getTime()))
        .sort((left, right) => right.getTime() - left.getTime())[0] || null;

      if (ui.headerContextEyebrow) {
        ui.headerContextEyebrow.textContent = t('mobileTabCategories');
      }
      if (ui.headerContextTitle) {
        ui.headerContextTitle.textContent = getSelectedCategoryLabel() || t('mobileTabCategories');
      }
      if (ui.headerContextDescription) {
        ui.headerContextDescription.textContent = t('mobileChannelsCount', { count: channelsInCategory.length });
      }
      if (ui.headerContextMetrics) {
        ui.headerContextMetrics.innerHTML = '';
        [
          { label: t('headerMetricSubscriptions'), value: String(channelsInCategory.length) },
          {
            label: t('headerMetricUnwatched'),
            value: String(channelsInCategory.reduce((sum, channel) => sum + Number(channel.unwatched_total || 0), 0))
          },
          {
            label: t('headerMetricRecent'),
            value: String(channelsInCategory.reduce((sum, channel) => sum + Number(channel.recent_total_30 || 0), 0))
          },
          {
            label: t('headerMetricUpdated'),
            value: latest && typeof window.timeAgo === 'function'
              ? window.timeAgo(latest.toISOString())
              : latest
                ? latest.toLocaleString()
                : t('headerMetricNone')
          }
        ].forEach(metric => {
          const wrapper = document.createElement('div');
          wrapper.className = 'header-context__metric';
          const title = document.createElement('dt');
          title.textContent = metric.label || '';
          const value = document.createElement('dd');
          value.textContent = metric.value || '';
          wrapper.appendChild(title);
          wrapper.appendChild(value);
          ui.headerContextMetrics.appendChild(wrapper);
        });
      }
      if (ui.headerContextMedia && ui.headerContextImage) {
        ui.headerContextMedia.hidden = true;
        ui.headerContextImage.removeAttribute('src');
        ui.headerContextImage.alt = '';
      }
      return;
    }

    const context = window.buildHeaderContext(
      state.channels,
      state.selectedChannelId,
      state.selectedChannelYtId,
      state.settings,
      t
    );

    if (ui.headerContextEyebrow) {
      ui.headerContextEyebrow.textContent = context.eyebrow || '';
    }
    if (ui.headerContextTitle) {
      ui.headerContextTitle.textContent = context.title || '';
    }
    if (ui.headerContextDescription) {
      ui.headerContextDescription.textContent = context.description || '';
    }

    if (ui.headerContextMetrics) {
      ui.headerContextMetrics.innerHTML = '';
      (context.metrics || []).slice(0, 4).forEach(metric => {
        const wrapper = document.createElement('div');
        wrapper.className = 'header-context__metric';
        if (metric && metric.key) {
          wrapper.dataset.metricKey = metric.key;
        }

        const title = document.createElement('dt');
        title.textContent = metric.label || '';

        const value = document.createElement('dd');
        let metricValue = metric.value || '';
        if (
          metric
          && metric.key === 'unclassified'
          && state.unclassifiedMetric.active
          && typeof state.unclassifiedMetric.remaining === 'number'
        ) {
          metricValue = String(Math.max(0, state.unclassifiedMetric.remaining));
          wrapper.classList.add('header-context__metric--updating');
        }
        value.textContent = metricValue;

        wrapper.appendChild(title);
        wrapper.appendChild(value);
        ui.headerContextMetrics.appendChild(wrapper);
      });
    }

    if (ui.headerContextMedia && ui.headerContextImage) {
      const resolvedUrl = resolveHeaderMediaUrl(context.media);
      if (resolvedUrl) {
        ui.headerContextMedia.hidden = false;
        ui.headerContextImage.src = resolvedUrl;
        ui.headerContextImage.alt = context.media.alt || '';
      } else {
        ui.headerContextMedia.hidden = true;
        ui.headerContextImage.removeAttribute('src');
        ui.headerContextImage.alt = '';
      }
    }
  }

  function setRefreshProgress(message, status = 'running') {
    state.refreshProgress = message
      ? {
          message,
          status
        }
      : null;

    if (!ui.refreshProgress && !ui.tvRefreshProgress) {
      return;
    }

    const useActionBarSlot = isVisibleNode(ui.tvActionBar);
    const primaryNode = useActionBarSlot ? ui.tvRefreshProgress : ui.refreshProgress;
    const secondaryNode = useActionBarSlot ? ui.refreshProgress : ui.tvRefreshProgress;

    if (!message) {
      [ui.refreshProgress, ui.tvRefreshProgress].forEach(node => {
        if (!node) {
          return;
        }
        node.hidden = true;
        node.textContent = '';
        node.removeAttribute('data-state');
      });
      return;
    }

    if (secondaryNode) {
      secondaryNode.hidden = true;
      secondaryNode.textContent = '';
      secondaryNode.removeAttribute('data-state');
    }
    if (!primaryNode) {
      return;
    }
    primaryNode.hidden = false;
    primaryNode.textContent = message;
    primaryNode.setAttribute('data-state', status);
  }

  function scheduleRefreshProgressClear(expectedStatus, delayMs) {
    window.setTimeout(() => {
      if (state.refreshProgress && state.refreshProgress.status === expectedStatus) {
        setRefreshProgress('');
      }
    }, delayMs);
  }

  function clearRefreshStatusPoller() {
    if (state.refreshStatusPoller) {
      window.clearInterval(state.refreshStatusPoller);
      state.refreshStatusPoller = null;
    }
  }

  async function syncRefreshStatus() {
    if (!state.currentUser) {
      state.refreshStatusSource = null;
      if (!state.classificationActive) {
        setRefreshProgress('');
      }
      return;
    }

    const response = await api.getRefreshStatus();
    if (!response.ok) {
      return;
    }

    const manualJob = response.data && response.data.job ? response.data.job : null;
    const globalJob = response.data && response.data.global_job ? response.data.global_job : null;
    const activeJob = globalJob && (globalJob.status === 'queued' || globalJob.status === 'running')
      ? globalJob
      : (manualJob && (manualJob.status === 'queued' || manualJob.status === 'running') ? manualJob : null);

    if (activeJob) {
      state.refreshStatusSource = globalJob === activeJob ? 'global' : 'manual';
      if (!state.classificationActive) {
        setRefreshProgress(t('refreshProgressRunning'));
      }
      return;
    }

    if (state.refreshStatusSource) {
      state.refreshStatusSource = null;
      if (!state.classificationActive) {
        setRefreshProgress('');
      }
    }
  }

  function startRefreshStatusPoller() {
    clearRefreshStatusPoller();
    if (!state.currentUser) {
      return;
    }
    void syncRefreshStatus();
    state.refreshStatusPoller = window.setInterval(() => {
      void syncRefreshStatus();
    }, 15000);
  }

  function updateRefreshProgressFromEvent(payload) {
    if (!payload || !payload.type) {
      return;
    }

    if (payload.type === 'job_status') {
      if (payload.status === 'queued' || payload.status === 'running') {
        setRefreshProgress(t('refreshProgressRunning'));
        return;
      }

      if (payload.status === 'completed') {
        setRefreshProgress(
          t('refreshProgressDone', { count: payload.new_videos || 0 }),
          'complete'
        );
        scheduleRefreshProgressClear('complete', 2500);
        return;
      }

      if (payload.status === 'blocked' || payload.status === 'failed') {
        setRefreshProgress(payload.message || t('refreshProgressError'), 'error');
        return;
      }
    }

    if (payload.type === 'stream_opened' || payload.type === 'start') {
      setRefreshProgress(t('refreshProgressWaiting'));
      return;
    }

    if (payload.type === 'channel_started') {
      const total = payload.total_channels || '?';
      const current = payload.current_channel || 0;
      const title = payload.channel_title || t('unknownChannel');
      setRefreshProgress(t('refreshProgressChannels', { current, total, title }));
      return;
    }

    if (payload.type === 'complete') {
      setRefreshProgress(
        t('refreshProgressDone', { count: payload.new_videos || 0 }),
        'complete'
      );
      scheduleRefreshProgressClear('complete', 2500);
      return;
    }

    if (payload.type === 'blocked') {
      const helper = window.ytcvRefreshGovernance;
      if (payload.reason === 'refresh_in_progress') {
        setRefreshProgress(
          helper ? helper.getBlockedProgressMessage(t, payload) : t('refreshProgressAlreadyRunning'),
          'warning'
        );
      } else {
        setRefreshProgress(
          helper ? helper.getBlockedProgressMessage(t, payload) : t('refreshProgressCooldown', { minutes: 1 }),
          'warning'
        );
      }
      scheduleRefreshProgressClear('warning', 4000);
    }
  }

  function streamRefresh(channelId = null, options = {}) {
    const {
      backfill = false,
      onProgress = null,
      onComplete = null,
      onError = null
    } = options;

    return new Promise(async (resolve, reject) => {
      try {
        const startResponse = await api.refreshChannels(channelId, backfill ? { backfill: true } : undefined);
        if (!startResponse.ok) {
          const helper = window.ytcvRefreshGovernance;
          const failedReason = startResponse.data && startResponse.data.reason ? startResponse.data.reason : 'unknown';
          const blockedPayload = {
            type: 'blocked',
            reason: failedReason,
            message: helper
              ? helper.getBlockedProgressMessage(t, { ...(startResponse.data || {}), reason: failedReason })
              : t('refreshProgressError')
          };
          if (blockedPayload.reason === 'refresh_in_progress') {
            setRefreshProgress(
              helper ? helper.getBlockedProgressMessage(t, blockedPayload) : t('refreshProgressAlreadyRunning'),
              'warning'
            );
          } else if (blockedPayload.reason === 'scheduled_priority') {
            setRefreshProgress(
              helper ? helper.getBlockedProgressMessage(t, blockedPayload) : t('refreshProgressScheduledPriority'),
              'warning'
            );
          } else if (blockedPayload.reason === 'global_refresh_running') {
            setRefreshProgress(
              helper ? helper.getBlockedProgressMessage(t, blockedPayload) : t('refreshProgressGlobalRunning'),
              'warning'
            );
          } else if (blockedPayload.reason === 'quota_exhausted') {
            setRefreshProgress(
              helper ? helper.getBlockedProgressMessage(t, blockedPayload) : t('refreshProgressQuotaExhausted'),
              'warning'
            );
          } else if (blockedPayload.reason === 'cooldown_active') {
            setRefreshProgress(
              helper ? helper.getBlockedProgressMessage(t, blockedPayload) : t('refreshProgressCooldown', { minutes: 1 }),
              'warning'
            );
        } else {
          setRefreshProgress(t('refreshProgressError'), 'error');
        }
        if (
          blockedPayload.reason === 'refresh_in_progress'
          || blockedPayload.reason === 'scheduled_priority'
          || blockedPayload.reason === 'global_refresh_running'
          || blockedPayload.reason === 'quota_exhausted'
          || blockedPayload.reason === 'cooldown_active'
        ) {
          scheduleRefreshProgressClear('warning', 4000);
        }
        if (typeof onComplete === 'function') {
          await onComplete(blockedPayload);
        }
          resolve(blockedPayload);
          return;
        }

        const startedJob = startResponse.data && startResponse.data.job ? startResponse.data.job : null;
        if (!startedJob) {
          setRefreshProgress(t('refreshProgressError'), 'error');
          throw new Error('Refresh job was not created');
        }

        setRefreshProgress(t('refreshProgressRunning'));
        if (typeof onProgress === 'function') {
          await onProgress({ type: 'job_status', ...startedJob });
        }

        while (true) {
          await sleep(1500);
          const statusResponse = await api.getRefreshStatus(channelId);
          if (!statusResponse.ok) {
            throw new Error(statusResponse.error || 'Refresh status failed');
          }
          const globalJob = statusResponse.data && statusResponse.data.global_job ? statusResponse.data.global_job : null;
          if (
            globalJob
            && (globalJob.status === 'queued' || globalJob.status === 'running')
            && startedJob.kind !== 'scheduled'
          ) {
            setRefreshProgress(t('refreshProgressRunning'));
          }
          const job = statusResponse.data && statusResponse.data.job ? statusResponse.data.job : null;
          if (!job || job.id !== startedJob.id) {
            continue;
          }

          if (typeof onProgress === 'function') {
            await onProgress({ type: 'job_status', ...job });
          }

          if (job.status === 'completed') {
            const completePayload = {
              type: 'complete',
              new_videos: job.new_videos || 0
            };
            if (typeof onComplete === 'function') {
              await onComplete(completePayload);
            }
            resolve(completePayload);
            return;
          }

          if (job.status === 'blocked' || job.status === 'failed') {
            const helper = window.ytcvRefreshGovernance;
            const blockedPayload = {
              type: 'blocked',
              reason: job.blocked_reason || 'unknown',
              message: job.status === 'failed'
                ? t('refreshProgressError')
                : (
                  helper
                    ? helper.getBlockedProgressMessage(t, job)
                    : t('refreshProgressError')
                )
            };
            if (typeof onComplete === 'function') {
              await onComplete(blockedPayload);
            }
            resolve(blockedPayload);
            return;
          }
        }
      } catch (error) {
        setRefreshProgress(t('refreshProgressError'), 'error');
        if (typeof onError === 'function') {
          await onError(error);
        }
        reject(error);
      }
    });
  }

  function applyFilters(payload, options = {}) {
    const {
      respectMonthFilter = true,
      includeWatched = false
    } = options;

    if (!payload || !Array.isArray(payload.videos)) {
      return payload;
    }

    const filtered = payload.videos.filter(item => {
      if (!includeWatched && item.watched) {
        return false;
      }

      if (state.filters.hideShorts) {
        const duration = item.video && item.video.duration;
        // Keep in sync with backend Config.SHORTS_MAX_DURATION_SECONDS.
        if (typeof duration === 'number' && duration <= 180) {
          return false;
        }
      }

      if (state.selectedChannelId !== null || state.selectedChannelYtId) {
        const channelId = item.channel && item.channel.id
          ? item.channel.id
          : item.video && item.video.channel_id
            ? item.video.channel_id
            : null;
        const ytChannelId = item.channel && item.channel.yt_channel_id
          ? item.channel.yt_channel_id
          : null;
        const matchesId = state.selectedChannelId !== null
          && String(channelId) === String(state.selectedChannelId);
        const matchesYt = Boolean(state.selectedChannelYtId)
          && ytChannelId
          && ytChannelId === state.selectedChannelYtId;
        if (!matchesId && !matchesYt) {
          return false;
        }
      }

      if (state.selectedCategoryId !== null) {
        const itemChannel = item.channel || state.channels.find(channel => (
          String(channel.id) === String(item.video && item.video.channel_id)
        )) || null;
        if (!matchesSelectedCategory(itemChannel)) {
          return false;
        }
      }

      if (state.filters.unwatched && item.watched) {
        return false;
      }

      const published = item.video && item.video.published_at ? new Date(item.video.published_at) : null;
      if (respectMonthFilter && published && !Number.isNaN(published.getTime())) {
        const days = Math.floor((Date.now() - published.getTime()) / (1000 * 60 * 60 * 24));
        if (state.filters.month && days > 30) {
          return false;
        }
      }

      return true;
    });

    return { ...payload, videos: filtered };
  }

  function clearCarousels(preserveDOM = false) {
    state.carousels.forEach(carousel => carousel.destroy(preserveDOM));
    state.carousels = [];

    if (!preserveDOM && ui.inProgressCarousel) {
      ui.inProgressCarousel.innerHTML = '';
    }
    if (ui.inProgressSection) {
      ui.inProgressSection.hidden = true;
    }
    if (!preserveDOM && ui.latestCarousel) {
      ui.latestCarousel.innerHTML = '';
    }
    if (!preserveDOM && ui.shortsCarousel) {
      ui.shortsCarousel.innerHTML = '';
    }
    if (!preserveDOM && ui.olderCarousel) {
      ui.olderCarousel.innerHTML = '';
    }
    if (!preserveDOM && ui.watchedCarousel) {
      ui.watchedCarousel.innerHTML = '';
    }
    if (ui.watchedSection) {
      ui.watchedSection.hidden = true;
    }
    if (!preserveDOM && ui.themeCarousels) {
      ui.themeCarousels.innerHTML = '';
    }
  }

  async function renderInProgressCarousel() {
    if (!ui.inProgressCarousel || !ui.inProgressSection) {
      return;
    }

    let totalCount = 0;
    const carousel = new window.Carousel('in-progress-carousel', async (offset, limit) => {
      const response = await api.getInProgressVideos(limit, offset);
      if (!response.ok) {
        return { videos: [], has_more: false, next_offset: null };
      }
      const data = response.data;
      if (offset === 0) {
        totalCount = data.videos.length;
      } else {
        totalCount += data.videos.length;
      }
      return data;
    }, { preserveContentOnInit: true });

    await carousel.init();
    state.carousels.push(carousel);

    if (totalCount > 0) {
      ui.inProgressSection.hidden = !state.showInProgressCarousel;
      if (ui.inProgressCount) {
        ui.inProgressCount.textContent = totalCount;
      }
    } else {
      ui.inProgressSection.hidden = true;
      if (ui.inProgressCount) {
        ui.inProgressCount.textContent = '0';
      }
    }
  }

  async function renderMainCarousel() {
    if (!ui.latestCarousel) {
      return;
    }

    const carousel = new window.Carousel('latest-carousel', async (offset, limit) => {
      const params = {
        content_type: 'video',
        since_days: 7,
        only_unwatched: state.selectedChannelId === null && !state.selectedChannelYtId
      };
      if (state.selectedChannelId !== null) {
        params.channel_id = state.selectedChannelId;
      }
      if (state.selectedChannelYtId) {
        params.yt_channel_id = state.selectedChannelYtId;
      }
      const response = await api.getLatestVideos(limit, offset, params);
      if (!response.ok) {
        return { videos: [], has_more: false, next_offset: null };
      }
      return applyFilters(response.data);
    }, { preserveContentOnInit: true });

    await carousel.init();
    state.carousels.push(carousel);
  }

  function updateShortsSectionVisibility() {
    if (ui.shortsSection) {
      ui.shortsSection.hidden = state.filters.hideShorts;
    }
  }

  async function renderShortsCarousel() {
    if (!ui.shortsCarousel) {
      return;
    }

    updateShortsSectionVisibility();
    if (state.filters.hideShorts) {
      // "Ocultar Shorts" is on: skip the fetch entirely and leave the
      // section hidden and empty instead of just hiding it visually.
      ui.shortsCarousel.innerHTML = '';
      return;
    }

    const carousel = new window.Carousel('shorts-carousel', async (offset, limit) => {
      const params = {
        content_type: 'short',
        since_days: 7,
        only_unwatched: state.selectedChannelId === null && !state.selectedChannelYtId
      };
      if (state.selectedChannelId !== null) {
        params.channel_id = state.selectedChannelId;
      }
      if (state.selectedChannelYtId) {
        params.yt_channel_id = state.selectedChannelYtId;
      }
      const response = await api.getLatestVideos(limit, offset, params);
      if (!response.ok) {
        return { videos: [], has_more: false, next_offset: null };
      }
      return applyFilters(response.data);
    }, {
      showTitle: false,
      showDescription: false,
      preserveContentOnInit: true
    });

    await carousel.init();
    state.carousels.push(carousel);
  }

  async function renderOlderCarousel() {
    if (!ui.olderCarousel) {
      return;
    }

    const carousel = new window.Carousel('older-carousel', async (offset, limit) => {
      const params = {
        older_than_days: 7,
        since_days: 30,
        randomize: true,
        only_unwatched: state.selectedChannelId === null && !state.selectedChannelYtId
      };
      if (state.filters.hideShorts) {
        // Ask the backend to exclude Shorts from this otherwise-mixed
        // "older" bucket instead of just hiding the dedicated Shorts carousel.
        params.content_type = 'video';
      }
      if (state.selectedChannelId !== null) {
        params.channel_id = state.selectedChannelId;
      }
      if (state.selectedChannelYtId) {
        params.yt_channel_id = state.selectedChannelYtId;
      }
      const response = await api.getLatestVideos(limit, offset, params);
      if (!response.ok) {
        return { videos: [], has_more: false, next_offset: null };
      }
      return applyFilters(response.data, { respectMonthFilter: false });
    }, {
      hideTextForShorts: true,
      preserveContentOnInit: true
    });

    await carousel.init();
    state.carousels.push(carousel);
  }

  async function renderWatchedCarousel() {
    if (!ui.watchedCarousel || !ui.watchedSection) {
      return;
    }

    let totalCount = 0;
    const carousel = new window.Carousel('watched-carousel', async (offset, limit) => {
      const params = {};
      if (state.filters.hideShorts) {
        params.content_type = 'video';
      }
      if (state.selectedChannelId !== null) {
        params.channel_id = state.selectedChannelId;
      }
      if (state.selectedChannelYtId) {
        params.yt_channel_id = state.selectedChannelYtId;
      }
      const response = await api.getWatchedVideos(limit, offset, params);
      if (!response.ok) {
        return { videos: [], has_more: false, next_offset: null };
      }
      const filtered = applyFilters(response.data, { includeWatched: true });
      if (offset === 0) {
        totalCount = filtered.videos.length;
      } else {
        totalCount += filtered.videos.length;
      }
      return filtered;
    }, {
      hideTextForShorts: true,
      preserveContentOnInit: true
    });

    await carousel.init();
    state.carousels.push(carousel);

    if (ui.watchedCount) {
      ui.watchedCount.textContent = String(totalCount);
    }
    ui.watchedSection.hidden = totalCount === 0 || !state.showWatchedCarousel;
  }

  function updateOptionalCarouselButtons() {
    if (ui.tvActionInProgress) {
      ui.tvActionInProgress.textContent = state.showInProgressCarousel
        ? t('hideContinueWatching')
        : t('showContinueWatching');
      ui.tvActionInProgress.setAttribute('aria-pressed', String(state.showInProgressCarousel));
    }

    if (ui.tvActionWatched) {
      ui.tvActionWatched.textContent = state.showWatchedCarousel
        ? t('hideWatchedVideos')
        : t('showWatchedVideos');
      ui.tvActionWatched.setAttribute('aria-pressed', String(state.showWatchedCarousel));
    }
  }

  async function toggleOptionalCarousel(sectionName) {
    if (sectionName === 'in_progress') {
      state.showInProgressCarousel = !state.showInProgressCarousel;
      if (state.showInProgressCarousel) {
        await refreshInProgressCarouselOnly();
      }
      if (ui.inProgressSection) {
        const hasItems = Number(ui.inProgressCount ? ui.inProgressCount.textContent || '0' : 0) > 0;
        ui.inProgressSection.hidden = !state.showInProgressCarousel || !hasItems;
      }
    }

    if (sectionName === 'watched') {
      state.showWatchedCarousel = !state.showWatchedCarousel;
      if (state.showWatchedCarousel) {
        await refreshWatchedCarouselOnly();
      }
      if (ui.watchedSection) {
        const hasItems = Number(ui.watchedCount ? ui.watchedCount.textContent || '0' : 0) > 0;
        ui.watchedSection.hidden = !state.showWatchedCarousel || !hasItems;
      }
    }

    updateOptionalCarouselButtons();
  }

  function renderChannelList(channels) {
    if (!ui.channelList) {
      return;
    }

    ui.channelList.innerHTML = '';
    syncChannelSearchUI();

    const allItem = document.createElement('div');
    allItem.className = 'channel-item';
    allItem.setAttribute('role', 'listitem');
    allItem.dataset.channelId = '';
    allItem.dataset.ytChannelId = '';
    allItem.innerHTML = `
      <div class="channel-item__thumb">${t('allChannels').toUpperCase()}</div>
      <span class="channel-item__name">${t('allChannels')}</span>
    `;
    ui.channelList.appendChild(allItem);

    const sorted = [...(channels || [])].sort((a, b) => {
      const nameA = (a.title || '').toLowerCase();
      const nameB = (b.title || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const channelMatchesFilters = channel => {
      const monthFilter = state.filters.month;
      const unwatchedFilter = state.filters.unwatched;

      const recent7 = Number(channel.recent_total_7 || 0);
      const recent7Unwatched = Number(channel.recent_unwatched_7 || 0);
      const recent30 = Number(channel.recent_total_30 || 0);
      const recent30Unwatched = Number(channel.recent_unwatched_30 || 0);
      const totalUnwatched = Number(channel.unwatched_total || 0);

      if (monthFilter) {
        return unwatchedFilter ? recent30Unwatched > 0 : recent30 > 0;
      }
      if (unwatchedFilter) {
        return recent7Unwatched > 0;
      }
      return true;
    };

    if (!sorted.length) {
      const empty = document.createElement('p');
      empty.className = 'caption';
      empty.textContent = t('noSubscriptions');
      ui.channelList.appendChild(empty);
    }

    const sidebarFiltered = sorted.length
      ? (
          typeof window.filterChannelsForSidebar === 'function'
            ? window.filterChannelsForSidebar(sorted, state.channelFilterQuery)
            : sorted
        )
      : [];
    const filtered = sidebarFiltered.length ? sidebarFiltered.filter(channelMatchesFilters) : [];

    if (sorted.length && !filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'caption';
      empty.textContent = state.channelFilterQuery
        ? t('noChannelsSearchMatch')
        : t('noChannelsMatch');
      ui.channelList.appendChild(empty);
    }

    const buildInitials = value => {
      const safe = (value || '').trim();
      if (!safe) {
        return '?';
      }
      const parts = safe.split(/\s+/).filter(Boolean);
      const initials = parts.slice(0, 2).map(part => part[0]).join('');
      return (initials || safe[0] || '?').toUpperCase();
    };

    const buildPlaceholder = channel => {
      const thumb = document.createElement('div');
      thumb.className = 'channel-item__thumb';
      thumb.textContent = buildInitials(channel.title || channel.yt_channel_id);
      return thumb;
    };

    const buildThumbnail = channel => {
      const baseUrl = window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL
        ? window.APP_CONFIG.API_BASE_URL.replace(/\/$/, '')
        : '';
      const localUrl = channel.thumbnail_local_url && baseUrl
        ? `${baseUrl}${channel.thumbnail_local_url}`
        : null;
      const sourceUrl = localUrl || channel.thumbnail_url;

      if (!sourceUrl) {
        return buildPlaceholder(channel);
      }

      const thumb = document.createElement('div');
      thumb.className = 'channel-item__thumb';

      const img = document.createElement('img');
      img.className = 'channel-item__thumb-image';
      img.src = sourceUrl;
      img.alt = channel.title || t('channelThumbnailAlt');
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        const placeholder = buildPlaceholder(channel);
        thumb.replaceWith(placeholder);
      });

      thumb.appendChild(img);
      return thumb;
    };

    const getChannelRecencyLabel = channel => {
      const timestamp = channel.last_video_published_at
        || channel.latest_video_published_at
        || channel.last_checked_at
        || channel.last_refreshed_at
        || null;

      if (!timestamp) {
        return t('mobileChannelNoRecentVideo');
      }

      if (typeof window.timeAgo === 'function') {
        return window.timeAgo(timestamp);
      }

      const parsed = new Date(timestamp);
      if (Number.isNaN(parsed.getTime())) {
        return t('mobileChannelNoRecentVideo');
      }

      return parsed.toLocaleDateString();
    };

    filtered.forEach(channel => {
      const item = document.createElement('div');
      item.className = 'channel-item';
      item.setAttribute('role', 'listitem');
      item.dataset.channelId = String(channel.id);
      item.dataset.ytChannelId = channel.yt_channel_id || '';

      item.appendChild(buildThumbnail(channel));

      const content = document.createElement('div');
      content.className = 'channel-item__content';

      const name = document.createElement('span');
      name.className = 'channel-item__name';
      name.textContent = channel.title || channel.yt_channel_id || t('unknownChannel');
      content.appendChild(name);

      const recency = document.createElement('span');
      recency.className = 'channel-item__recency';
      recency.textContent = getChannelRecencyLabel(channel);
      content.appendChild(recency);

      item.appendChild(content);

      const meta = document.createElement('div');
      meta.className = 'channel-item__meta';

      if (typeof window.createCategoryBadge === 'function') {
        const categoryData = channel.category && channel.category.category
          ? channel.category.category
          : null;
        const badge = window.createCategoryBadge(categoryData, () => {
          if (!state.categorySelector) {
            return;
          }
          state.categorySelector.open(
            channel.id,
            channel.title,
            categoryData ? categoryData.id : null
          );
        });
        badge.classList.add('channel-item__category');
        meta.appendChild(badge);
      }

      const status = document.createElement('span');
      status.className = 'channel-item__status';
      if (Number(channel.recent_total_7 || 0) > 0) {
        status.classList.add('is-active');
      }
      status.setAttribute('aria-hidden', 'true');
      meta.appendChild(status);

      const chevron = document.createElement('span');
      chevron.className = 'channel-item__chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';
      meta.appendChild(chevron);

      item.appendChild(meta);

      ui.channelList.appendChild(item);
    });

    ui.channelList.querySelectorAll('.channel-item').forEach(item => {
      const id = item.dataset.channelId || null;
      const ytId = item.dataset.ytChannelId || null;
      const isAllSelected = state.selectedChannelId === null && !state.selectedChannelYtId;
      const matchesId = state.selectedChannelId !== null && String(state.selectedChannelId) === id;
      const matchesYt = state.selectedChannelYtId && ytId === state.selectedChannelYtId;
      if ((isAllSelected && !id) || matchesId || matchesYt) {
        item.classList.add('is-active');
      }
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-pressed', item.classList.contains('is-active') ? 'true' : 'false');
      item.addEventListener('click', () => {
        const rawId = item.dataset.channelId;
        const parsedId = rawId ? Number(rawId) : null;
        const nextId = Number.isFinite(parsedId) ? parsedId : null;
        const nextYtId = item.dataset.ytChannelId || null;
        state.selectedChannelId = nextId;
        state.selectedChannelYtId = nextYtId || null;
        state.selectedCategoryId = null;
        state.selectedCategoryName = '';
        ui.channelList.querySelectorAll('.channel-item').forEach(node => {
          const nodeId = node.dataset.channelId || null;
          const nodeYtId = node.dataset.ytChannelId || null;
          const allSelected = state.selectedChannelId === null && !state.selectedChannelYtId;
          const idSelected = state.selectedChannelId !== null
            && String(state.selectedChannelId) === nodeId;
          const ytSelected = state.selectedChannelYtId && nodeYtId === state.selectedChannelYtId;
          node.classList.toggle(
            'is-active',
            (allSelected && !nodeId) || idSelected || ytSelected
          );
          node.setAttribute('aria-pressed', node.classList.contains('is-active') ? 'true' : 'false');
        });
        updateHeaderContext();
        updateVideoCounts();
        if (isPhoneMode()) {
          setMobileView('home');
        }
        if (state.searchActive) {
          runSearch(state.searchQuery);
        } else {
          reloadCarousels();
        }
      });
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          item.click();
        }
      });
    });
  }

  function prefetchChannelThumbnails(channels) {
    if (!Array.isArray(channels) || !channels.length) {
      return;
    }

    const baseUrl = window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL
      ? window.APP_CONFIG.API_BASE_URL.replace(/\/$/, '')
      : '';

    const queue = channels
      .filter(channel => channel.thumbnail_local_url && !state.prefetchedThumbnails.has(channel.id))
      .map(channel => ({
        id: channel.id,
        url: baseUrl ? `${baseUrl}${channel.thumbnail_local_url}` : channel.thumbnail_local_url
      }))
      .filter(item => item.url);

    if (!queue.length) {
      return;
    }

    let index = 0;
    let active = 0;
    const concurrency = 4;

    const loadNext = () => {
      while (active < concurrency && index < queue.length) {
        const item = queue[index++];
        state.prefetchedThumbnails.add(item.id);
        active += 1;

        const img = new Image();
        img.onload = () => {
          active -= 1;
          loadNext();
        };
        img.onerror = () => {
          active -= 1;
          loadNext();
        };
        img.src = item.url;
      }
    };

    loadNext();
  }

  function updateChannelCount(channels) {
    if (!ui.channelCount) {
      return;
    }

    const count = Array.isArray(channels) ? channels.length : 0;
    ui.channelCount.textContent = t('mobileChannelsCount', { count });
  }

  async function updateVideoCounts() {
    if (!ui.videosCount && !ui.shortsCount) {
      return;
    }

    if (state.selectedCategoryId !== null) {
      const [videosResponse, shortsResponse] = await Promise.all([
        api.getLatestVideos(200, 0, { content_type: 'video', since_days: 7, only_unwatched: true }),
        api.getLatestVideos(200, 0, { content_type: 'short', since_days: 7, only_unwatched: true })
      ]);

      const videos = videosResponse.ok && videosResponse.data
        ? applyFilters(videosResponse.data).videos.length
        : 0;
      const shorts = shortsResponse.ok && shortsResponse.data
        ? applyFilters(shortsResponse.data).videos.length
        : 0;

      if (ui.videosCount) {
        ui.videosCount.textContent = String(videos);
      }
      if (ui.shortsCount) {
        ui.shortsCount.textContent = String(shorts);
      }
      return;
    }

    const response = await api.getVideoSummary(
      7,
      state.selectedChannelId,
      state.selectedChannelYtId
    );
    if (!response.ok || !response.data) {
      return;
    }

    const videos = typeof response.data.videos === 'number' ? response.data.videos : 0;
    const shorts = typeof response.data.shorts === 'number' ? response.data.shorts : 0;

    if (ui.videosCount) {
      ui.videosCount.textContent = String(videos);
    }
    if (ui.shortsCount) {
      ui.shortsCount.textContent = String(shorts);
    }
  }

  function updateLastUpdatedLabel(channels) {
    if (!ui.lastUpdatedLabel) {
      return;
    }

    const timestamps = (channels || [])
      .map(channel => channel.last_checked_at || channel.last_refreshed_at)
      .filter(Boolean)
      .map(value => new Date(value))
      .filter(date => !Number.isNaN(date.getTime()));

    if (state.settings && state.settings.last_schedule_run_at) {
      const scheduleDate = new Date(state.settings.last_schedule_run_at);
      if (!Number.isNaN(scheduleDate.getTime())) {
        timestamps.push(scheduleDate);
      }
    }

    if (!timestamps.length) {
      ui.lastUpdatedLabel.textContent = t('lastUpdatedNone');
      return;
    }

    timestamps.sort((a, b) => b.getTime() - a.getTime());
    const latest = timestamps[0];
    const relative = typeof window.timeAgo === 'function' ? window.timeAgo(latest.toISOString()) : '';
    ui.lastUpdatedLabel.textContent = relative
      ? t('lastUpdatedRelative', { relative })
      : t('lastUpdatedAbsolute', { date: latest.toLocaleString() });
  }

  function stopLastUpdatedTicker() {
    if (state.lastUpdatedTicker) {
      window.clearInterval(state.lastUpdatedTicker);
      state.lastUpdatedTicker = null;
    }
  }

  function startLastUpdatedTicker() {
    stopLastUpdatedTicker();
    state.lastUpdatedTicker = window.setInterval(() => {
      if (!state.currentUser) {
        return;
      }
      updateLastUpdatedLabel(state.channels);
    }, 30 * 1000);
  }

  function getLatestCheckedAt(channels) {
    const timestamps = (channels || [])
      .map(channel => channel.last_checked_at || channel.last_refreshed_at)
      .filter(Boolean)
      .map(value => new Date(value))
      .filter(date => !Number.isNaN(date.getTime()));

    if (state.settings && state.settings.last_schedule_run_at) {
      const scheduleDate = new Date(state.settings.last_schedule_run_at);
      if (!Number.isNaN(scheduleDate.getTime())) {
        timestamps.push(scheduleDate);
      }
    }

    if (!timestamps.length) {
      return null;
    }

    timestamps.sort((a, b) => b.getTime() - a.getTime());
    return timestamps[0];
  }

  async function syncChannelsState() {
    const channelsResponse = await api.getChannels();
    if (channelsResponse.ok) {
      state.channels = channelsResponse.data || [];
    }
    return state.channels;
  }

  function countUnclassifiedChannels(channels = state.channels) {
    return (Array.isArray(channels) ? channels : []).filter(channel => (
      !(channel && channel.category && channel.category.category)
    )).length;
  }

  function setUnclassifiedMetricProgress(active, remaining = null) {
    state.unclassifiedMetric.active = Boolean(active);
    state.unclassifiedMetric.remaining = typeof remaining === 'number'
      ? Math.max(0, remaining)
      : null;
    updateHeaderContext();
  }

  async function syncVisibleStateAfterRefresh() {
    await syncChannelsState();
    renderChannelList(state.channels);
    updateChannelCount(state.channels);
    updateLastUpdatedLabel(state.channels);
    updateHeaderContext();
    await updateVideoCounts();

    if (state.searchActive) {
      await runSearch(state.searchQuery);
      state.initialContentReady = true;
      return;
    }

    await reloadCarousels();
    state.initialContentReady = true;
  }

  async function refreshVisibleStateDuringUpdate() {
    await syncChannelsState();
    renderChannelList(state.channels);
    updateChannelCount(state.channels);
    updateLastUpdatedLabel(state.channels);
    updateHeaderContext();
    await updateVideoCounts();
    await reloadCarousels();
  }

  function startAutoRefresh(channelId = null, options = {}) {
    const {
      keepLoadingState = false,
      onComplete = null,
      onError = null
    } = options;

    if (state.autoRefreshPromise) {
      return state.autoRefreshPromise;
    }

    state.autoRefreshAttempted = true;
    state.autoRefreshKeepsLoadingState = keepLoadingState;
    showNotification(t('refreshInProgress'), 'info');

    state.autoRefreshPromise = streamRefresh(channelId, {
      onProgress: async payload => {
        updateRefreshProgressFromEvent(payload);
        if (
          !keepLoadingState
          && state.initialContentReady
          && payload.type === 'channel_complete'
          && payload.channel_new_videos > 0
        ) {
          scheduleVisibleReload();
        }
      }
    })
      .then(async payload => {
        if (payload && payload.type === 'complete') {
          await syncChannelsState();
          if (keepLoadingState || !state.initialContentReady) {
            await syncVisibleStateAfterRefresh();
          }
        }
        if (typeof onComplete === 'function') {
          await onComplete(payload);
        }
        return payload;
      })
      .catch(async error => {
        if (typeof onError === 'function') {
          await onError(error);
        }
        return null;
      })
      .finally(() => {
        state.autoRefreshPromise = null;
        state.autoRefreshKeepsLoadingState = false;
      });

    return state.autoRefreshPromise;
  }

  async function loadApp() {
    if (!state.currentUser) {
      return;
    }

    state.initialContentReady = false;
    setLoading(true, 'latest-carousel');
    renderChannelListLoading();
    renderPrimaryLoadingStates();

    await syncChannelsState();

    if (
      state.currentUser.auth_provider === 'google'
      && state.channels.length === 0
      && !state.autoImportAttempted
    ) {
      state.autoImportAttempted = true;
      await importSubscriptions(false);
      await syncChannelsState();
    }

    renderChannelList(state.channels);
    updateChannelCount(state.channels);
    updateLastUpdatedLabel(state.channels);
    updateHeaderContext();
    await updateVideoCounts();
    prefetchChannelThumbnails(state.channels);

    const latestCheckedAt = getLatestCheckedAt(state.channels);
    const shouldAutoRefreshFromEmptyState = (
      state.currentUser.auth_provider === 'google'
      && state.channels.length > 0
      && !latestCheckedAt
    );
    const shouldAutoRefreshFromStaleState = latestCheckedAt
      ? Date.now() - latestCheckedAt.getTime() > AUTO_REFRESH_STALE_HOURS * 60 * 60 * 1000
      : false;

    if (!state.autoRefreshAttempted && shouldAutoRefreshFromEmptyState) {
      startAutoRefresh(null, { keepLoadingState: true });
      setLoading(false, 'latest-carousel');
      return;
    }

    clearCarousels();
    await renderInProgressCarousel();
    await renderMainCarousel();
    state.initialContentReady = true;

    deferredTask(async () => {
      await renderShortsCarousel();

      if (ui.olderSection) {
        ui.olderSection.hidden = false;
      }
      await renderOlderCarousel();

      await renderWatchedCarousel();

      if (typeof window.CategoryManager === 'function' && ui.categoryCarousels) {
        state.categoryManager = new window.CategoryManager(api, 'category-carousels', {
          getSelectedCategoryId: () => state.selectedCategoryId,
          onCategorySelect: category => {
            const nextCategoryId = category && category.id != null ? Number(category.id) : null;
            const isSameCategory = nextCategoryId !== null && nextCategoryId === state.selectedCategoryId;
            state.selectedCategoryId = isSameCategory ? null : nextCategoryId;
            state.selectedCategoryName = isSameCategory
              ? ''
              : (category.display_name_es || category.display_name_en || category.name || '');
            state.selectedChannelId = null;
            state.selectedChannelYtId = null;
            renderChannelList(state.channels);
            updateHeaderContext();
            updateVideoCounts();
            if (isPhoneMode()) {
              setMobileView('home');
            }
            if (state.searchActive) {
              runSearch(state.searchQuery);
            } else {
              reloadCarousels();
            }
          }
        });
        await state.categoryManager.init();
        if (ui.categoriesSection) {
          ui.categoriesSection.hidden = false;
        }
      }
    });

    setLoading(false, 'latest-carousel');

    if (!state.autoRefreshAttempted && shouldAutoRefreshFromStaleState) {
      startAutoRefresh(null);
    }
  }

  async function reloadCarousels(options = {}) {
    const preserveDOM = options.preserveDOM !== undefined ? Boolean(options.preserveDOM) : true;
    clearCarousels(preserveDOM);
    await renderInProgressCarousel();
    await renderMainCarousel();
    await renderShortsCarousel();
    await renderOlderCarousel();
    await renderWatchedCarousel();

    // Ocultar categorías automáticas cuando hay un canal seleccionado.
    // Solo se muestran cuando no hay canal activo (vista "All").
    if (ui.categoriesSection) {
      ui.categoriesSection.hidden = state.selectedChannelId !== null || state.selectedCategoryId !== null;
    }
  }

  // Expose for player overlay to refresh after "Continue later" / "Mark watched"
  window.ytcvReloadCarousels = options => reloadCarousels(options);

  async function refreshWatchedCarouselOnly() {
    state.carousels = state.carousels.filter(carousel => {
      if (!carousel || carousel.containerId !== 'watched-carousel') {
        return true;
      }
      if (typeof carousel.destroy === 'function') {
        carousel.destroy(false);
      }
      return false;
    });
    if (ui.watchedCarousel) {
      ui.watchedCarousel.innerHTML = '';
    }
    if (ui.watchedSection) {
      ui.watchedSection.hidden = true;
    }
    await renderWatchedCarousel();
  }

  async function refreshInProgressCarouselOnly() {
    state.carousels = state.carousels.filter(carousel => {
      if (!carousel || carousel.containerId !== 'in-progress-carousel') {
        return true;
      }
      if (typeof carousel.destroy === 'function') {
        carousel.destroy(false);
      }
      return false;
    });
    if (ui.inProgressCarousel) {
      ui.inProgressCarousel.innerHTML = '';
    }
    if (ui.inProgressSection) {
      ui.inProgressSection.hidden = true;
    }
    await renderInProgressCarousel();
  }

  async function handleVideoMarkedWatched(videoId, options = {}) {
    const id = videoId != null ? String(videoId) : null;
    if (!id) {
      return;
    }

    state.carousels.forEach(carousel => {
      if (!carousel || typeof carousel.removeVideoById !== 'function') {
        return;
      }
      if (carousel.containerId === 'watched-carousel') {
        return;
      }
      carousel.removeVideoById(id);
    });

    if (ui.inProgressSection && ui.inProgressCarousel) {
      const hasCards = ui.inProgressCarousel.querySelector('.video-card');
      if (!hasCards) {
        ui.inProgressSection.hidden = true;
        if (ui.inProgressCount) {
          ui.inProgressCount.textContent = '0';
        }
      }
    }

    if (state.showWatchedCarousel && options.refreshWatched !== false) {
      await refreshWatchedCarouselOnly();
    }
  }

  window.ytcvHandleVideoMarkedWatched = (videoId, options) => handleVideoMarkedWatched(videoId, options);

  async function handleVideoSavedForLater(videoId) {
    const id = videoId != null ? String(videoId) : null;
    if (!id) {
      return;
    }

    state.carousels.forEach(carousel => {
      if (!carousel || typeof carousel.removeVideoById !== 'function') {
        return;
      }
      if (carousel.containerId === 'in-progress-carousel') {
        return;
      }
      carousel.removeVideoById(id);
    });

    if (state.showInProgressCarousel) {
      await refreshInProgressCarouselOnly();
    }
  }

  window.ytcvHandleVideoSavedForLater = videoId => handleVideoSavedForLater(videoId);

  let refreshVisibleTimer = null;
  function scheduleVisibleReload() {
    if (state.searchActive || !state.initialContentReady) {
      return;
    }
    if (refreshVisibleTimer) {
      window.clearTimeout(refreshVisibleTimer);
    }
    refreshVisibleTimer = window.setTimeout(async () => {
      refreshVisibleTimer = null;
      await refreshVisibleStateDuringUpdate();
    }, 700);
  }

  function setupFilters() {
    const updateButtons = () => {
      if (ui.filterUnwatched) {
        ui.filterUnwatched.classList.toggle('is-active', state.filters.unwatched);
        ui.filterUnwatched.setAttribute('aria-pressed', state.filters.unwatched ? 'true' : 'false');
      }
      if (ui.filterMonth) {
        ui.filterMonth.classList.toggle('is-active', state.filters.month);
        ui.filterMonth.setAttribute('aria-pressed', state.filters.month ? 'true' : 'false');
      }
      if (ui.filterHideShorts) {
        ui.filterHideShorts.classList.toggle('is-active', state.filters.hideShorts);
        ui.filterHideShorts.setAttribute('aria-pressed', state.filters.hideShorts ? 'true' : 'false');
      }
    };

    const applyFiltersNow = () => {
      renderChannelList(state.channels);
      if (state.searchActive) {
        runSearch(state.searchQuery);
      } else {
        reloadCarousels();
      }
    };

    if (ui.filterUnwatched) {
      ui.filterUnwatched.addEventListener('click', () => {
        const next = !state.filters.unwatched;
        state.filters.unwatched = next;
        if (next) {
          state.filters.month = false;
        }
        updateButtons();
        applyFiltersNow();
      });
    }

    if (ui.filterMonth) {
      ui.filterMonth.addEventListener('click', () => {
        const next = !state.filters.month;
        state.filters.month = next;
        if (next) {
          state.filters.unwatched = false;
        }
        updateButtons();
        applyFiltersNow();
      });
    }

    if (ui.filterHideShorts) {
      ui.filterHideShorts.addEventListener('click', () => {
        state.filters.hideShorts = !state.filters.hideShorts;
        updateButtons();
        updateShortsSectionVisibility();
        applyFiltersNow();
      });
    }

    updateButtons();
  }

  function setupOptionalCarouselToggles() {
    updateOptionalCarouselButtons();

    if (ui.tvActionInProgress) {
      ui.tvActionInProgress.addEventListener('click', () => {
        toggleOptionalCarousel('in_progress');
      });
    }

    if (ui.tvActionWatched) {
      ui.tvActionWatched.addEventListener('click', () => {
        toggleOptionalCarousel('watched');
      });
    }
  }

  function clearSearch() {
    state.searchActive = false;
    state.searchQuery = '';
    if (ui.searchInput) {
      ui.searchInput.value = '';
    }
    renderChannelList(state.channels);

    if (ui.videosLabel) {
      ui.videosLabel.textContent = t('videosRecent30Days');
    }
    if (ui.videosCount) {
      ui.videosCount.hidden = false;
    }


    reloadCarousels();
  }

  async function runSearch(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      clearSearch();
      return;
    }

    state.searchActive = true;
    state.searchQuery = trimmed;
    renderChannelList(state.channels);

    if (ui.videosLabel) {
      ui.videosLabel.textContent = t('searchResults', { query: trimmed });
    }
    if (ui.videosCount) {
      ui.videosCount.hidden = true;
    }

    if (ui.shortsSection) {
      ui.shortsSection.hidden = true;
    }
    if (ui.olderSection) {
      ui.olderSection.hidden = true;
    }

    clearCarousels();

    const carousel = new window.Carousel('latest-carousel', async (offset, limit) => {
      const filters = { limit, offset };
      if (state.selectedChannelId !== null) {
        filters.channel_id = state.selectedChannelId;
      }
      if (state.selectedChannelYtId) {
        filters.yt_channel_id = state.selectedChannelYtId;
      }

      const response = await api.searchVideos(trimmed, filters);
      if (!response.ok) {
        return { videos: [], has_more: false, next_offset: null };
      }
      return applyFilters(response.data);
    }, { hideTextForShorts: true });

    await carousel.init();
    state.carousels.push(carousel);
  }

  function setupSearch() {
    const handleSearch = () => {
      const query = ui.searchInput ? ui.searchInput.value : '';
      runSearch(query);
    };

    const debounced = typeof window.debounce === 'function'
      ? window.debounce(handleSearch, 300)
      : handleSearch;

    if (ui.searchInput) {
      ui.searchInput.addEventListener('input', debounced);
    }

  }

  function syncChannelSearchUI() {
    if (ui.channelSearchInput && ui.channelSearchInput.value !== state.channelFilterQuery) {
      ui.channelSearchInput.value = state.channelFilterQuery;
    }
    if (ui.channelSearchClear) {
      ui.channelSearchClear.hidden = !state.channelFilterQuery;
    }
  }

  function clearChannelSearch(options = {}) {
    const { focusInput = false } = options;
    state.channelFilterQuery = '';
    syncChannelSearchUI();
    renderChannelList(state.channels);
    if (focusInput && ui.channelSearchInput) {
      ui.channelSearchInput.focus();
    }
  }

  function setupChannelSidebarSearch() {
    if (!ui.channelSearchInput) {
      return;
    }

    const applySidebarSearch = query => {
      state.channelFilterQuery = typeof window.normalizeSidebarQuery === 'function'
        ? window.normalizeSidebarQuery(query)
        : String(query || '').trim().toLowerCase();
      syncChannelSearchUI();
      renderChannelList(state.channels);
    };

    ui.channelSearchInput.addEventListener('input', event => {
      applySidebarSearch(event.target.value);
    });

    ui.channelSearchInput.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        clearChannelSearch({ focusInput: true });
      }
    });

    if (ui.channelSearchClear) {
      ui.channelSearchClear.addEventListener('click', () => {
        clearChannelSearch({ focusInput: true });
      });
    }

    syncChannelSearchUI();
  }

  function setupMenu() {
    if (!ui.menuToggle || !ui.menuPanel) {
      return;
    }

    const setMenuOpen = isOpen => {
      ui.menuPanel.hidden = !isOpen;
      ui.menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (isOpen) {
        const firstAction = ui.menuPanel.querySelector('button:not([hidden])');
        if (firstAction) {
          firstAction.focus();
        }
      }
    };
    state.setMenuOpen = setMenuOpen;

    ui.menuToggle.addEventListener('click', event => {
      event.stopPropagation();
      const isOpen = ui.menuPanel.hidden;
      setMenuOpen(isOpen);
    });

    document.addEventListener('click', event => {
      if (ui.menuPanel.hidden) {
        return;
      }
      if (ui.menuPanel.contains(event.target) || ui.menuToggle.contains(event.target)) {
        return;
      }
      setMenuOpen(false);
    });

    if (ui.menuFilters) {
      ui.menuFilters.addEventListener('click', () => {
        setMenuOpen(false);
        openFilterPanel();
      });
    }

    if (ui.menuCategoryGuide) {
      ui.menuCategoryGuide.addEventListener('click', () => {
        setMenuOpen(false);
        openGuide();
      });
    }

    if (ui.menuSettings) {
      ui.menuSettings.addEventListener('click', () => {
        setMenuOpen(false);
        openSettingsModal();
      });
    }

    if (ui.menuGestor) {
      ui.menuGestor.addEventListener('click', () => {
        setMenuOpen(false);
        window.open('/gestor/', '_blank', 'noopener');
      });
    }

    if (ui.myAccountButton) {
      ui.myAccountButton.addEventListener('click', () => {
        setMenuOpen(false);
        if (window.ytcvAccountPanel) {
          window.ytcvAccountPanel.open('profile');
        }
      });
    }

    const updateMenuAuth = user => {
      if (ui.myAccountButton) {
        ui.myAccountButton.hidden = !user;
      }
      if (ui.logoutButton) {
        ui.logoutButton.hidden = !user;
      }
      if (ui.refreshButton) {
        ui.refreshButton.hidden = !user;
      }
      if (ui.menuSettings) {
        ui.menuSettings.hidden = !user;
      }
    };

    updateMenuAuth(state.currentUser);
    window.addEventListener('auth:changed', event => {
      const user = event.detail ? event.detail.user : null;
      updateMenuAuth(user);
    });
  }

  function setupLanguageMenu() {
    if (!ui.languageButtons || ui.languageButtons.length === 0) {
      return;
    }

    const current = window.ytcvI18n ? window.ytcvI18n.language : 'en';
    ui.languageButtons.forEach(button => {
      const lang = button.dataset.lang;
      button.classList.toggle('is-active', lang === current);
      button.addEventListener('click', () => {
        try {
          localStorage.setItem('ytcv_lang', lang);
        } catch (error) {
          // Ignore storage errors.
        }
        window.location.reload();
      });
    });
  }

  function setupFilterPanel() {
    if (!ui.filterPanel) {
      return;
    }

    const header = ui.filterPanel.querySelector('.filter-panel__header');
    const panel = ui.filterPanel;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    const clamp = () => {
      const rect = panel.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;
      const nextX = Math.min(Math.max(rect.left, 8), Math.max(maxX, 8));
      const nextY = Math.min(Math.max(rect.top, 8), Math.max(maxY, 8));
      panel.style.left = `${nextX}px`;
      panel.style.top = `${nextY}px`;
    };

    const onMouseMove = event => {
      if (!isDragging) {
        return;
      }
      panel.style.left = `${originX + (event.clientX - startX)}px`;
      panel.style.top = `${originY + (event.clientY - startY)}px`;
    };

    const onMouseUp = () => {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      clamp();
    };

    if (header) {
      header.addEventListener('mousedown', event => {
        if (event.button !== 0) {
          return;
        }
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button')) {
          return;
        }
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        originX = rect.left;
        originY = rect.top;
        panel.style.right = 'auto';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    }

    window.addEventListener('resize', clamp);

    if (ui.filterPanelClose) {
      ui.filterPanelClose.addEventListener('click', () => {
        panel.hidden = true;
        if (ui.menuFilters) {
          ui.menuFilters.focus();
        }
      });
    }

    if (ui.filterPanelClear) {
      ui.filterPanelClear.addEventListener('click', () => {
        state.filters.unwatched = false;
        state.filters.month = false;
        state.filters.hideShorts = false;
        if (ui.filterUnwatched) {
          ui.filterUnwatched.classList.remove('is-active');
          ui.filterUnwatched.setAttribute('aria-pressed', 'false');
        }
        if (ui.filterMonth) {
          ui.filterMonth.classList.remove('is-active');
          ui.filterMonth.setAttribute('aria-pressed', 'false');
        }
        if (ui.filterHideShorts) {
          ui.filterHideShorts.classList.remove('is-active');
          ui.filterHideShorts.setAttribute('aria-pressed', 'false');
        }
        clearSearch();
      });
    }
  }

  function openFilterPanel() {
    if (!ui.filterPanel) {
      return;
    }

    ui.filterPanel.hidden = false;
    if (ui.searchInput) {
      ui.searchInput.focus();
    }
  }

  function setupKeyboardNavigation() {
    document.addEventListener('keydown', event => {
      const isArrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
      if (!isArrow) {
        return;
      }

      const active = document.activeElement;
      const isTypingTarget = active && (
        active.tagName === 'INPUT'
        || active.tagName === 'TEXTAREA'
        || active.tagName === 'SELECT'
        || active.isContentEditable
      );

      if (isTypingTarget) {
        return;
      }

      const directionMap = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down'
      };

      const nextElement = getDirectionalCandidate(active, directionMap[event.key]);
      if (!nextElement) {
        return;
      }

      event.preventDefault();
      nextElement.focus();
      nextElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    });
  }

  function setupRefresh() {
    if (!ui.refreshButton) {
      return;
    }

    const closeMenuForAsyncAction = event => {
      if (event && event.currentTarget && typeof event.currentTarget.blur === 'function') {
        event.currentTarget.blur();
      }
      if (typeof state.setMenuOpen === 'function') {
        state.setMenuOpen(false);
      }
    };

    ui.refreshButton.addEventListener('click', async event => {
      closeMenuForAsyncAction(event);
      const targetChannelId = state.selectedChannelId !== null ? state.selectedChannelId : null;
      reportImportStatus(t('refreshInProgress'), 'info');

      try {
        const result = await streamRefresh(targetChannelId, {
          onProgress: async payload => {
            updateRefreshProgressFromEvent(payload);
            if (payload.type === 'channel_complete' && payload.channel_new_videos > 0) {
              scheduleVisibleReload();
            }
          },
          onComplete: async payload => {
            reportImportStatus('', 'info');
            if (!payload) {
              return;
            }
            if (payload.type === 'blocked') {
              const helper = window.ytcvRefreshGovernance;
              if (payload.reason === 'refresh_in_progress') {
                showNotification(
                  helper ? helper.getBlockedToastMessage(t, payload) : t('refreshAlreadyRunning'),
                  'info'
                );
              } else {
                showNotification(
                  helper ? helper.getBlockedToastMessage(t, payload) : t('refreshCooldownActive', { minutes: 1 }),
                  'warning'
                );
              }
              return;
            }
            await syncVisibleStateAfterRefresh();
            showNotification(t('newVideosFound', { count: payload.new_videos || 0 }), 'success');
          },
          onError: async () => {
            reportImportStatus('', 'info');
          }
        });
        if (!result) {
          return;
        }
      } catch (error) {
        reportImportStatus('', 'info');
        showNotification(t('unableRefreshVideos'), 'error');
      }
    });
  }

  async function importSubscriptions(showToast) {
    if (!state.currentUser || state.currentUser.auth_provider !== 'google') {
      return false;
    }

    let pageToken = null;
    let processed = 0;
    let total = null;
    let newSubscriptions = 0;
    let newChannels = 0;

    reportImportStatus(t('importingSubscriptions'), 'info');

    while (true) {
      const response = await api.importSubscriptions({
        page_token: pageToken,
        max_results: 50
      });

      if (!response.ok) {
        if (showToast) {
          showNotification(t('unableImportSubscriptions'), 'error');
        }
        reportImportStatus('', 'info');
        return false;
      }

      const payload = response.data || {};
      processed += typeof payload.imported === 'number' ? payload.imported : 0;
      newSubscriptions += typeof payload.new_subscriptions === 'number' ? payload.new_subscriptions : 0;
      newChannels += typeof payload.new_channels === 'number' ? payload.new_channels : 0;
      if (typeof payload.total_results === 'number') {
        total = payload.total_results;
      }

      if (total) {
        reportImportStatus(t('importingSubscriptionsProgress', { processed, total }), 'info');
      } else {
        reportImportStatus(t('importingSubscriptionsProgressPartial', { processed }), 'info');
      }

      pageToken = payload.next_page_token || null;
      if (!pageToken) {
        break;
      }

      await sleep(800);
    }

    reportImportStatus('', 'info');

    return {
      ok: true,
      newSubscriptions,
      newChannels
    };
  }

  async function importSubscriptionsAndRefresh(showToast) {
    const importResult = await importSubscriptions(showToast);
    if (!importResult || !importResult.ok) {
      return false;
    }

    reportImportStatus(t('refreshInProgress'), 'info');
    let videoCount = 0;
    try {
      const refreshPayload = await streamRefresh(null, {
        onProgress: async payload => {
          updateRefreshProgressFromEvent(payload);
          if (payload.type === 'channel_complete' && payload.channel_new_videos > 0) {
            scheduleVisibleReload();
          }
        }
      });
      videoCount = refreshPayload && refreshPayload.type === 'complete' && typeof refreshPayload.new_videos === 'number'
        ? refreshPayload.new_videos
        : 0;
    } catch (error) {
      reportImportStatus('', 'info');
      if (showToast) {
        showNotification(t('importFailed'), 'warning');
      }
      return true;
    }
    reportImportStatus('', 'info');

    if (showToast) {
      showNotification(
        t('importSummary', {
          subscriptions: importResult.newSubscriptions,
          channels: importResult.newChannels,
          videos: videoCount
        }),
        'success'
      );
      showNotification(t('allSubscriptionsUpToDate'), 'success');
    }

    // Auto-classify unclassified channels after import + refresh
    classifyUnclassifiedChannels(msg => setRefreshProgress(msg))
      .then(count => {
        setRefreshProgress('');
        if (count > 0) showNotification(t('classifyComplete', { count }), 'success');
      })
      .catch(() => setRefreshProgress(''));

    return true;
  }

  function updateImportVisibility(user) {
    if (!ui.importButton) {
      return;
    }

    const provider = user ? user.auth_provider : null;
    ui.importButton.hidden = !user || provider !== 'google';
  }

  function setupImportButton() {
    if (!ui.importButton) {
      return;
    }

    ui.importButton.addEventListener('click', async event => {
      if (event && event.currentTarget && typeof event.currentTarget.blur === 'function') {
        event.currentTarget.blur();
      }
      if (typeof state.setMenuOpen === 'function') {
        state.setMenuOpen(false);
      }
      if (!state.currentUser) {
        showNotification(t('signInBeforeImport'), 'warning');
        return;
      }

      ui.importButton.disabled = true;
      await importSubscriptionsAndRefresh(true);
      ui.importButton.disabled = false;
      await syncVisibleStateAfterRefresh();
    });

    updateImportVisibility(state.currentUser);
    window.addEventListener('auth:changed', event => {
      const user = event.detail ? event.detail.user : null;
      updateImportVisibility(user);
    });
  }

  // ── Shared classify function ──────────────────────────────────────────────

  function classificationProgressMessage(status) {
    if (!status || !status.active) {
      return '';
    }
    if (status.mode === 'full') {
      if (status.phase === 'full_video_evidence') {
        return t('classificationModeRunningFullEvidence');
      }
      return t('classificationProgressFull', {
        cursor: status.cursor,
        total: status.total,
        classified: status.classified || 0
      });
    }
    return t('classifyProgress', {
      cursor: status.cursor,
      total: status.total,
      classified: status.classified || 0
    });
  }

  async function monitorClassificationTask(mode, progressCallback) {
    const report = progressCallback || (() => {});
    const initialUnclassified = countUnclassifiedChannels();

    // Start the background task on the backend
    const startResp = await api.startClassifyTask(mode);
    // Nothing to classify
    if (startResp.ok && startResp.data && startResp.data.active === false) {
      setUnclassifiedMetricProgress(false);
      return 0;
    }
    // 409 means already running — continue to poll
    if (!startResp.ok && startResp.status !== 409) {
      setUnclassifiedMetricProgress(false);
      throw new Error('Failed to start classify task');
    }

    setUnclassifiedMetricProgress(true, initialUnclassified);

    // Poll until done
    return new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const resp = await api.getClassifyStatus();
          if (!resp.ok) {
            clearInterval(poll);
            setUnclassifiedMetricProgress(false);
            reject(new Error('Failed to get classify status'));
            return;
          }
          const s = resp.data;
          if (s.active) {
            if (mode === 'full') {
              setUnclassifiedMetricProgress(true);
            } else {
              const remaining = Math.max(0, initialUnclassified - Number(s.classified || 0));
              setUnclassifiedMetricProgress(true, remaining);
            }
            report(classificationProgressMessage(s));
          } else {
            clearInterval(poll);
            report('');
            // Refresh UI
            await syncChannelsState();
            renderChannelList(state.channels);
            updateHeaderContext();
            if (state.categoryManager) {
              await state.categoryManager.init();
            }
            setUnclassifiedMetricProgress(false);
            resolve(s.classified || 0);
          }
        } catch (err) {
          clearInterval(poll);
          setUnclassifiedMetricProgress(false);
          reject(err);
        }
      }, 3000);
    });
  }

  async function resumeClassifyPollIfActive() {
    try {
      const resp = await api.getClassifyStatus();
      if (resp.ok && resp.data && resp.data.active) {
        const mode = resp.data.mode === 'full' ? 'full' : 'basic';
        state.classificationActive = true;
        const initialMessage = classificationProgressMessage(resp.data);
        if (initialMessage) {
          setRefreshProgress(initialMessage);
        }
        monitorClassificationTask(mode, msg => setRefreshProgress(msg))
          .then(count => {
            state.classificationActive = false;
            setRefreshProgress('');
            if (count > 0) {
              showNotification(
                mode === 'full'
                  ? t('reclassifyComplete', { count })
                  : t('classifyComplete', { count }),
                'success'
              );
            }
            void syncRefreshStatus();
          })
          .catch(() => {
            state.classificationActive = false;
            setRefreshProgress('');
            void syncRefreshStatus();
          });
      }
    } catch (_) {
      // Ignore — status check is best-effort on load
    }
  }

  function setupClassifyButton() {
    if (!ui.classifyButton) return;

    ui.classifyButton.addEventListener('click', async () => {
      const mode = await openClassificationChoiceModal();
      if (!mode) {
        return;
      }

      if (mode === 'full') {
        const confirmed = await openConfirmModal(t('classificationModeFullConfirm'));
        if (!confirmed) {
          return;
        }
      }

      ui.classifyButton.disabled = true;
      try {
        state.classificationActive = true;
        if (mode === 'full') {
          await runFullReclassification();
        } else {
          await runBasicClassification();
        }
      } catch (_) {
        state.classificationActive = false;
        showNotification(mode === 'full' ? t('reclassifyError') : t('classifyError'), 'error');
      } finally {
        state.classificationActive = false;
        ui.classifyButton.disabled = false;
        ui.classifyButton.textContent = t('classifyChannels');
        setRefreshProgress('');
        void syncRefreshStatus();
      }
    });

    // Show/hide based on auth
    const updateVisibility = user => {
      ui.classifyButton.hidden = !user;
    };
    updateVisibility(state.currentUser);
    window.addEventListener('auth:changed', event => {
      updateVisibility(event.detail ? event.detail.user : null);
    });
  }

  async function runBasicClassification() {
    const classified = await monitorClassificationTask('basic', msg => {
      setRefreshProgress(msg);
    });

    if (classified > 0) {
      showNotification(t('classifyComplete', { count: classified }), 'success');
      return;
    }

    showNotification(t('classifyNothingToDo'), 'info');
  }

  async function runFullReclassification() {
    const reclassified = await monitorClassificationTask('full', msg => {
      setRefreshProgress(msg);
    });

    if (reclassified > 0) {
      showNotification(t('reclassifyComplete', { count: reclassified }), 'success');
      return;
    }

    showNotification(t('reclassifyNothingToDo'), 'info');
  }

  async function openClassificationChoiceModal() {
    return new Promise(resolve => {
      let closed = false;
      const overlay = document.createElement('section');
      overlay.className = 'confirm-modal-overlay';
      overlay.id = 'classification-choice-modal';

      const modal = document.createElement('div');
      modal.className = 'confirm-modal classification-choice-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'classification-choice-title');

      const header = document.createElement('header');
      header.className = 'confirm-modal__header';

      const title = document.createElement('h2');
      title.id = 'classification-choice-title';
      title.className = 'heading-2';
      title.textContent = t('classificationChoiceTitle');

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'confirm-modal__close';
      closeButton.setAttribute('aria-label', t('close'));
      closeButton.textContent = '✕';

      header.append(title, closeButton);

      const body = document.createElement('div');
      body.className = 'confirm-modal__body classification-choice-modal__body';

      const intro = document.createElement('p');
      intro.className = 'body';
      intro.textContent = t('classificationChoiceDescription');
      body.appendChild(intro);

      const options = document.createElement('div');
      options.className = 'classification-choice-modal__options';

      const buildOption = (mode, titleKey, descKey) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button--ghost classification-choice-modal__option';

        const optionTitle = document.createElement('span');
        optionTitle.className = 'classification-choice-modal__option-title';
        optionTitle.textContent = t(titleKey);

        const optionDescription = document.createElement('span');
        optionDescription.className = 'classification-choice-modal__option-description';
        optionDescription.textContent = t(descKey);

        button.append(optionTitle, optionDescription);
        button.addEventListener('click', () => close(mode));
        return button;
      };

      options.append(
        buildOption(
          'basic',
          'classificationModeBasicTitle',
          'classificationModeBasicDescription'
        ),
        buildOption(
          'full',
          'classificationModeFullTitle',
          'classificationModeFullDescription'
        )
      );
      body.appendChild(options);

      const footer = document.createElement('footer');
      footer.className = 'confirm-modal__footer classification-choice-modal__footer';

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'button button--ghost';
      cancelButton.textContent = t('cancel');
      footer.appendChild(cancelButton);

      const handleEscape = event => {
        if (event.key === 'Escape' && document.body.contains(overlay)) {
          close(null);
        }
      };

      const close = value => {
        if (closed) {
          return;
        }
        closed = true;
        window.removeEventListener('keydown', handleEscape);
        overlay.remove();
        resolve(value || null);
      };

      closeButton.addEventListener('click', () => close(null));
      cancelButton.addEventListener('click', () => close(null));
      overlay.addEventListener('click', event => {
        if (event.target === overlay) {
          close(null);
        }
      });
      window.addEventListener('keydown', handleEscape);

      modal.append(header, body, footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const firstAction = options.querySelector('button');
      if (firstAction) {
        firstAction.focus();
      }
    });
  }

  function setupDebug() {
    const isDev = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!isDev) {
      return;
    }

    window.appDebug = {
      getState: () => ({ ...state }),
      reloadVideos: () => reloadCarousels(),
      clearCache: () => clearCarousels(),
      getCarousels: () => state.carousels
    };
  }

  async function initCategorySelector() {
    if (typeof window.CategorySelector !== 'function') {
      return;
    }

    state.categorySelector = new window.CategorySelector(api, async (channelId, category) => {
      const channel = state.channels.find(ch => ch.id === channelId);
      if (channel) {
        if (category) {
          channel.category = { category: category };
        } else {
          channel.category = null;
        }
      }
      renderChannelList(state.channels);
      if (state.categoryManager) {
        await state.categoryManager.init();
      }
    });

    await state.categorySelector.loadCategories();
    state.categoriesLoaded = true;
  }

  async function bootstrapAuthenticatedDevice() {
    if (typeof window.initDevice !== 'function') return;
    try {
      state.currentDevice = await window.initDevice();
    } catch (_) {
      // Retry once — session cookie may not be ready yet after account creation.
      await new Promise(r => setTimeout(r, 500));
      try {
        state.currentDevice = await window.initDevice();
      } catch (_2) { /* give up silently — next login will succeed */ }
    }
    if (typeof window.waitForDeviceConfirmation === 'function') {
      state.currentDevice = await window.waitForDeviceConfirmation();
    }
    if (window.ytcvAccountPanel && typeof window.getDeviceIdentifier === 'function') {
      window.ytcvAccountPanel.setCurrentDeviceIdentifier(window.getDeviceIdentifier());
    }
  }

  async function bootstrapAuthenticatedData() {
    if (state.authenticatedDataBootstrapPromise) {
      return state.authenticatedDataBootstrapPromise;
    }

    state.authenticatedDataBootstrapPromise = (async () => {
      await loadSettings();
      startQuotaPolling();
      const classificationResumePromise = resumeClassifyPollIfActive();
      await initCategorySelector();
      await loadApp();
      await classificationResumePromise;
    })()
      .finally(() => {
        state.authenticatedDataBootstrapPromise = null;
      });

    return state.authenticatedDataBootstrapPromise;
  }

  async function bootstrapAuthenticated() {
    await bootstrapAuthenticatedDevice();
    await bootstrapAuthenticatedData();
  }

  function consumeOnboardingReadyModalFlag() {
    const pendingGlobalFlag = window.__ytcvOnboardingReadyModalPending === true;
    if (pendingGlobalFlag) {
      window.__ytcvOnboardingReadyModalPending = false;
    }

    try {
      const pending = window.sessionStorage.getItem(ONBOARDING_READY_MODAL_KEY) === 'pending';
      if (pending) {
        window.sessionStorage.removeItem(ONBOARDING_READY_MODAL_KEY);
      }
      return pending || pendingGlobalFlag;
    } catch (error) {
      return pendingGlobalFlag;
    }
  }

  async function showOnboardingReadyModal() {
    return new Promise(resolve => {
      const overlay = document.createElement('section');
      overlay.className = 'confirm-modal-overlay';
      overlay.id = 'onboarding-ready-modal';

      const modal = document.createElement('div');
      modal.className = 'confirm-modal account-switcher-modal onboarding-ready-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'onboarding-ready-title');

      const header = document.createElement('header');
      header.className = 'confirm-modal__header';

      const title = document.createElement('h2');
      title.id = 'onboarding-ready-title';
      title.className = 'heading-2';
      title.textContent = t('onboardingReadyTitle');

      header.appendChild(title);

      const body = document.createElement('div');
      body.className = 'confirm-modal__body';

      const description = document.createElement('p');
      description.className = 'body';
      description.textContent = t('onboardingReadyDescription');

      const detail = document.createElement('p');
      detail.className = 'caption onboarding-ready-modal__detail';
      detail.textContent = t('onboardingReadyDetail');

      body.appendChild(description);
      body.appendChild(detail);

      const footer = document.createElement('footer');
      footer.className = 'confirm-modal__footer';

      const acceptButton = document.createElement('button');
      acceptButton.type = 'button';
      acceptButton.className = 'button account-switcher-modal__primary-action';
      acceptButton.textContent = t('onboardingReadyAccept');

      const close = () => {
        overlay.remove();
        resolve();
      };

      acceptButton.addEventListener('click', close);

      footer.appendChild(acceptButton);
      modal.appendChild(header);
      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      acceptButton.focus();
    });
  }

  async function waitForLoginPageToClose(maxWaitMs = 2000) {
    if (!window.ytcvLoginPage || typeof window.ytcvLoginPage.isVisible !== 'function') {
      return;
    }

    const startedAt = Date.now();
    while (window.ytcvLoginPage.isVisible()) {
      if (Date.now() - startedAt >= maxWaitMs) {
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 50));
    }
  }

  async function init() {
    if (typeof window.initTheme === 'function') {
      window.initTheme();
    }

    startBackendVersionPolling();

    if (typeof window.initAuth === 'function') {
      state.currentUser = await window.initAuth();
    }
    if (state.currentUser) {
      startRefreshStatusPoller();
      startQuotaPolling();
    }

    // Check for auth_status URL param before showing login page
    const authStatus = window.ytcvLoginPage ? window.ytcvLoginPage.checkAuthStatusParam() : null;

    if (!state.currentUser) {
      if (window.ytcvLoginPage) {
        const wizardOptions = authStatus === 'needs_setup' ? { wizard: true } : {};
        window.ytcvLoginPage.show(wizardOptions);
      }
    } else {
      if (authStatus === 'needs_setup' && window.ytcvLoginPage) {
        window.ytcvLoginPage.show({
          wizard: true,
          username: state.currentUser.username_suggestion || state.currentUser.username || ''
        });
        void bootstrapAuthenticatedData();
      } else if (window.ytcvLoginPage && typeof window.ytcvLoginPage.releaseAuthGate === 'function') {
        window.ytcvLoginPage.releaseAuthGate();
      }
    }
    setupFilters();
    setupOptionalCarouselToggles();
    setupChannelSidebarSearch();
    setupSearch();
    setupMenu();
    setupMobileSettingsView();
    setupFilterPanel();
    if (window.ytcvDesktopShell && typeof window.ytcvDesktopShell.initDesktopShell === 'function') {
      window.ytcvDesktopShell.initDesktopShell();
    }
    if (window.ytcvSidebarShell && typeof window.ytcvSidebarShell.initSidebarShell === 'function') {
      window.ytcvSidebarShell.initSidebarShell();
    }
    if (window.ytcvPhoneShell && typeof window.ytcvPhoneShell.initPhoneShell === 'function') {
      window.ytcvPhoneShell.initPhoneShell({
        onViewChange: view => {
          setMobileView(view);
        }
      });
    }
    if (window.ytcvTvShell && typeof window.ytcvTvShell.initTvShell === 'function') {
      window.ytcvTvShell.initTvShell({
        focusChannels: () => {
          if (ui.channelSearchInput) {
            ui.channelSearchInput.focus();
            return;
          }
          if (ui.channelList) {
            const firstItem = ui.channelList.querySelector('.channel-item');
            if (firstItem) {
              firstItem.focus();
            }
          }
        },
        openFilters: openFilterPanel,
        triggerRefresh: () => {
          if (ui.refreshButton) {
            ui.refreshButton.click();
          }
        },
        openDisplaySetup: () => {
          if (ui.menuDisplayMode) {
            ui.menuDisplayMode.click();
          }
        }
      });
    }
    setupGuide();
    setupSettingsModal();
    setupConfirmModal();
    setupLanguageMenu();
    setMobileView(state.mobileView);
    setupRefresh();
    setupImportButton();
    setupClassifyButton();
    setupKeyboardNavigation();
    setupDebug();
    window.addEventListener('layout-mode:changed', () => {
      setMobileView(state.mobileView);
    });
    startLastUpdatedTicker();

    window.addEventListener('ytcv:update-available', event => {
      showUpdateAvailableBanner(event.detail && event.detail.registration ? event.detail.registration : null);
    });
    if (ui.updateAvailableBanner) {
      ui.updateAvailableBanner.addEventListener('click', () => {
        applyUpdateAvailableBanner();
      });
    }
    refreshVersionUi().catch(() => {});

    if (state.currentUser && !state.deferAuthenticatedBootstrap) {
      await waitForLoginPageToClose();
      const showOnboardingReady = consumeOnboardingReadyModalFlag();
      if (showOnboardingReady) {
        const dataBootstrapPromise = bootstrapAuthenticatedData();
        await bootstrapAuthenticatedDevice();
        await showOnboardingReadyModal();
        await dataBootstrapPromise;
      } else {
        await bootstrapAuthenticated();
      }
    }
  }

  window.addEventListener('auth:changed', async event => {
    const user = event.detail ? event.detail.user : null;
    state.currentUser = user;

    if (user) {
      startLastUpdatedTicker();
      startRefreshStatusPoller();
      startQuotaPolling();
      if (state.deferAuthenticatedBootstrap) {
        return;
      }
      await waitForLoginPageToClose();
      const showOnboardingReady = consumeOnboardingReadyModalFlag();
      if (showOnboardingReady) {
        const dataBootstrapPromise = bootstrapAuthenticatedData();
        await bootstrapAuthenticatedDevice();
        await showOnboardingReadyModal();
        await dataBootstrapPromise;
        return;
      }
      await bootstrapAuthenticated();
    } else {
      stopLastUpdatedTicker();
      stopQuotaPolling();
      state.channels = [];
      state.selectedChannelId = null;
      state.selectedChannelYtId = null;
      state.selectedCategoryId = null;
      state.selectedCategoryName = '';
      state.authenticatedDataBootstrapPromise = null;
      clearRefreshStatusPoller();
      state.refreshStatusSource = null;
      setRefreshProgress('');
      clearCarousels();
      updateHeaderContext();
    }
  });

  window.addEventListener('onboarding:setup-completed', () => {
    state.deferAuthenticatedBootstrap = false;
  });

  init();
});
