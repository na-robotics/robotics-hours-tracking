/**
 * Service worker for the Robotics Lab Attendance Tracker.
 *
 * Its one job is to keep the app SHELL available when the wifi drops, so the
 * tablet still boots into a working scanner and the offline queue can do its
 * job. It is not a general-purpose cache.
 *
 * ================== THE RULE THAT MATTERS ==================================
 *
 * API responses are NEVER cached. Not scans, not the roster, not a timesheet.
 *
 * A stale roster would merely show an old name. A stale SCAN RESPONSE would be
 * a lie: the tablet would tell a student "Goodbye, you're checked out" from a
 * cached reply while nothing was written to the sheet, and their hours would
 * quietly vanish. Worse, a cached response could make a failed scan look like a
 * successful one, so the offline queue would never fire and the scan would be
 * lost for good.
 *
 * This is enforced structurally rather than by a URL blocklist: the worker
 * handles only same-origin GET requests. The Apps Script Web App is on
 * script.google.com and every API call is a POST, so API traffic fails BOTH
 * tests and falls straight through to the network untouched. Drive photos are
 * cross-origin too, so they are never cached either.
 *
 * If you ever add same-origin API endpoints, this file has to change with them.
 * ===========================================================================
 */

// Bump this on release to retire the old cache. Anything cached under a
// previous version is deleted on activate.
// v3: admin rename. api.js is served stale-while-revalidate, so without this
// bump the new admin.html loads against the previously cached api.js and calls
// an admin.setName that isn't there yet.
// v4: scanner ROI. index.html's reticle and scanner.js's crop have to agree,
// and they are cached separately — a stale pair draws the box in one place and
// decodes another.
// v5: admin.getRoster grew an options argument before the request options. A
// stale api.js would swallow index.html's timeoutMs as the new argument, so
// the pair has to land together.
// v6: emails, summary tokens, rejected hours and manual entry. api.js changed
// shape in two ways that break silently against a stale page: enroll() gained
// an `email` argument in fourth position, where admin.html used to pass
// nothing and index.html now passes one, and submitSummary() takes an
// identifier object instead of a bare student id. A cached v5 api.js paired
// with a new summary.html would post `[object Object]` as a student id.
const VERSION = 'v8';
const CACHE = 'lab-shell-' + VERSION;

/** Everything needed to boot the scanner with no network at all. */
const SHELL = [
  './',
  './index.html',
  './admin.html',
  './summary.html',
  './css/styles.css',
  './js/api.js',
  './js/scanner.js',
  './js/vendor/jsqr.js',      // the iPad's only decode path — useless if it needs the network
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

/** Hosts that must never be served from cache, whatever else changes here. */
const NEVER_CACHE_HOSTS = ['script.google.com', 'googleusercontent.com', 'drive.google.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Added one at a time on purpose: cache.addAll rejects the whole install if
    // a single entry 404s, which would leave the tablet with no shell at all.
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] could not precache', url, err);
      }
    }));
    // Take over immediately. This is a wall tablet nobody thinks to reload.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => (name !== CACHE ? caches.delete(name) : null)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Writes are never cacheable, and every API call is a POST.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Checked before the origin test so it stays meaningful if that test is ever
  // loosened. The API and Drive must always reach the network.
  if (NEVER_CACHE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) return;

  // Anything not served from this site is none of our business.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/** Only ever store our own successful responses. */
function isCacheable(response) {
  return response && response.ok && response.type === 'basic';
}

/**
 * Pages: network first, so a deploy is picked up the moment the tablet is
 * online, and the cached copy is only a fallback. Cache-first here is how an
 * installed app gets stuck on last month's build forever.
 */
async function networkFirst(event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(event.request);
    if (isCacheable(response)) cache.put(event.request, response.clone());
    return response;
  } catch (err) {
    // ignoreSearch so summary.html?id=1234567 still matches the cached page.
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

/**
 * Static assets: serve the cached copy at once and refresh it in the
 * background, so a cold cabinet tablet starts instantly and still self-heals
 * after a deploy.
 */
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, { ignoreSearch: true });

  const networkFetch = fetch(event.request)
    .then((response) => {
      if (isCacheable(response)) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(networkFetch);      // keep the worker alive for the refresh
    return cached;
  }

  const response = await networkFetch;
  if (response) return response;
  return new Response('Offline and not cached', { status: 504, statusText: 'Offline' });
}
