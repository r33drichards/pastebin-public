#!/usr/bin/env python3
"""Package pinned, untouched Effect ESM sources into one offline VFS asset.

Usage: python3 wordpress/tools/vendor-effect.py /path/to/effect-3.12.0.tgz
No downloads, npm installs, lifecycle scripts or upstream code execution occur.
Node's built-in parser enumerates static dependencies without evaluating them.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import posixpath
import re
import subprocess
import tarfile

VERSION = '3.12.0'
TARBALL = 'https://registry.npmjs.org/effect/-/effect-3.12.0.tgz'
INTEGRITY = 'sha512-b/u9s3b9HfTo0qygVouegP0hkbiuxRIeaCe1ppf8P88hPyl6lKCbErtn7Az4jG7LuU7f0Wgm4c8WXbMcL2j8+g=='
TARBALL_SHA256 = 'ce032d0785e27a0ee32dbf75561da4cc1b946c65c79cb4ca0b9c00ef093ec1cb'
NAMES = ['Effect', 'Tracer', 'Layer', 'Cause']
PREFIX = '/pbin/vendor/effect/3.12.0/'
ENTRY = '/pbin/effect@3.12.0'


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def generate(tarball):
    data = tarball.read_bytes()
    assert digest(data) == TARBALL_SHA256, 'unexpected npm archive SHA256'
    assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == INTEGRITY, 'npm SRI mismatch'
    with tarfile.open(tarball) as archive:
        # Read members in place. Never extract upstream paths or run scripts.
        regular = [item for item in archive.getmembers() if item.isfile()]
        members = {item.name: item for item in regular}
        assert len(members) == len(regular), 'duplicate archive member'
        read = lambda name: archive.extractfile(members[name]).read()
        package = json.loads(read('package/package.json'))
        assert package['name'] == 'effect' and package['version'] == VERSION
        assert package['license'] == 'MIT'
        sources = {name.removeprefix('package/dist/esm/'): read(name).decode()
                   for name in members if name.startswith('package/dist/esm/') and name.endswith('.js')}
        license_text = read('package/LICENSE')
        for name in NAMES:
            assert package['exports']['./' + name]['import'] == './dist/esm/' + name + '.js'

    parser = """
const fs = require('node:fs'), vm = require('node:vm');
const sources = JSON.parse(fs.readFileSync(0, 'utf8'));
const dependencies = Object.fromEntries(Object.entries(sources).map(([name, source]) =>
  [name, new vm.SourceTextModule(source, { identifier: name }).dependencySpecifiers]));
process.stdout.write(JSON.stringify(dependencies));
"""
    parsed = subprocess.run(['node', '--experimental-vm-modules', '-e', parser],
                            input=json.dumps(sources), text=True, capture_output=True, check=True)
    dependencies = json.loads(parsed.stdout)
    files, inventory = {}, {}
    queue = [name + '.js' for name in NAMES]
    while queue:
        name = queue.pop()
        if PREFIX + name in files:
            continue
        assert re.fullmatch(r'[A-Za-z0-9_./-]+\.js', name) and '..' not in name.split('/'), name
        source = sources[name]  # Missing transitive sources fail closed.
        # Conservative check: the pinned closure has no such calls, even in
        # comments. Reject future runtime-loading changes rather than omit them.
        assert not re.search(r'\b(?:import|require)(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*\(', source), name
        files[PREFIX + name] = source
        inventory['dist/esm/' + name] = digest(source.encode())
        for spec in dependencies[name]:
            assert spec.startswith('./') or spec.startswith('../'), (name, spec)
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), spec))
            assert not target.startswith('../') and target in sources, (name, spec)
            queue.append(target)
    files[ENTRY] = ''.join(f"export * as {name} from '{PREFIX}{name}.js';\n" for name in NAMES)
    bundle = encoded({'format': 'pbin-effect-vfs-1', 'version': VERSION, 'entry': ENTRY, 'files': files})
    provenance = encoded({
        'package': 'effect', 'version': VERSION, 'license': 'MIT',
        'source': TARBALL, 'registryMetadata': 'https://registry.npmjs.org/effect/3.12.0',
        'upstream': 'https://github.com/Effect-TS/effect/tree/effect%403.12.0/packages/effect',
        'npmIntegrity': INTEGRITY, 'tarballSha256': TARBALL_SHA256,
        'upstreamFiles': [{'path': name, 'sha256': inventory[name]} for name in sorted(inventory)],
        'upstreamModuleCount': len(inventory),
        'generatedFiles': {'modules.json': digest(bundle), 'LICENSE': digest(license_text)},
        'transform': 'None. Exact UTF-8 ESM sources plus a generated four-namespace entry module.',
    })
    return {'modules.json': bundle, 'provenance.json': provenance, 'LICENSE': license_text}


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('tarball', type=Path)
    cli.add_argument('--output', type=Path,
                     default=Path(__file__).resolve().parents[1] / 'pbin/static/vendor/effect/3.12.0')
    cli.add_argument('--check', action='store_true', help='Verify identical checked-in bytes without writing')
    args = cli.parse_args()
    generated = generate(args.tarball)
    for name, contents in generated.items():
        target = args.output / name
        if args.check:
            assert target.read_bytes() == contents, f'non-reproducible asset: {target}'
        else:
            args.output.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
    print(f'PASS: pinned Effect VFS assets, {len(generated["modules.json"])} bytes, exact npm SRI and source inventory')
