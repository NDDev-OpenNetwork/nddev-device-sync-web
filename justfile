set shell := ["bash", "-euo", "pipefail", "-c"]

check:
    flutter pub get --enforce-lockfile
    dart format --output=none --set-exit-if-changed lib
    flutter analyze --no-pub

build:
    python3 scripts/build.py
