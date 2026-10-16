"""Wrap one hash-verified clean release as a private, local Codex plugin candidate."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import stat
import zipfile
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_release import privacy_check


def sha(data):
    return hashlib.sha256(data).hexdigest()


def packed_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def read_release(source, expected):
    raw = source.read_bytes()
    if sha(raw) != expected:
        raise ValueError('Source release SHA-256 mismatch')
    with zipfile.ZipFile(source) as archive:
        if archive.testzip() is not None:
            raise ValueError('Source ZIP CRC failed')
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)) or sum(entry.file_size for entry in entries) > 100_000_000:
            raise ValueError('Duplicate or oversized source archive')
        roots = set()
        files = {}
        for entry in entries:
            parts = PurePosixPath(entry.filename).parts
            if (len(parts) < 2 or entry.is_dir() or '\\' in entry.filename or ':' in entry.filename
                    or entry.filename.startswith('/') or any(p in ('.', '..') for p in parts)
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError('Unsafe source path')
            roots.add(parts[0])
            files['/'.join(parts[1:])] = archive.read(entry)
        if len(roots) != 1:
            raise ValueError('Source archive must have one root')
    manifest = json.loads(files['DELIVERY_MANIFEST.json'])
    if manifest.get('accounts') != 'empty' or manifest.get('public_release') is not False:
        raise ValueError('Source is not a clean internal candidate')
    if set(manifest['files']) != set(files) - {'DELIVERY_MANIFEST.json'}:
        raise ValueError('Source manifest coverage mismatch')
    for name, expected_file in manifest['files'].items():
        if sha(files[name]) != expected_file:
            raise ValueError('Source file digest mismatch: ' + name)
        privacy_check(name, files[name])
    return files, manifest


def build(source, expected, output):
    source_files, source_manifest = read_release(source, expected)
    # Existing project/global MCP settings are never installed as plugin settings.
    omitted = {'.mcp.json', 'DELIVERY_MANIFEST.json', 'PACKAGE_CONTENTS.txt'}
    files = {name: content for name, content in source_files.items() if name not in omitted}
    files['CORE_README.md'] = files.pop('README.md')
    core = {name: sha(content) for name, content in sorted(files.items())}
    payload_sha = sha(packed_json(core))
    template = ROOT / 'plugins' / 'codex'
    for name in ('plugin.json', 'bin/bridge.cjs', 'README.md'):
        data = (template / name).read_bytes()
        privacy_check(name, data)
        files[name] = data
    plugin = json.loads(files['plugin.json'])
    interface = plugin['extensions']['com.openai']['interface']
    if len(interface['shortDescription']) > 30:
        raise ValueError('Plugin subtitle exceeds 30 characters')
    overlay = {key: plugin[key] for key in ('name', 'version', 'description')}
    overlay.update({'skills': './skills/', 'interface': interface})
    files['.codex-plugin/plugin.json'] = packed_json(overlay)
    files['runtime-manifest.json'] = packed_json({'schema_version': 1, 'payload_sha256': payload_sha,
        'source_archive_sha256': expected, 'source_core_version': json.loads(source_files['server-app/package.json'])['version'],
        'files': core})
    files['SOURCE_RELEASE.json'] = packed_json({'schema_version': 1, 'source_archive_name': source.name,
        'source_archive_sha256': expected, 'source_file_count': len(source_files), 'source_manifest_verified': True,
        'original_manifest': source_manifest, 'omitted_paths': sorted(omitted), 'renamed_paths': {'README.md': 'CORE_README.md'},
        'private_candidate': True, 'commercial_license_added': False, 'source_protection': False})
    files['PLUGIN_MANIFEST.json'] = packed_json({'schema_version': 1, 'files': {name: sha(data) for name, data in sorted(files.items())},
        'manifest_excludes_self': True, 'source_archive_sha256': expected, 'plugin_version': plugin['version']})
    output.mkdir(parents=True, exist_ok=False)
    marketplace_root = output / 'marketplace'
    plugin_root = marketplace_root / 'plugins' / plugin['name']
    for name, content in files.items():
        target = plugin_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    marketplace = {'name': 'qianchuan-local', 'interface': {'displayName': '千川工作台 · 本地私发'},
        'plugins': [{'name': plugin['name'], 'source': {'source': 'local', 'path': './plugins/' + plugin['name']},
            'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Productivity'}]}
    market_path = marketplace_root / '.agents' / 'plugins' / 'marketplace.json'
    market_path.parent.mkdir(parents=True)
    market_path.write_bytes(packed_json(marketplace))
    archive_path = output / (plugin['name'] + '-' + plugin['version'] + '-local.zip')
    with zipfile.ZipFile(archive_path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(files.items()):
            archive.writestr(plugin['name'] + '/' + name, content)
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise ValueError('Plugin ZIP CRC failed')
        for name, content in files.items():
            if archive.read(plugin['name'] + '/' + name) != content:
                raise ValueError('Plugin ZIP content mismatch')
    installer_path = output / (plugin['name'] + '-' + plugin['version'] + '-installer.zip')
    installer_files = {'qianchuan-local/.agents/plugins/marketplace.json': packed_json(marketplace),
        'qianchuan-local/README.md': files['README.md']}
    installer_files.update({'qianchuan-local/plugins/' + plugin['name'] + '/' + name: content for name, content in files.items()})
    with zipfile.ZipFile(installer_path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(installer_files.items()):
            archive.writestr(name, content)
    with zipfile.ZipFile(installer_path) as archive:
        if archive.testzip() is not None or any(archive.read(name) != content for name, content in installer_files.items()):
            raise ValueError('Installer ZIP verification failed')
    result = {'ok': True, 'plugin_version': plugin['version'], 'source_archive_sha256': expected,
        'payload_sha256': payload_sha, 'archive': str(archive_path), 'archive_sha256': sha(archive_path.read_bytes()),
        'archive_bytes': archive_path.stat().st_size, 'file_count': len(files), 'plugin_root': str(plugin_root),
        'marketplace_root': str(marketplace_root), 'source_skill_unchanged': files['skills/qianchuan-ops/SKILL.md'] == source_files['skills/qianchuan-ops/SKILL.md'],
        'installer_archive': str(installer_path), 'installer_sha256': sha(installer_path.read_bytes()), 'installer_bytes': installer_path.stat().st_size,
        'installation_verified': False, 'live_account_verified': False, 'commercial_license_added': False, 'source_protection': False}
    (output / 'build.json').write_bytes(packed_json(result))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.source.resolve(), args.sha256, args.output.resolve()), ensure_ascii=False))
