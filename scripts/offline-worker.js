// BUILD and ASSETS are generated from the finished, self-hosted artifact.
const CACHE = 'nds-shell-' + BUILD;
const paths = new Map(ASSETS.map(asset => ['/' + asset.path, asset]));
const repairs = new Map();
const ownedCache = /^nds-shell-[a-f0-9]{64}$/;
self.addEventListener('message', event => {
  if (event.data?.type === 'nds-shell-build' && event.ports.length === 1) {
    event.ports[0].postMessage({build: BUILD});
    event.ports[0].close();
  }
});
async function workerCache(worker) {
  if (!worker) return null;
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {channel.port1.close(); reject(new Error('shell_build_unavailable'));}, 2000);
    channel.port1.onmessage = ({data}) => {
      clearTimeout(timer);
      channel.port1.close();
      if (!/^[a-f0-9]{64}$/.test(data?.build)) reject(new Error('shell_build_invalid'));
      else resolve('nds-shell-' + data.build);
    };
    worker.postMessage({type: 'nds-shell-build'}, [channel.port2]);
  });
}
async function verifiedAsset(path, asset) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal});
    if (!response.ok || response.type === 'opaque' || !response.body) throw new Error('asset_unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > asset.bytes) {await reader.cancel(); throw new Error('asset_invalid');}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    if (length !== asset.bytes) throw new Error('asset_invalid');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256) throw new Error('asset_invalid');
    const headers = new Headers(response.headers);
    // Fetch has already decoded any content encoding.
    headers.delete('content-encoding');headers.delete('content-length');
    return new Response(bytes, {status: response.status, headers});
  } finally {clearTimeout(timer);}
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const retained = new Set(await Promise.all([
    workerCache(self.registration.active), workerCache(self.registration.waiting),
  ]));
  // A worker-only change has a different BUILD. Never write/delete the cache
  // serving a live client, even if installation subsequently fails.
  if (retained.has(CACHE)) return;
  // A failed installation leaves the previous waiting worker registered. Its
  // verified cache must survive until activation too. Retain at most the
  // active, waiting and candidate caches. The next install prunes stale builds.
  for (const key of await caches.keys()) {
    if (ownedCache.test(key) && !retained.has(key) && key !== CACHE) await caches.delete(key);
  }
  const cache = await caches.open(CACHE);
  try {
    for (const asset of ASSETS) {
      const path = '/' + asset.path;
      const response = await verifiedAsset(path, asset);
      await cache.put(path, response);
    }
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
})()));
// No skipWaiting: an update cannot mix new assets into an active old client.
// Activation can overlap the next installation when the last client closes.
// Installation owns cache pruning; activation must not delete its candidate.
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !paths.has(path)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const response = await cache.match(path);
    if (response) return response;
    // Repair only the exact current build. A different deployment cannot be
    // mixed into this client, and failure never deletes its operational data.
    try {
      let pending = repairs.get(path);
      if (!pending) {
        if (repairs.size >= 16) throw new Error('asset_busy');
        pending = (async () => {
          try {
            const restored = await verifiedAsset(path, paths.get(path));
            await cache.put(path, restored.clone());
            return restored;
          } finally {repairs.delete(path);}
        })();
        repairs.set(path, pending);
      }
      return (await pending).clone();
    } catch {return new Response(null, {status: 503});}
  })());
});
