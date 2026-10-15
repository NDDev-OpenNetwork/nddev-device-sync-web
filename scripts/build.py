#!/usr/bin/env python3
"""Build one self-hosted Flutter/Rust artifact with verified offline assets."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent


def run(*args, cwd=ROOT, **kwargs):
    return subprocess.run(args, cwd=cwd, check=True, text=True, **kwargs)


def entries(output):
    result = []
    for file in sorted(output.rglob('*')):
        if not file.is_file() or file.name in ('nds-assets.json', 'nds-offline.js'):
            continue
        if file.is_symlink():
            raise ValueError('artifact symlink')
        data = file.read_bytes()
        result.append(dict(path=file.relative_to(output).as_posix(),
                           sha256=hashlib.sha256(data).hexdigest(), bytes=len(data)))
    if len(result) > 4094 or sum(x['bytes'] for x in result) > 126 * 1024 * 1024 or any(x['bytes'] > 64 * 1024 * 1024 for x in result):
        raise ValueError('artifact exceeds server bounds')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--development-http', action='store_true', help='isolated local fixture only')
    args = parser.parse_args()
    run('flutter', 'pub', 'get', '--enforce-lockfile')
    assembly = run('git', 'rev-parse', 'HEAD', capture_output=True).stdout.strip()
    if not args.development_http and run('git', 'status', '--porcelain', '--untracked-files=no', capture_output=True).stdout:
        raise ValueError('production assembly source must be committed')
    config_path = ROOT / '.dart_tool/package_config.json'
    config = json.loads(config_path.read_text())
    def package_root(name):
        package = next(p for p in config['packages'] if p['name'] == name)
        uri = urlparse(package['rootUri'])
        return Path(unquote(uri.path)) if uri.scheme == 'file' else (config_path.parent / unquote(uri.path)).resolve()
    native = package_root('nds_native')
    rust = native / 'rust'
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(native / 'tool'))
    from prepare_native import build_environment
    environment = build_environment(ROOT / 'build/nds-native')
    # Stable, single-threaded WASM: all bridge I/O is explicitly asynchronous.
    environment['CARGO_NET_GIT_FETCH_WITH_CLI'] = 'true'
    environment['CARGO_TARGET_DIR'] = str(ROOT / '.dart_tool/nds-rust')
    source = run('git', 'rev-parse', 'HEAD', cwd=rust, capture_output=True).stdout.strip()
    dirty = bool(run('git', 'status', '--porcelain', '--untracked-files=no', cwd=rust, capture_output=True).stdout)
    if dirty and not args.development_http:
        raise ValueError('production Rust source must be committed')
    environment['NDS_SOURCE_COMMIT'] = 'unknown' if dirty else source
    build = ['cargo', 'build', '--locked', '--lib', '--target', 'wasm32-unknown-unknown', '--jobs', '4']
    if args.development_http:
        build += ['--features', 'development-http']
    else:
        build += ['--release']
    run(*build, cwd=rust, env=environment)
    run('flutter', 'build', 'web', '--release', '--no-web-resources-cdn', '--csp', '--no-pub')
    output = ROOT / 'build/web'
    metadata = json.loads(run('cargo', 'metadata', '--locked', '--format-version', '1', cwd=rust, env=environment, capture_output=True).stdout)
    bindgen = next(p for p in metadata['packages'] if p['name'] == 'wasm-bindgen')['version']
    if run('wasm-bindgen', '--version', capture_output=True).stdout.strip() != 'wasm-bindgen ' + bindgen:
        raise ValueError('wasm-bindgen CLI must match Cargo.lock')
    # wasm-bindgen leaves superseded snippet directories in an existing output.
    # This directory is entirely generated; ship only this build's imports.
    if (output / 'pkg').exists():
        shutil.rmtree(output / 'pkg')
    run('wasm-bindgen', '--target', 'web', '--no-typescript', '--out-dir', str(output / 'pkg'),
        '--out-name', 'nds_native', str(Path(metadata['target_directory']) / ('wasm32-unknown-unknown/' + ('debug' if args.development_http else 'release') + '/nds_native.wasm')))
    vault = next(p for p in metadata['packages'] if p['name'] == 'nddev-device-sync-vault')
    shutil.copyfile(Path(vault['manifest_path']).parent / 'src/browser_worker.js', output / 'nds-vault-worker.js')
    # Flutter's optional legacy service-worker remover must not compete with ours.
    for name in ('flutter_service_worker.js', '.last_build_id'):
        (output / name).unlink(missing_ok=True)
    # The assembly explicitly selects the full CanvasKit renderer on every
    # browser. Do not precache unused Dart-WASM renderers or debug symbols.
    for file in (output / 'canvaskit').rglob('*'):
        if file.is_file() and file.relative_to(output / 'canvaskit').as_posix() not in ('canvaskit.js', 'canvaskit.wasm'):
            file.unlink()
    for pattern in ('*.map', '*.symbols'):
        for file in output.rglob(pattern):
            file.unlink()
    design = package_root('nddev_opennetwork_design_system').parent.parent
    shutil.copyfile(design / 'assets/nddev-mark.svg', output / 'nddev-mark.svg')
    flutter = json.loads(run('flutter', '--version', '--machine', capture_output=True).stdout)
    provenance = dict(schema_version=1, assembly_source_commit=assembly, shared_source_commit=environment['NDS_SOURCE_COMMIT'],
                      development_http=args.development_http, rust_target='wasm32-unknown-unknown',
                      flutter={key: flutter[key] for key in ('frameworkVersion', 'frameworkRevision', 'engineRevision', 'dartSdkVersion')},
                      rust=run('rustc', '--version', env=environment, capture_output=True).stdout.strip(),
                      wasm_bindgen=bindgen,
                      pubspec_lock_sha256=hashlib.sha256((ROOT / 'pubspec.lock').read_bytes()).hexdigest(),
                      rust_lock_sha256=hashlib.sha256((rust / 'Cargo.lock').read_bytes()).hexdigest())
    (output / 'nds-build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    assets = entries(output)
    serialized = json.dumps(assets, separators=(',', ':'))
    worker_source = (ROOT / 'scripts/offline-worker.js').read_text()
    build_id = hashlib.sha256(serialized.encode() + b'\0' + worker_source.encode()).hexdigest()
    worker = output / 'nds-offline.js'
    worker.write_text('const BUILD=' + json.dumps(build_id) + ';\nconst ASSETS=' + serialized + ';\n' +
                      worker_source)
    content = worker.read_bytes()
    assets.append(dict(path=worker.name, sha256=hashlib.sha256(content).hexdigest(), bytes=len(content)))
    (output / 'nds-assets.json').write_text(json.dumps(dict(schema_version=1, files=assets), indent=2) + '\n')
    print(json.dumps(dict(build=build_id, assets=len(assets), bytes=sum(x['bytes'] for x in assets),
                          development_http=args.development_http)))


if __name__ == '__main__':
    main()
