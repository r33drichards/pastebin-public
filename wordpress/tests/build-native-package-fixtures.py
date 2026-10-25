#!/usr/bin/env python3
"""Generate native ZIP admission fixtures using the existing Python package contract."""
import argparse, copy, hashlib, importlib.util, io, json, pathlib, stat, struct, sys, tempfile, zipfile
p=argparse.ArgumentParser(); p.add_argument('--contract',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[1]/'tools'/'package.py');p.add_argument('--output',type=pathlib.Path,required=True);args=p.parse_args()
spec=importlib.util.spec_from_file_location('package',args.contract); contract=importlib.util.module_from_spec(spec);sys.modules['package']=contract;spec.loader.exec_module(contract)
out=args.output;out.mkdir(parents=True,exist_ok=True);revision='0123456789abcdef0123456789abcdef01234567'
files={'pbin/pbin.php':b'<?php // never executed\n','pbin/runtime.php':b'<?php // never executed either\n','pbin/static/binary.bin':bytes(range(256))*4,'pbin/static/empty.txt':b''}
def manifest(payload=files):return {'version':1,'revision':revision,'files':{n:{'sha256':hashlib.sha256(b).hexdigest(),'size':len(b)} for n,b in payload.items()}}
def archive(payload=files, raw_manifest=None, extras=(), compression=zipfile.ZIP_STORED, order=None, attrs=None):
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w',allowZip64=False) as z:
        entries=[('manifest.json',contract.canonical_json(manifest(payload)) if raw_manifest is None else raw_manifest)]+sorted(payload.items())+list(extras)
        if order=='reverse':entries=entries[::-1]
        for n,data in entries:
            i=contract._zip_info(n);i.compress_type=compression
            if attrs and n in attrs:i.external_attr=attrs[n]
            z.writestr(i,data)
    return b.getvalue()
index=[]
def save(name,data,ok=False,expected_revision=revision,expected_digest=None):
    path=out/(name+'.zip');path.write_bytes(data);index.append({'name':name,'file':path.name,'valid':ok,'revision':expected_revision,'artifact_sha256':expected_digest or hashlib.sha256(data).hexdigest()})
valid=archive();save('valid',valid,True)
# Assert byte identity with the real builder, not our fixture generator alone.
with tempfile.TemporaryDirectory() as t:
    root=pathlib.Path(t);source=root/'source';source.mkdir()
    for name,data in files.items():path=source/name.removeprefix('pbin/');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    contract.build_package(source,revision,root/'builder.zip');assert valid==(root/'builder.zip').read_bytes()
    contract.open_verified_package
    with contract.open_verified_package(root/'builder.zip',hashlib.sha256(valid).hexdigest()) as package:package.extract(out/'valid-tree')
manifest_bytes=contract.canonical_json(manifest());(out/'manifest.json').write_bytes(manifest_bytes)
(out/'valid-report.json').write_text(json.dumps({'revision':revision,'artifact_sha256':hashlib.sha256(valid).hexdigest(),'manifest_sha256':hashlib.sha256(manifest_bytes).hexdigest()}))
save('wrong-digest',valid,expected_digest='0'*64);save('wrong-revision',valid,expected_revision='f'*40)
save('truncated',valid[:-10]);save('trailing-junk',valid+b'junk');save('prefixed',b'junk'+valid)
save('deflated',archive(compression=zipfile.ZIP_DEFLATED));save('reversed-order',archive(order='reverse'))
save('duplicate',archive(extras=[('pbin/runtime.php',files['pbin/runtime.php'])]))
for name,path in [('traversal','pbin/../evil.php'),('absolute','/evil.php'),('backslash','pbin\\evil.php'),('colon','pbin/C:evil.php'),('double-slash','pbin//evil.php'),('control-plane','pbin/preview/controller.php'),('config','pbin/.user.ini'),('case-config','pbin/WP-CONFIG.PHP'),('dot','pbin/./evil.php'),('empty-name',''),('nonascii','pbin/caf\u00e9.php')]:save(name,archive(extras=[(path,b'bad')]))
save('case-collision',archive(extras=[('pbin/Runtime.php',b'bad')]))
save('file-directory-conflict',archive(extras=[('pbin/static',b'bad')]))
save('directory-entry',archive(extras=[('pbin/directory/',b'')]))
save('symlink',archive(attrs={'pbin/runtime.php':(stat.S_IFLNK|0o777)<<16}))
save('fifo',archive(attrs={'pbin/runtime.php':(stat.S_IFIFO|0o600)<<16}))
save('wrong-mode',archive(attrs={'pbin/runtime.php':(stat.S_IFREG|0o755)<<16}))
save('manifest-extra-field',archive(raw_manifest=contract.canonical_json({**manifest(),'extra':1})))
save('manifest-duplicate-key',archive(raw_manifest=manifest_bytes.replace(b'"version":1',b'"version":1,"version":1')))
save('manifest-noncanonical',archive(raw_manifest=json.dumps(manifest()).encode()))
m=manifest();m['files']['pbin/runtime.php']['sha256']='0'*64;save('payload-hash',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']+=1;save('payload-size',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']=2**31;save('wasm32-overflow',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']=33554433;save('file-limit',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']=True;save('boolean-size',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']=30.0;save('float-size',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']=-1;save('negative-size',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/runtime.php']['size']=33554432;m['files']['pbin/pbin.php']['size']=33554432;save('expanded-limit',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();del m['files']['pbin/runtime.php'];save('missing-entrypoint',archive(raw_manifest=contract.canonical_json(m)))
m=manifest();m['files']['pbin/absent.txt']={'sha256':'0'*64,'size':0};save('missing-payload',archive(raw_manifest=contract.canonical_json(m)))
save('extra-payload',archive(extras=[('pbin/extra.txt',b'extra')]))
# Raw metadata corruptions probe libzip consistency checks plus canonical rehashing.
for name,offset,value in [('local-name',30,b'X'),('local-flags',6,struct.pack('<H',8)),('local-method',8,struct.pack('<H',8)),('local-size',22,struct.pack('<I',2**31)),('local-time',10,struct.pack('<H',1)),('local-crc',14,b'\x00'*4)]:
    b=bytearray(valid);b[offset:offset+len(value)]=value;save(name,bytes(b))
central=valid.index(b'PK\x01\x02')
for name,offset,value in [('central-encrypted',8,struct.pack('<H',1)),('central-offset',42,struct.pack('<I',2**31)),('central-size',24,struct.pack('<I',2**31)),('central-time',12,struct.pack('<H',1)),('central-extra',30,struct.pack('<H',1))]:
    b=bytearray(valid);b[central+offset:central+offset+len(value)]=value;save(name,bytes(b))
b=bytearray(valid);b[-18:-16]=struct.pack('<H',1);save('multidisk',bytes(b))
b=io.BytesIO(valid)
with zipfile.ZipFile(b,'a') as z:z.comment=b'comment'
save('archive-comment',b.getvalue())
(out/'index.json').write_text(json.dumps(index,indent=2)+'\n')
print(json.dumps({'fixture_count':len(index),'valid_sha256':hashlib.sha256(valid).hexdigest(),'manifest_sha256':hashlib.sha256(manifest_bytes).hexdigest(),'directory':str(out)}))
