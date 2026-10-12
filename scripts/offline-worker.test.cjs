// Real service-worker lifecycle, CacheStorage and network failure acceptance.
// The fixture supplies only synthetic immutable assets to the production worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {chromium} = require('playwright');

const source = fs.readFileSync(path.join(__dirname, 'offline-worker.js'), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
async function until(condition) {
  const deadline = Date.now() + 15000;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('browser lifecycle deadline exceeded');
    await delay(25);
  }
}
function artifact(version) {
  const assets = {'index.html': '<!doctype html><title>Owned shell</title><h1>Owned shell</h1>',
    'app.js': `/* owned version ${version} */`};
  for (let i = 0; i < 18; i++) assets[`asset-${i}.txt`] = `owned asset ${i} version ${version}`;
  const manifest = Object.entries(assets).map(([name, body]) => ({path: name, sha256: hash(body), bytes: Buffer.byteLength(body)}));
  const serialized = JSON.stringify(manifest);
  const worker = source + `\n// owned fixture version ${version}\n`;
  const build = hash(serialized + '\0' + worker);
  return {assets, build, worker: `const BUILD=${JSON.stringify(build)};\nconst ASSETS=${serialized};\n${worker}`};
}
async function currentCache(page) {
  return page.evaluate(async () => {
    const channel = new MessageChannel();
    const build = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {channel.port1.close(); reject(new Error('build deadline'));}, 2000);
      channel.port1.onmessage = ({data}) => {clearTimeout(timer); channel.port1.close(); resolve(data.build);};
      navigator.serviceWorker.controller.postMessage({type: 'nds-shell-build'}, [channel.port2]);
    });
    return 'nds-shell-' + build;
  });
}
async function evict(page, cache, names) {
  await page.evaluate(async ({cache, names}) => {
    const store = await caches.open(cache);
    for (const name of names) await store.delete('/' + name);
  }, {cache, names});
}
async function cached(page, cache, name) {
  return page.evaluate(async ({cache, name}) => !!await (await caches.open(cache)).match('/' + name), {cache, name});
}

test('offline updates preserve waiting and installing builds; repairs are verified and bounded', {timeout: 120000}, async t => {
  let phase = {version: 1};
  const counts = new Map();
  const timers = new Set();
  const server = http.createServer((request, response) => {
    const current = phase;
    const target = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const {assets, worker} = artifact(current.version);
    counts.set(target, (counts.get(target) || 0) + 1);
    let body = target === 'sw.js' ? worker : assets[target];
    if (target.startsWith('v2/')) body = JSON.stringify({observation: counts.get(target)});
    if (current.corrupt?.includes(target)) body = 'invalid owned fixture';
    const send = () => {
      if (response.destroyed) return;
      if (body === undefined) {response.writeHead(404).end(); return;}
      response.writeHead(200, {'Content-Type': target.endsWith('.js') ? 'text/javascript' : target.endsWith('.html') ? 'text/html' : 'text/plain',
        'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body)});
      response.end(body);
    };
    if (current.delay?.includes(target)) {
      const timer = setTimeout(() => {timers.delete(timer); send();}, current.milliseconds);
      timers.add(timer);
    } else send();
  });
  server.maxConnections = 32;
  server.requestTimeout = 25000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const deadline = setTimeout(() => browser?.close().catch(() => {}), 110000);
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.NDS_TEST_CHROMIUM || undefined});
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin);
    await page.evaluate(async () => {
      await caches.open('unrelated-cache');
      const request = indexedDB.open('owned-operational-data', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      await new Promise((resolve, reject) => {
        request.onerror = reject;
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put('preserved', 'marker');
          tx.oncomplete = () => {db.close(); resolve();}; tx.onerror = reject;
        };
      });
      globalThis.ownedRegistration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const firstCache = await currentCache(page);
    phase = {version: 2};
    await page.evaluate(() => ownedRegistration.update());
    await page.waitForFunction(() => ownedRegistration.waiting?.state === 'installed');
    const waitingCache = 'nds-shell-' + artifact(2).build;
    assert.equal(await page.evaluate(() => fetch('/app.js').then(r => r.text())), '/* owned version 1 */');
    phase = {version: 3, corrupt: ['app.js']};
    const failed = await page.evaluate(async () => {
      const changed = new Promise(resolve => ownedRegistration.addEventListener('updatefound', () => {
        const worker = ownedRegistration.installing;
        worker.addEventListener('statechange', () => {
          if (['installed', 'redundant'].includes(worker.state)) resolve(worker.state);
        });
      }, {once: true}));
      await ownedRegistration.update(); return changed;
    });
    assert.equal(failed, 'redundant');
    assert.equal(await cached(page, firstCache, 'app.js'), true);
    assert.equal(await cached(page, waitingCache, 'app.js'), true);
    t.diagnostic('failed third build preserves active and waiting caches');

    // Close the last client while a later install is still fetching an asset.
    // The previous waiting worker activates before that install has completed.
    const cdp = await context.newCDPSession(page), versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', ({versions: updates}) => {
      for (const row of updates) if (row.scriptURL === origin + '/sw.js') versions.set(row.versionId, row);
    });
    await cdp.send('ServiceWorker.enable');
    await until(() => [...versions.values()].some(v => v.status === 'installed'));
    const previous = new Set(versions.keys());
    phase = {version: 4, delay: ['app.js'], milliseconds: 2000};
    await page.evaluate(() => ownedRegistration.update());
    await page.waitForFunction(() => ownedRegistration.installing?.state === 'installing');
    await page.goto('about:blank');
    await until(() => [...versions.values()].some(v => !previous.has(v.versionId) && v.status === 'activated'));
    await context.setOffline(true);
    try {assert.equal((await page.goto(origin)).status(), 200);} finally {await context.setOffline(false);}
    assert.equal(await page.locator('h1').innerText(), 'Owned shell');
    const cache = await currentCache(page);
    assert.equal(cache, 'nds-shell-' + artifact(4).build);
    t.diagnostic('activation during the next install preserves its complete offline shell');

    phase = {version: 4, delay: ['asset-0.txt'], milliseconds: 500};
    await evict(page, cache, ['asset-0.txt']);
    const before = counts.get('asset-0.txt');
    assert.deepEqual(await page.evaluate(() => Promise.all(Array.from({length: 20}, () => fetch('/asset-0.txt').then(r => r.status)))), Array(20).fill(200));
    assert.equal(counts.get('asset-0.txt') - before, 1);
    const paths = Array.from({length: 17}, (_, i) => `asset-${i}.txt`);
    await evict(page, cache, paths);
    phase = {version: 4, delay: paths, milliseconds: 500};
    const statuses = await page.evaluate(paths => Promise.all(paths.map(name => fetch('/' + name).then(r => r.status))), paths);
    assert.equal(statuses.filter(s => s === 200).length, 16);
    assert.equal(statuses.filter(s => s === 503).length, 1);
    t.diagnostic('same-asset repairs coalesce; independent repairs admit 16 and reject excess');

    await evict(page, cache, ['app.js']);
    phase = {version: 99};
    assert.equal(await page.evaluate(() => fetch('/app.js').then(r => r.status)), 503);
    assert.equal(await cached(page, cache, 'app.js'), false);
    phase = {version: 4};
    assert.equal(await page.evaluate(() => fetch('/app.js').then(r => r.status)), 200);
    await evict(page, cache, ['asset-0.txt']);
    phase = {version: 4, delay: ['asset-0.txt'], milliseconds: 22000};
    const start = Date.now();
    assert.equal(await page.evaluate(() => fetch('/asset-0.txt').then(r => r.status)), 503);
    assert.ok(Date.now() - start >= 19000 && Date.now() - start < 25000);
    phase = {version: 4};
    assert.equal(await page.evaluate(() => fetch('/asset-0.txt').then(r => r.status)), 200);
    t.diagnostic('wrong-build bytes are rejected; the 20-second timeout releases repair admission');

    phase = {version: 5};
    await page.evaluate(async () => {
      globalThis.ownedRegistration = await navigator.serviceWorker.getRegistration();
      await ownedRegistration.update();
    });
    await page.waitForFunction(() => ownedRegistration.waiting?.state === 'installed');
    const retained = await page.evaluate(() => caches.keys());
    assert.deepEqual(retained.filter(k => k.startsWith('nds-shell-')).sort(), [cache, 'nds-shell-' + artifact(5).build].sort());
    assert.equal(await page.evaluate(() => fetch('/app.js').then(r => r.text())), '/* owned version 4 */');
    t.diagnostic('the next install removes stale builds while the active client keeps its version');

    const result = await page.evaluate(async () => {
      const a = await (await fetch('/v2/fixture')).text(), b = await (await fetch('/v2/fixture')).text();
      const keys = await caches.keys();
      const apiCached = await caches.match('/v2/fixture');
      const request = indexedDB.open('owned-operational-data');
      const marker = await new Promise((resolve, reject) => {
        request.onerror = reject; request.onsuccess = () => {
          const db = request.result, tx = db.transaction('records'), read = tx.objectStore('records').get('marker');
          read.onsuccess = () => resolve(read.result); read.onerror = reject; tx.oncomplete = () => db.close();
        };
      });
      return {different: a !== b, apiCached: !!apiCached, keys, marker};
    });
    assert.equal(result.different, true); assert.equal(result.apiCached, false);
    assert.equal(result.marker, 'preserved'); assert.ok(result.keys.includes('unrelated-cache'));
    assert.ok(result.keys.filter(k => k.startsWith('nds-shell-')).length <= 3);
    t.diagnostic('API stays uncached; operational IndexedDB and unrelated caches survive');
    await context.close();
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
