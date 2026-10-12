#!/usr/bin/env python3
"""Resolve the single immutable shared UI dependency used to bootstrap CI."""
import os
from pathlib import Path
import re

source = Path('pubspec.yaml').read_text()
if 'url: https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync-desktop.git' not in source:
    raise SystemExit('Publish and pin the reviewed shared desktop package before CI delivery')
refs = re.findall(r'^\s+ref: ([a-f0-9]{40})\s*$', source, re.MULTILINE)
if len(refs) != 1 or 'path: packages/nds_ui' not in source:
    raise SystemExit('Expected one immutable shared UI source')
with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
    output.write('sha=' + refs[0] + '\n')
