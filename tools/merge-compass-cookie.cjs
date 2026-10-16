'use strict';
// Accept only the user's own exported cookie files; values are never printed.
const fs=require('node:fs');
const [inputFile,outputFile]=process.argv.slice(2);
if(!inputFile||!outputFile)throw Error('usage: node tools/merge-compass-cookie.cjs <cookies.json> <new-private-cookie-file>');
const input=JSON.parse(fs.readFileSync(inputFile,'utf8').replace(/^\uFEFF/,''));
const rows=Array.isArray(input)?input:input.cookies;
if(!Array.isArray(rows))throw Error('cookie_array_required');
const cookies=new Map();
for(const row of rows){
 if(!row||typeof row.name!=='string'||!row.name||typeof row.value!=='string'||/[;\r\n]/.test(row.name+row.value))throw Error('invalid_cookie');
 if(row.domain&&!/(^|\.)jinritemai\.com$/.test(row.domain.replace(/^\./,'')))continue;
 if(cookies.has(row.name)&&cookies.get(row.name)!==row.value)throw Error('conflicting_cookie_names_use_one_account');
 cookies.set(row.name,row.value);
}
if(!cookies.size)throw Error('no_matching_cookies');
fs.writeFileSync(outputFile,[...cookies].map(([name,value])=>name+'='+value).join('; '),{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({ok:true,cookie_count:cookies.size})+'\n');
