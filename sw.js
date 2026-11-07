const CACHE_NAME = 'vortex-jigsaw-pwa-v1';

const CORE_SHELL_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './manifest.webmanifest',
    './apple-touch-icon.png',
    './src/css/style.css',
    './src/js/audio.js',
    './src/js/puzzle_generator.js',
    './src/js/game.js',
    './assets/icons/favicon-32.png',
    './assets/icons/icon-152.png',
    './assets/icons/icon-167.png',
    './assets/icons/icon-180.png',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/silhouettes/silhouette.png',
    './assets/silhouettes/silhouettes_3x4.png',
    './assets/silhouettes/silhouettes_4x6.png',
    './assets/silhouettes/silhouettes_6x8.png',
    './assets/silhouettes/silhouettes_8x12.png',
    './assets/silhouettes/silhouettes_10x15.png',
    './assets/silhouettes/silhouettes_12x18.png',
    './assets/silhouettes/silhouettes_15x20.png',
    './assets/silhouettes/silhouettes_16x25.png'
];

const GALLERY_ASSETS = [
    './assets/images/golden_retriever.jpg',
    './assets/images/cute_cat.jpg',
    './assets/images/tiger_wildlife.jpg',
    './assets/images/colorful_macaw.jpg',
    './assets/images/nature_mountain.jpg',
    './assets/images/aurora_borealis.jpg',
    './assets/images/autumn_forest.jpg',
    './assets/images/waterfall_jungle.jpg',
    './assets/images/swiss_matterhorn.jpg',
    './assets/images/tropical_beach.jpg',
    './assets/images/cosmic_nebula.jpg',
    './assets/images/underwater_coral.jpg',
    './assets/images/japan_cherry_blossom.jpg',
    './assets/images/hot_air_balloons.jpg',
    './assets/images/venice_canals.jpg',
    './assets/images/historic_castle.jpg',
    './assets/images/ancient_pyramids.jpg',
    './assets/images/cozy_cottage.jpg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await cache.addAll(CORE_SHELL_ASSETS);
            // Pre-warm gallery motifs in background without blocking install if one fails
            await Promise.allSettled(GALLERY_ASSETS.map((url) => cache.add(url)));
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    const isStaticMedia =
        url.pathname.includes('/assets/') ||
        url.pathname.endsWith('.png') ||
        url.pathname.endsWith('.jpg') ||
        url.pathname.endsWith('.webp');

    if (isStaticMedia) {
        // Cache-First (ignoring ?v= cache-buster query string if needed) for instant asset loads & offline play
        event.respondWith(
            caches.open(CACHE_NAME).then(async (cache) => {
                const cached =
                    (await cache.match(req)) ||
                    (await cache.match(req, { ignoreSearch: true }));
                if (cached) return cached;

                try {
                    const fresh = await fetch(req);
                    if (fresh && fresh.ok) {
                        cache.put(req, fresh.clone());
                    }
                    return fresh;
                } catch (_) {
                    return Response.error();
                }
            })
        );
        return;
    }

    // Network-First for HTML/CSS/JS so live updates arrive immediately when online, with seamless offline fallback
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            try {
                const fresh = await fetch(req);
                if (fresh && fresh.ok) {
                    cache.put(req, fresh.clone());
                }
                return fresh;
            } catch (_) {
                return (
                    (await cache.match(req)) ||
                    (await cache.match(req, { ignoreSearch: true })) ||
                    (req.mode === 'navigate' ? await cache.match('./index.html') : Response.error())
                );
            }
        })
    );
});
