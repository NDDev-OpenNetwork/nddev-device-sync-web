# NDS web

The browser assembly reuses `nds_ui` and the Rust `nds_native` bridge from the
desktop repository. Identity, vault encryption and replica rules stay in their
own Rust modules. JavaScript supplies browser I/O and static asset loading.

## Build

Use the Flutter/Dart pins from Shared and `rust-toolchain.toml` with the
`wasm32-unknown-unknown` target, and the `wasm-bindgen` CLI version recorded in the
shared Rust lockfile. Run `just check` and `just build`.

The worker acceptance uses the Node and Playwright versions pinned in `package.json`. Run
`npm ci --ignore-scripts`, then `npx playwright install chromium` and
`just worker-check`.
An existing Chromium executable can be selected with `NDS_TEST_CHROMIUM`. The
test owns an isolated browser context and loopback server; it exercises actual
updates, offline navigation, cache integrity, repair limits and timeouts.

The artifact is `build/web`. The NDS server verifies every file in
`nds-assets.json` before serving it from `NDS_WEB_ROOT`. Serve the application
and API at one HTTPS origin; no endpoint, bearer token or deployment secret is
embedded in the bundle. A `--development-http` build uses Rust's debug profile
and the existing loopback-only development feature for isolated acceptance.

The app shell caches only manifest-verified assets. Updates wait for old app
windows to close; an active client is never forcibly reloaded. Failed updates
preserve the previous waiting build too. Retention is bounded to three static
caches; each installation prunes older unreferenced builds. Activation preserves
a concurrent installation. Flutter assets, fonts and Rust/WASM are self-hosted
under the server's CSP.

## Offline boundary

The last verified session and device grant authorize local encrypted records
until the original session expires (at most eight hours). Changes remain in the
durable encrypted outbox until the server acknowledges them. Server sequence
and explicit conflict resolution determine convergence. Browser site-data
removal or storage eviction can remove unsynchronized data; persistent-storage
status and qualification are part of browser acceptance.

Session cookies are Secure/HttpOnly. The accounts adapter encrypts local key
material with a non-extractable browser wrapping key. Secrets are never returned
through the presentation bridge for clipboard copying. Native system tools
remain native capabilities.

Production browser qualification and release provenance must identify the exact
shared source, browser, storage, offline/reconnect and observability evidence.
A compile gate alone does not establish support for a browser.

AGPL-3.0-only · [NDDev OpenNetwork](https://nddev.ai)

Company administration and invitation verification reuse the selected Shared
Organizations/Accounts Rust client and presentation. Administrative changes are
online; an uncertain command can be retried without replacing its identity.
This remains the Flutter browser migration baseline until the React replacement
passes ADR 0010 acceptance. Invitation fragments are captured and cleared in Rust;
there is no token in a presentation DTO or persistent invitation cache.
