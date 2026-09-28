// Service worker para YT Clear View — estrategia cache-first para assets estáticos.
const CACHE_VERSION = 'ytcv-v169';
const STATIC_EXTENSIONS = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2', '.json'];

// Recursos precacheados en la instalación
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/gestor/index.html',
  '/config.js',
  '/css/main.css',
  '/css/mode-desktop-tablet.css',
  '/css/mode-tv.css',
  '/css/mode-phone.css',
  '/js/i18n.js',
  '/js/utils.js',
  '/js/api.js',
  '/js/passkey-auth.js',
  '/js/auth.js',
  '/js/device.js',
  '/js/gestor-app.js',
  '/js/layout-mode.js',
  '/js/login-page.js',
  '/js/account-panel.js',
  '/js/admin-page.js',
  '/js/app.js',
  '/i18n/en.json',
  '/i18n/es.json',
  '/manifest.json',
  '/favicon.svg',
];

function isStaticAsset(url) {
  const { pathname } = new URL(url);
  return STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

function isApiRequest(url) {
  const { pathname } = new URL(url);
  return pathname.startsWith('/api') || pathname.startsWith('/logs');
}

// Instalación: precachea los recursos principales (bypass HTTP cache para evitar
// servir ficheros obsoletos cuando Caddy usa immutable en assets estáticos)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      Promise.all(
        PRECACHE_URLS.map(url =>
          fetch(url, { cache: 'reload' }).then(res => {
            if (res.ok) return cache.put(url, res);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// Activación: limpia caches antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'SKIP_WAITING') {
    return;
  }
  self.skipWaiting();
});

// Fetch: cache-first para assets estáticos, network-only para API
self.addEventListener('fetch', event => {
  const { request } = event;

  // Solo intercepta GET
  if (request.method !== 'GET') {
    return;
  }

  // API y logs: siempre red
  if (isApiRequest(request.url)) {
    return;
  }

  // Assets estáticos: cache-first, fallback a red y actualiza cache
  if (isStaticAsset(request.url)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async cache => {
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        if (response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      })
    );
    return;
  }

  // HTML (navegación): network-first, fallback a cache
  event.respondWith(
    fetch(request).catch(async () => {
      const cachedIndex = await caches.match('/index.html');
      if (cachedIndex) {
        return cachedIndex;
      }
      return caches.match('/');
    })
  );
});
