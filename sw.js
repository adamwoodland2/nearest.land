// Service worker for nearest.land (same pattern as orrery.live / quickresponse.now).
//
//  - Code, data and navigations: NETWORK-FIRST, cache fallback. The 3.7 MB country
//    dataset and three.js are precached so the whole globe works offline once loaded.
//  - Images: CACHE-FIRST.
//  - Bump CACHE on deploys that change any precached file.
const CACHE = 'nl-v17';
const CORE = [
	'/',
	'/index.html',
	'/styles.css',
	'/app.js',
	'/lib/three.module.js',
	'/lib/three.core.js',
	'/lib/jsm/controls/OrbitControls.js',
	'/lib/topojson-client.min.js',
	'/data/countries-10m.json',
	'/favicon.svg',
	'/manifest.json'
];

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

	if (req.destination === 'image') {
		e.respondWith(
			caches.open(CACHE).then(async (c) => {
				const hit = await c.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				if (res.ok) c.put(req, res.clone());
				return res;
			})
		);
		return;
	}

	e.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
				return res;
			})
			.catch(async () => {
				const hit = await caches.match(req);
				if (hit) return hit;
				if (req.mode === 'navigate') { const shell = await caches.match('/index.html'); if (shell) return shell; }
				return Response.error();
			})
	);
});
