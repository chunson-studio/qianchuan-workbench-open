'use strict';
const [base,account,room]=process.argv.slice(2);
if(!base||!account||!room)throw Error('usage: node tools/check-compass.cjs <local-service-url> <account-key> <room-id>');
const url=new URL('/api/compass/screen',base);
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('local_service_required');
url.search=new URLSearchParams({account,room_id:room,fresh:'1'}).toString();
fetch(url,{signal:AbortSignal.timeout(30000)}).then(async response=>{const data=await response.json();process.stdout.write(JSON.stringify({status:response.status,data})+'\n');}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
