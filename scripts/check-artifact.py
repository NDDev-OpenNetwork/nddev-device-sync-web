#!/usr/bin/env python3
"""Check the artifact's complete immutable file inventory and production source."""
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'nds-assets.json').read_text())
assert set(manifest) == {'schema_version', 'files'} and manifest['schema_version'] == 1
assert 1 <= len(manifest['files']) <= 4096
paths = set()
total = 0
for entry in manifest['files']:
    assert set(entry) == {'path', 'bytes', 'sha256'}
    name = entry['path']
    assert isinstance(name, str) and 0 < len(name) <= 512
    assert '\\' not in name and not name.startswith('/')
    assert all(part and not part.startswith('.') for part in name.split('/'))
    assert not name.startswith(('v1/', 'v2/')) and name != 'nds-assets.json'
    assert name not in paths
    paths.add(name)
    file = root / name
    assert file.is_file() and not file.is_symlink() and file.resolve().is_relative_to(root)
    data = file.read_bytes()
    assert len(data) == entry['bytes'] <= 64 * 1024 * 1024
    assert hashlib.sha256(data).hexdigest() == entry['sha256']
    total += len(data)
assert total <= 128 * 1024 * 1024
assert paths == {file.relative_to(root).as_posix() for file in root.rglob('*') if file.is_file() and file.name != 'nds-assets.json'}
assert {'index.html', 'nds-offline.js', 'nds-build.json', 'nds-vault-worker.js', 'pkg/nds_native.js', 'pkg/nds_native_bg.wasm', 'nddev-mark.svg'} <= paths
provenance = json.loads((root / 'nds-build.json').read_text())
assert provenance['development_http'] is False
assert re.fullmatch('[a-f0-9]{40}', provenance['shared_source_commit'])
assert re.fullmatch('[a-f0-9]{40}', provenance['assembly_source_commit'])
source = (Path(__file__).resolve().parent.parent / 'pubspec.yaml').read_text()
assert 'ref: ' + provenance['shared_source_commit'] in source
worker = (root / 'nds-offline.js').read_text()
assert 'skipWaiting(' not in worker
assert 'credentials: \'omit\'' in worker
assert not any(name.endswith(('.map', '.symbols')) for name in paths)
print(f'Validated {len(paths)} production assets, {total} bytes, immutable shared source and complete hashes')
