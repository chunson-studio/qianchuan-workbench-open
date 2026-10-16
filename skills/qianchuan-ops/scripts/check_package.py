"""Verify the public skill and its repository-relative documentation references."""
from pathlib import Path
import hashlib,json,re
from urllib.parse import unquote
root=Path(__file__).resolve().parents[1]
project=root.parents[1]
manifest=json.loads((root/'package-manifest.json').read_text(encoding='utf-8'))
for name,expected in manifest['files'].items():
    file=root/name
    if not file.resolve().is_relative_to(root) or file.is_symlink():raise ValueError('invalid_skill_path')
    data=file.read_bytes()
    if hashlib.sha256(data).hexdigest()!=expected:raise ValueError('skill_hash_mismatch:'+name)
    if file.suffix=='.md':
        for link in re.findall(r'\[[^\]\n]*\]\(([^)\n]+)\)',data.decode('utf-8')):
            link=unquote(link.split('#')[0].strip('<>'))
            if not link or re.match(r'^(https?:|mailto:)',link):continue
            target=(file.parent/link).resolve()
            if not target.is_relative_to(project) or not target.is_file():raise ValueError('skill_link_missing:'+name)
print(json.dumps({'ok':True,'files':len(manifest['files']),'live_account_verified':False}))
