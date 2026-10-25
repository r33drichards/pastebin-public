// Black-box contract: no imports from either application implementation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.PBIN_ACCEPTANCE_URL;
if (!base) throw new Error('Set PBIN_ACCEPTANCE_URL to an isolated test instance');
const request = (path, options={}) => fetch(new URL(path,base), {redirect:'manual', ...options});
const form = (data,method='POST') => ({method,body:new URLSearchParams(data)});
async function create(text='original λ 😀\n',lang='javascript') {
 const r=await request('/paste',form({text,lang})); assert.equal(r.status,301);
 const location=r.headers.get('location'); assert.ok(location);
 const id=new URL(location,base).searchParams.get('id'); assert.match(id,/^[0-9a-f-]{36}$/);
 return {id,location,text,lang};
}
const raw = id => request('/paste?id='+encodeURIComponent(id)+'.txt');
test('health and isolation headers',async()=>{
 const r=await request('/health'); assert.equal(r.status,200); assert.equal(await r.text(),'OK');
 assert.equal(r.headers.get('cross-origin-opener-policy'),'same-origin');
 assert.equal(r.headers.get('cross-origin-embedder-policy'),'require-corp');
});
test('each root visit creates a distinct room; HEAD does not redirect',async()=>{
 const a=await request('/?lang=javascript'),b=await request('/?lang=javascript');
 assert.equal(a.status,303);assert.equal(a.headers.get('cache-control'),'no-store');
 assert.notEqual(a.headers.get('location'),b.headers.get('location'));
 assert.equal((await request('/',{method:'HEAD'})).headers.get('location'),null);
 const page=await request(a.headers.get('location'));assert.equal(page.status,200);
 assert.match(await page.text(),/value="javascript"/);
});
test('create, raw UTF-8, update and share page',async()=>{
 const p=await create();let r=await raw(p.id);assert.equal(r.status,200);
 assert.match(r.headers.get('content-type'),/^text\/plain/);assert.equal(await r.text(),p.text);
 r=await request('/paste',form({id:p.id,text:'changed\n😀',lang:'python',title:'<safe & title>'},'PUT'));
 assert.equal(r.status,200);assert.equal(await r.text(),'OK');assert.equal(await (await raw(p.id)).text(),'changed\n😀');
 const html=await (await request(p.location)).text();assert.match(html,/value="python"/);assert.ok(!html.includes('<title><safe'));
});
test('snapshot is immutable, accepts explicit empty live content, and is listed',async()=>{
 const p=await create('old');
 const r=await request('/snapshot',{...form({id:p.id,name:' checkpoint ',text:'',lang:'text'}),headers:{Accept:'application/json'}});
 assert.equal(r.status,200);const s=await r.json();assert.equal(s.pasteId,p.id);assert.equal(s.name,'checkpoint');
 assert.ok(Number.isFinite(Date.parse(s.created)));assert.notEqual(s.id,p.id);
 await request('/paste',form({id:p.id,text:'new',lang:'javascript'},'PUT'));
 assert.equal(await (await request('/snapshot?id='+s.id+'.txt')).text(),'');
 const list=await request('/snapshots?id='+p.id);assert.equal(list.status,200);assert.match(await list.text(),/checkpoint/);
 assert.equal((await request('/snapshot',form({}))).status,400);
 assert.equal((await request('/snapshot',form({id:'missing'}))).status,404);
});
test('diff persists both sides without inserting literal markup',async()=>{
 const r=await request('/diff',form({original:'before <script>alert(1)</script>',modified:'after λ'}));assert.equal(r.status,301);
 const page=await request(r.headers.get('location'));assert.equal(page.status,200);
 const text=await page.text();assert.ok(text.includes('before'));assert.ok(text.includes('after'));assert.ok(!text.includes('before <script>alert(1)</script>'));
});
test('markdown rendering sanitizes executable HTML',async()=>{
 const p=await create('# Heading\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))','markdown');
 const r=await request('/html?id='+p.id);assert.equal(r.status,200);const html=await r.text();
 assert.match(html,/<h1[^>]*>Heading/);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));
});
test('disabled completion and missing resources',async()=>{
 const c=await request('/complete');assert.equal(c.status,200);assert.equal((await c.json()).enabled,false);
 assert.equal((await request('/not-a-route')).status,404);
 assert.equal((await request('/paste',form({text:'no id'},'PUT'))).status,400);
 assert.equal((await request('/snapshot?id=missing')).status,404);
});
test('raw HTTP PUT accepts text beyond the live-editor limit with no active room',async()=>{
 const p=await create('small original','text');
 // No WebSocket is opened. The public raw-paste API is not subject to the
 // collaborative editor's 2 Mi UTF-16 code-unit document cap.
 const text='x'.repeat((2 << 20)+1)+'\nlarge raw paste end';
 const r=await request('/paste',form({id:p.id,text,lang:'text',title:'large raw paste'},'PUT'));
 assert.equal(r.status,200);assert.equal(await r.text(),'OK');
 const saved=await raw(p.id);assert.equal(saved.status,200);assert.equal(await saved.text(),text);
});
