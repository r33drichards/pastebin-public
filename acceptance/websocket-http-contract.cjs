// Black-box protocol contract: no imports from server or OT implementation.
const WebSocket=process.env.PBIN_WS_MODULE ? require(process.env.PBIN_WS_MODULE).ws : require('ws');
const assert=require('node:assert/strict');
const base=process.env.PBIN_ACCEPTANCE_URL;if(!base)throw Error('PBIN_ACCEPTANCE_URL required');
const connections=[];
const request=(path,opts)=>fetch(new URL(path,base),opts);
(async()=>{const result=await (async()=>{
  const r=await request('/paste',{method:'POST',body:new URLSearchParams({text:'',lang:'text'})});
  const id=new URL(r.url).searchParams.get('id');await r.arrayBuffer();
  async function client(key){
   const ws=new WebSocket((process.env.PBIN_ACCEPTANCE_WS_URL||base.replace(/^http/,'ws'))+'/collab?id='+id+'&key='+key, {origin:base});
   connections.push(ws);
   const queue=[];let wake;ws.onmessage=e=>{queue.push(JSON.parse(e.data));wake?.();};
   function take(type){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Timed out waiting for '+type+' for client '+key+' queue '+JSON.stringify(queue))),10000);
    function scan(){const i=queue.findIndex(m=>m.type===type);if(i>=0){clearTimeout(timer);resolve(queue.splice(i,1)[0]);}else wake=scan;}scan();
   });}
   return {ws,take,init:await take('init')};
  }
  const a=await client('a'),b=await client('b');await a.take('join');
  // Both edit the empty revision concurrently. Server must transform, not overwrite.
  a.ws.send(JSON.stringify({type:'op',rev:0,seq:1,op:['A😀']}));
  b.ws.send(JSON.stringify({type:'op',rev:0,seq:1,op:['B']}));
  await a.take('ack');await b.take('ack');await a.take('op');await b.take('op');
  const c=await client('c');const text=c.init.text;
  if(!text.includes('A😀')||!text.includes('B')||text.length!==4)throw Error('Concurrent insert lost data: '+text);
  // UTF-16 length: delete the astral character while preserving other content.
  const start=text.indexOf('😀');const op=[];if(start)op.push(start);op.push(-2);if(text.length-start-2)op.push(text.length-start-2);
  c.ws.send(JSON.stringify({type:'op',rev:c.init.rev,seq:1,op}));await c.take('ack');
  const expected=text.replace('😀','');
  a.ws.send(JSON.stringify({type:'lang',lang:'javascript'}));await b.take('lang');
  a.ws.send(JSON.stringify({type:'cursor',sel:{anchor:0,head:1}}));const cursor=await b.take('cursor');
  a.ws.close();await new Promise(r=>setTimeout(r,50));
  const resumed=await client('a');if(resumed.init.lastSeq!==1)throw Error('Reconnect sequence not retained');
  resumed.ws.send(JSON.stringify({type:'op',rev:resumed.init.rev,seq:1,op:[resumed.init.text.length]}));
  const duplicate=await resumed.take('error');if(!duplicate.error.includes('duplicate'))throw Error('Duplicate sequence accepted');
  resumed.ws.terminate();b.ws.close();c.ws.close();await new Promise(r=>setTimeout(r,100));
  const d=await client('d');
  const raw=await (await request('/paste?id='+id+'.txt')).text();
  const output={text:d.init.text,lang:d.init.lang,raw,expected,cursor:cursor.sel,initialPeerCount:b.init.peers.length};const put=await request('/paste',{method:'PUT',body:new URLSearchParams({id,text:'replacement via HTTP',lang:'python',title:'title'})});
  if(put.status!==200)throw Error('HTTP replacement failed');await put.arrayBuffer();
  await d.take('op');const e=await client('e');output.afterPut=e.init.text;output.putLang=e.init.lang;
  d.ws.close();e.ws.close();return output;
})();
 assert.equal(result.afterPut,'replacement via HTTP');assert.equal(result.putLang,'python');
 assert.equal(result.text,result.expected);assert.equal(result.raw,result.expected);assert.equal(result.lang,'javascript');assert.deepEqual(result.cursor,{anchor:0,head:1});assert.equal(result.initialPeerCount,1);
 console.log('PASS WebSocket: presence, concurrent insert, UTF-16 delete, cursor, language, last-close persistence/rejoin');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{for(const ws of connections)ws.terminate();});
