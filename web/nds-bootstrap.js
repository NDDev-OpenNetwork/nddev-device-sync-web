// The same pinned module is used by FRB and the dedicated vault worker.
// Preloading through ES modules avoids the upstream loader's dynamic eval.
let initialization;
globalThis.ndsInitializeRust = () => initialization ??= (async () => {
  const module = await import('./pkg/nds_native.js');
  await module.default();
  globalThis.wasm_bindgen = module;
})();

// Updates wait until the previous app is closed. Never force-reload a client
// with unsent work, and never cache an API response in the app shell.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/nds-offline.js', {scope: '/', updateViaCache: 'none'})
    .catch(() => console.warn('nds_offline_shell_unavailable'));
}
