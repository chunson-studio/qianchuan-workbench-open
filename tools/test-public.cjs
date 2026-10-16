'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const requested=process.argv.slice(2);
const files=Object.keys(JSON.parse(fs.readFileSync(path.join(root,'PUBLIC_MANIFEST.json'),'utf8')).files);
const tests=requested.length?requested:files.filter(n=>/^(?:checks|tools)\/[^/]+\.test\.(?:cjs|mjs)$/.test(n)).sort();
const result=spawnSync(process.execPath,['checks/run-tests.cjs','--test-concurrency=4',...tests],{cwd:root,stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
