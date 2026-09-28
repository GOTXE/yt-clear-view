// Infinite carousel component for video lists.

class Carousel {
  constructor(containerId, fetchFunction, options = {}) {
    this.containerId = containerId;
    this.fetchFunction = fetchFunction;
    this.t = (key, vars) => (
      window.ytcvI18n && typeof window.ytcvI18n.t === 'function'
        ? window.ytcvI18n.t(key, vars)
        : key
    );
    this.options = {
      gap: 20,
      showControls: true,
      theme: null,
      showTitle: true,
      showDescription: true,
      ...options
    };

    this.container = null;
    this.track = null;
    this.leftControl = null;
    this.rightControl = null;
    this.loadingIndicator = null;
    this.sentinel = null;
    this.offset = 0;
    this.limit = (window.APP_CONFIG && window.APP_CONFIG.VIDEOS_PER_LOAD) || 20;
    this.hasMore = true;
    this.loading = false;
    this.skeletons = [];

    this.thumbObserver = null;
    this.scrollObserver = null;

    this.onLeftClick = () => this.scrollLeft();
    this.onRightClick = () => this.scrollRight();
    this.onTrackKeydown = event => this.handleTrackKeydown(event);
    this.onResize = () => this.updateCardSizing();
    this.root = null;
    this.preservedChildren = [];
  }

  async init() {
    this.container = document.getElementById(this.containerId);
    if (!this.container) {
      return;
    }

    const preserveExisting = Boolean(this.options.preserveContentOnInit && this.container.childNodes.length);
    this.preservedChildren = preserveExisting ? Array.from(this.container.childNodes) : [];
    if (!preserveExisting) {
      this.container.innerHTML = '';
    }
    this.render();
    await this.loadMore();
    if (preserveExisting) {
      this.preservedChildren.forEach(node => node.remove());
      this.preservedChildren = [];
      if (this.root) {
        this.root.hidden = false;
      }
    }
    this.updateCardSizing();
    window.addEventListener('resize', this.onResize);
  }

  render() {
    if (!this.container) {
      return;
    }

    const carousel = document.createElement('div');
    carousel.className = 'carousel';
    this.root = carousel;
    if (this.options.theme) {
      carousel.dataset.themeColor = this.options.theme;
    }
    if (this.options.preserveContentOnInit && this.preservedChildren.length) {
      carousel.hidden = true;
    }

    if (this.options.showControls) {
      this.leftControl = document.createElement('button');
      this.leftControl.type = 'button';
      this.leftControl.className = 'carousel-control';
      this.leftControl.textContent = '◀';
      this.leftControl.setAttribute('aria-label', this.t('scrollLeft'));
      this.leftControl.addEventListener('click', this.onLeftClick);
      carousel.appendChild(this.leftControl);
    }

    this.track = document.createElement('div');
    this.track.className = 'carousel-track';
    this.track.tabIndex = 0;
    this.track.setAttribute('aria-label', this.t('videoCarousel'));
    this.track.addEventListener('keydown', this.onTrackKeydown);

    const gapToken = this.options.gap === 20
      ? 'var(--space-5)'
      : this.options.gap === 16
        ? 'var(--space-4)'
        : null;
    if (gapToken) {
      this.track.style.gap = gapToken;
    }

    carousel.appendChild(this.track);

    if (this.options.showControls) {
      this.rightControl = document.createElement('button');
      this.rightControl.type = 'button';
      this.rightControl.className = 'carousel-control';
      this.rightControl.textContent = '▶';
      this.rightControl.setAttribute('aria-label', this.t('scrollRight'));
      this.rightControl.addEventListener('click', this.onRightClick);
      carousel.appendChild(this.rightControl);
    }

    this.loadingIndicator = document.createElement('div');
    this.loadingIndicator.className = 'spinner';
    this.loadingIndicator.hidden = true;

    this.sentinel = document.createElement('div');
    this.sentinel.setAttribute('aria-hidden', 'true');

    this.track.appendChild(this.loadingIndicator);
    this.track.appendChild(this.sentinel);

    this.container.appendChild(carousel);

    this.setupObservers();
  }

  setupObservers() {
    if (!this.track || !this.sentinel) {
      return;
    }

    this.thumbObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) {
          return;
        }

        const target = entry.target;
        const src = target.getAttribute('data-src');
        if (src) {
          target.src = src;
          target.removeAttribute('data-src');
        }
        this.thumbObserver.unobserve(target);
      });
    }, { root: this.track, rootMargin: '150px' });

    this.scrollObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          this.loadMore();
        }
      });
    }, { root: this.track, rootMargin: '200px' });

    this.scrollObserver.observe(this.sentinel);
  }

  async loadMore() {
    if (this.loading || !this.hasMore || !this.fetchFunction) {
      return;
    }

    this.loading = true;
    this.loadingIndicator.hidden = false;
    this.renderSkeletons(3);

    let payload = null;
    try {
      payload = await this.fetchFunction(this.offset, this.limit);
    } catch (error) {
      payload = null;
    }

    const data = payload && payload.videos ? payload : payload && payload.data ? payload.data : null;

    this.clearSkeletons();

    if (!data || !Array.isArray(data.videos)) {
      this.loadingIndicator.hidden = true;
      this.loading = false;
      return;
    }

    if (!data.videos.length && this.offset === 0) {
      this.renderEmptyState();
    }

    data.videos.forEach(item => {
      const card = this.renderVideoCard(item);
      if (card) {
        this.track.insertBefore(card, this.loadingIndicator);
      }
    });

    this.hasMore = Boolean(data.has_more);
    if (typeof data.next_offset === 'number') {
      this.offset = data.next_offset;
    } else {
      this.offset = this.offset + this.limit;
    }

    if (!this.hasMore && this.sentinel) {
      this.scrollObserver.unobserve(this.sentinel);
      this.sentinel.remove();
    }

    this.updateCardSizing();
    this.loadingIndicator.hidden = true;
    this.loading = false;
  }

  renderSkeletons(count) {
    this.clearSkeletons();
    if (!this.track) {
      return;
    }

    for (let i = 0; i < count; i += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'video-card';
      skeleton.setAttribute('aria-hidden', 'true');
      skeleton.style.opacity = '0.6';

      const thumb = document.createElement('div');
      thumb.className = 'video-card__thumb';
      thumb.style.background = 'var(--border)';

      const body = document.createElement('div');
      body.className = 'video-card__body';

      const line = document.createElement('div');
      line.style.height = '16px';
      line.style.borderRadius = 'var(--radius-2)';
      line.style.background = 'var(--border)';

      body.appendChild(line);
      skeleton.appendChild(thumb);
      skeleton.appendChild(body);

      this.track.insertBefore(skeleton, this.loadingIndicator);
      this.skeletons.push(skeleton);
    }
  }

  clearSkeletons() {
    this.skeletons.forEach(node => node.remove());
    this.skeletons = [];
  }

  renderEmptyState() {
    if (!this.track) {
      return;
    }

    const message = document.createElement('p');
    message.className = 'caption';
    message.textContent = this.t('noVideosToDisplay');
    this.track.insertBefore(message, this.loadingIndicator);
  }

  renderVideoCard(item) {
    const video = item.video || {};
    const channel = item.channel || {};
    const watched = Boolean(item.watched);
    // Keep in sync with backend Config.SHORTS_MAX_DURATION_SECONDS (YouTube's
    // Shorts cap has been 3 minutes since 2024-10-15, not 60s).
    const isShort = typeof video.duration === 'number' && video.duration <= 180;
    const isPhoneMode = document.documentElement.dataset.mode === 'phone';
    const showTitle = this.options.showTitle && !(this.options.hideTextForShorts && isShort);
    const showDescription = this.options.showDescription && !(this.options.hideTextForShorts && isShort) && !isPhoneMode;

    const card = document.createElement('article');
    card.className = this.options.shortsLayout ? 'video-card video-card--vertical' : 'video-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    if (video.id != null) {
      card.dataset.videoId = String(video.id);
    }

    const title = video.title || 'Untitled video';
    card.setAttribute('aria-label', `Open ${title}`);

    const thumb = document.createElement('div');
    thumb.className = 'video-card__thumb';

    if (video.thumbnail_url) {
      const image = document.createElement('img');
      image.className = 'video-card__thumb-image';
      image.alt = title;
      image.loading = 'lazy';
      image.setAttribute('data-src', video.thumbnail_url);
      if (this.thumbObserver) {
        this.thumbObserver.observe(image);
      }
      thumb.appendChild(image);
    }

    // Progress bar for in-progress videos
    if (item.progress != null && video.duration > 0) {
      const ratio = Math.min(Math.max(item.progress / video.duration, 0), 1);
      const bar = document.createElement('div');
      bar.className = 'video-card__progress';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', Math.round(ratio * 100));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('div');
      fill.className = 'video-card__progress-fill';
      fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      bar.appendChild(fill);
      thumb.appendChild(bar);
    }

    const body = document.createElement('div');
    body.className = 'video-card__body';

    const channelEl = document.createElement('p');
    channelEl.className = 'video-card__meta video-card__channel';
    channelEl.textContent = channel.title || 'Unknown channel';

    const descriptionText = (video.description || '').trim();
    let truncatedDescription = descriptionText;
    if (descriptionText) {
      if (typeof window.truncateText === 'function') {
        truncatedDescription = window.truncateText(descriptionText, 140);
      } else if (descriptionText.length > 140) {
        truncatedDescription = `${descriptionText.slice(0, 137)}...`;
      }
    }

    const descriptionEl = document.createElement('p');
    descriptionEl.className = 'video-card__description';
    descriptionEl.textContent = truncatedDescription;

    const details = document.createElement('p');
    details.className = 'video-card__meta video-card__details';
    if (video.published_at) {
      if (typeof window.timeAgo === 'function') {
        details.textContent = window.timeAgo(video.published_at);
      } else {
        const publishedDate = new Date(video.published_at);
        if (!Number.isNaN(publishedDate.getTime())) {
          details.textContent = publishedDate.toLocaleDateString();
        }
      }
    }

    const durationText = this.formatDuration(video.duration);
    if (durationText) {
      const durationBadge = document.createElement('span');
      durationBadge.className = 'video-card__duration';
      durationBadge.textContent = durationText;
      thumb.appendChild(durationBadge);
    }

    if (watched) {
      this.applyWatchedState(card, details, false);
    }

    if (showTitle) {
      const titleEl = document.createElement('h3');
      titleEl.className = 'video-card__title';
      titleEl.textContent = title;
      body.appendChild(titleEl);
    }
    body.appendChild(channelEl);
    if (showDescription && truncatedDescription) {
      body.appendChild(descriptionEl);
    }
    if (details.textContent) {
      body.appendChild(details);
    }

    card.appendChild(thumb);
    card.appendChild(body);

    const handleActivate = () => {
      const videoId = video.yt_video_id;
      if (videoId) {
        const overlay = window.ytcvPlayerOverlay;
        if (overlay && typeof overlay.openVideoOverlay === 'function') {
          const openedInOverlay = overlay.openVideoOverlay({
            video,
            channel,
            watched,
            origin: card,
            progress: item.progress || null,
            continueWatching: Boolean(item.continue_watching),
            onMarkWatched: async () => {
              await this.markWatched(video, card, details, Boolean(durationText));
            }
          });

          if (openedInOverlay) {
            return;
          }
        }

        const url = typeof window.getYTVideoUrl === 'function'
          ? window.getYTVideoUrl(videoId)
          : `https://www.youtube.com/watch?v=${videoId}`;
        window.open(url, '_blank', 'noopener');
      }

      if (card.dataset.watched !== 'true') {
        this.markWatched(video, card, details, Boolean(durationText));
      }
    };

    card.addEventListener('click', handleActivate);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleActivate();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this.moveCardFocus(card, event.key === 'ArrowRight' ? 1 : -1);
      }
    });

    return card;
  }

  applyWatchedState(card, detailsElement, hasDuration) {
    card.dataset.watched = 'true';
    card.classList.add('video-card--watched');
    card.style.transition = 'opacity 0.3s ease';
    card.style.opacity = '0.7';

    const watchedTag = document.createElement('span');
    watchedTag.textContent = hasDuration ? ' • Watched' : 'Watched';
    watchedTag.style.color = 'var(--success)';
    detailsElement.appendChild(watchedTag);
  }

  async markWatched(video, card, detailsElement, hasDuration) {
    const api = window.appApiClient;
    if (!api || !video.id) {
      return;
    }

    const deviceId = typeof window.getDeviceId === 'function' ? window.getDeviceId() : null;
    const response = await api.markAsWatched(video.id, deviceId || undefined);
    if (!response.ok) {
      return;
    }

    if (card.dataset.watched !== 'true') {
      this.applyWatchedState(card, detailsElement, hasDuration || detailsElement.textContent.length > 0);
    }
  }

  removeVideoById(videoId) {
    if (!this.track || videoId == null) {
      return false;
    }

    const card = this.track.querySelector(`.video-card[data-video-id="${String(videoId)}"]`);
    if (!card) {
      return false;
    }

    card.remove();
    return true;
  }

  formatDuration(seconds) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
      return '';
    }

    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  handleTrackKeydown(event) {
    const active = document.activeElement;
    const activeCard = active && active.classList && active.classList.contains('video-card')
      ? active
      : null;

    if (activeCard && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      this.moveCardFocus(activeCard, event.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.scrollLeft();
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.scrollRight();
    }
  }

  moveCardFocus(currentCard, direction) {
    if (!this.track || !currentCard) {
      return;
    }

    const cards = Array.from(this.track.querySelectorAll('.video-card'));
    const currentIndex = cards.indexOf(currentCard);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= cards.length) {
      if (direction > 0) {
        this.scrollRight();
      } else {
        this.scrollLeft();
      }
      return;
    }

    const nextCard = cards[nextIndex];
    nextCard.focus();
    if (typeof nextCard.scrollIntoView === 'function') {
      nextCard.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }

  getVisibleCount() {
    const body = document.body;
    if (!body) {
      return 3;
    }

    // Shorts are vertical (9:16), so their cards are narrower than regular
    // 16:9 cards — fit more of them per row for a shelf that reads like
    // YouTube's own Shorts row instead of stretched-out video cards.
    if (this.options.shortsLayout) {
      if (body.classList.contains('device-tv')) {
        return 8;
      }
      if (body.classList.contains('device-tablet')) {
        return 5;
      }
      if (body.classList.contains('device-mobile')) {
        return 3;
      }
      return 6;
    }

    if (body.classList.contains('device-tv')) {
      return 5;
    }

    if (body.classList.contains('device-tablet')) {
      return 3;
    }

    if (body.classList.contains('device-mobile')) {
      return 2;
    }

    return 4;
  }

  updateCardSizing() {
    if (!this.track) {
      return;
    }

    const count = this.getVisibleCount();
    const gap = this.options.gap || 20;
    // Use px so cards overflow the track and scrollBy works correctly.
    // Percentage flex-basis is relative to the container's visible width,
    // which means cards never exceed 100% and nothing scrolls.
    const trackWidth = this.track.clientWidth || this.track.offsetWidth || 800;
    const totalGap = gap * (count - 1);
    const cardWidth = Math.floor((trackWidth - totalGap) / count);

    const cards = this.track.querySelectorAll('.video-card');
    cards.forEach(card => {
      card.style.flex = `0 0 ${cardWidth}px`;
      card.style.maxWidth = `${cardWidth}px`;
    });
  }

  scrollLeft() {
    if (!this.track) {
      return;
    }

    const amount = this.track.clientWidth;
    if (typeof this.track.scrollBy === 'function') {
      this.track.scrollBy({ left: -amount, behavior: 'smooth' });
    } else {
      this.track.scrollLeft -= amount;
    }
  }

  scrollRight() {
    if (!this.track) {
      return;
    }

    const amount = this.track.clientWidth;
    if (typeof this.track.scrollBy === 'function') {
      this.track.scrollBy({ left: amount, behavior: 'smooth' });
    } else {
      this.track.scrollLeft += amount;
    }
  }

  destroy(preserveDOM = false) {
    if (this.leftControl) {
      this.leftControl.removeEventListener('click', this.onLeftClick);
    }

    if (this.rightControl) {
      this.rightControl.removeEventListener('click', this.onRightClick);
    }

    if (this.track) {
      this.track.removeEventListener('keydown', this.onTrackKeydown);
    }

    window.removeEventListener('resize', this.onResize);

    if (this.thumbObserver) {
      this.thumbObserver.disconnect();
    }

    if (this.scrollObserver) {
      this.scrollObserver.disconnect();
    }

    if (this.container && !preserveDOM) {
      this.container.innerHTML = '';
    }
  }
}

window.Carousel = Carousel;
