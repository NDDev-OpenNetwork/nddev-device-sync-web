// BUILD and ASSETS are generated from the finished, self-hosted artifact.
const CACHE = 'nds-shell-' + BUILD;
const paths = new Set(ASSETS.map(asset => '/' + asset.path));
const ownedCache = /^nds-shell-[a-f0-9]{64}$/;
self.addEventListener('message', event => {
  if (event.data?.type === 'nds-shell-build' && event.ports.length === 1) {
    event.ports[0].postMessage({build: BUILD});
    event.ports[0].close();
  }
});
async function activeCache() {
  const active = self.registration.active;
  if (!active) return null;
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {channel.port1.close(); reject(new Error('active_build_unavailable'));}, 2000);
    channel.port1.onmessage = ({data}) => {
      clearTimeout(timer);
      channel.port1.close();
      if (!/^[a-f0-9]{64}$/.test(data?.build)) reject(new Error('active_build_invalid'));
      else resolve('nds-shell-' + data.build);
    };
    active.postMessage({type: 'nds-shell-build'}, [channel.port2]);
  });
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const retained = await activeCache();
  // A worker-only change has a different BUILD. Never write/delete the cache
  // serving a live client, even if installation subsequently fails.
  if (retained === CACHE) return;
  // Bound retention to the active build and this candidate. Superseded waiting
  // workers have no clients; old active data is never pruned during install.
  for (const key of await caches.keys()) {
    if (ownedCache.test(key) && key !== retained && key !== CACHE) await caches.delete(key);
  }
  const cache = await caches.open(CACHE);
  try {
    for (const asset of ASSETS) {
      const path = '/' + asset.path;
      const response = await fetch(path, {cache: 'no-store', credentials: 'omit', redirect: 'error'});
      if (!response.ok || response.type === 'opaque') throw new Error('asset_unavailable');
      const bytes = await response.clone().arrayBuffer();
      if (bytes.byteLength !== asset.bytes) throw new Error('asset_invalid');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sha256) throw new Error('asset_invalid');
      await cache.put(path, response);
    }
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  // No skipWaiting: an update cannot mix new assets into an active old client.
  for (const key of await caches.keys()) {
    if (ownedCache.test(key) && key !== CACHE) await caches.delete(key);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !paths.has(path)) return;
  event.respondWith((async () => {
    const response = await (await caches.open(CACHE)).match(path);
    // An evicted asset cannot safely be mixed with a newer deployment. Report
    // failure and let the next installation repair the complete version.
    return response || new Response(null, {status: 503});
  })());
});
