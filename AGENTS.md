# NDS web working contract

This repository owns the browser assembly and immutable app-shell artifact.
Shared Flutter presentation and the generated Rust bridge live in the desktop
repository. Reuse those packages; domain, identity, vault and sync rules remain
in their Rust owners. Browser JavaScript implements concrete browser I/O only.

Read standarts.lock, module.yaml and the locked engineering/workflow contracts.
Use the compiler in rust-toolchain.toml and the Flutter/Dart pins from Shared. Keep all assets same-origin and
CSP-compatible. Cache only manifest-verified static assets, never API responses.
Browser secrets stay in the protected accounts adapter, never Dart DTOs or logs.

Public code is AGPL-3.0-only. No credentials, private topology or runtime evidence.
Run actual browser offline acceptance as well as build/analysis; report exact
platform coverage. Signed work -> dev -> main PRs. No implicit release/deploy.
