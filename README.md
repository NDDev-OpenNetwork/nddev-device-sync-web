# NDS web

The browser assembly reuses `nds_ui` and the Rust `nds_native` bridge from the
desktop repository. Identity, vault encryption and replica rules stay in their
own Rust modules. JavaScript supplies browser I/O and static asset loading.

## Build

Use Flutter 3.47.7 / Dart 3.13.5, Rust 1.99.0 with the
`wasm32-unknown-unknown` target, and the `wasm-bindgen` CLI version recorded in the
shared Rust lockfile. Run `just check` and `just build`.

The artifact is `build/web`. The NDS server verifies every file in
`nds-assets.json` before serving it from `NDS_WEB_ROOT`. Serve the application
and API at one HTTPS origin; no endpoint, bearer token or deployment secret is
embedded in the bundle. A `--development-http` build uses Rust's debug profile
and the existing loopback-only development feature for isolated acceptance.

The app shell caches only manifest-verified assets. Updates wait for old app
windows to close; an active client is never forcibly reloaded. Flutter assets,
fonts and Rust/WASM are self-hosted under the server's CSP.

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
