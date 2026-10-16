"""Package exactly the reviewed public manifest; never include runtime or Git files."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, zipfile

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path)
    p.add_argument('--check',action='store_true')
    args=p.parse_args()
    root=Path(__file__).resolve().parents[1]
    manifest=json.loads((root/'PUBLIC_MANIFEST.json').read_text(encoding='utf-8'))
    data={}
    for name,expected in manifest['files'].items():
        rel=PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts or '\\' in name or ':' in name:
            raise ValueError('invalid_manifest_path')
        current=root
        for part in rel.parts:
            current=current/part
            if current.is_symlink() or (hasattr(current,'is_junction') and current.is_junction()):
                raise ValueError('linked_manifest_entry')
        if any(x in rel.parts for x in ['private-runtime','work','.git','node_modules','account-profiles']):
            raise ValueError('private_manifest_path')
        value=current.read_bytes()
        if hashlib.sha256(value).hexdigest()!=expected:raise ValueError('manifest_hash_mismatch:'+name)
        data[name]=value
    data['PUBLIC_MANIFEST.json']=(root/'PUBLIC_MANIFEST.json').read_bytes()
    if args.check:
        print(json.dumps({'ok':True,'files':len(data)}));return
    if args.output is None or not args.output.is_absolute() or args.output.exists():
        raise ValueError('new_absolute_output_required')
    with zipfile.ZipFile(args.output,'x',compression=zipfile.ZIP_DEFLATED) as z:
        for name,value in sorted(data.items()):z.writestr('qianchuan-workbench-open/'+name,value)
    with zipfile.ZipFile(args.output) as z:
        if z.testzip() is not None:raise ValueError('archive_crc_failed')
    print(json.dumps({'ok':True,'files':len(data),'output':str(args.output)}))

if __name__=='__main__':main()
