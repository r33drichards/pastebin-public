const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
(async()=>{
 let value='first', change, calls=[], timers=[], pending=[], unload;
 const status={dataset:{},addEventListener:(type,fn)=>status.retry=fn};
 const lang={value:'javascript',addEventListener:(type,fn)=>lang.change=fn};
 const context={console,URLSearchParams,setTimeout:fn=>{timers.push(fn);return fn},clearTimeout:fn=>{timers=timers.filter(x=>x!==fn)},document:{getElementById:id=>id==='saveStatus'?status:{classList:{remove(){}}}},window:{addEventListener:(type,fn)=>unload=fn},languageSelect:lang,isEditMode:false,updateFormatButtonVisibility(){},m:{getValue:()=>value,onDidChangeModelContent:fn=>change=fn,updateOptions:o=>assert.equal(o.readOnly,false)},fetch:(url,opts)=>{calls.push(Object.fromEntries(opts.body));return new Promise(resolve=>pending.push(resolve));}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('wordpress/pbin/tools/single-user-editor.js','utf8').replace('{{.ID}}','"test-id"').replace('{{.Title}}','"title"'),context);
 assert.equal(context.isEditMode,true);assert.equal(status.dataset.status,'saved');
 change();timers.shift()();assert.equal(calls.length,1);assert.equal(calls[0].text,'first');
 value='second';change();timers.shift()();assert.equal(calls.length,1,'serialize writes');
 pending.shift()({ok:true});await new Promise(setImmediate);timers.shift()();assert.equal(calls[1].text,'second');
 pending.shift()({ok:false,status:503});await new Promise(setImmediate);assert.equal(status.dataset.status,'error');
 let warned=false;unload({preventDefault(){warned=true}});assert.ok(warned);
 status.retry();pending.shift()({ok:true});await new Promise(setImmediate);assert.equal(status.dataset.status,'saved');
 lang.value='python';lang.change();timers.shift()();assert.equal(calls.at(-1).lang,'python');pending.shift()({ok:true});await new Promise(setImmediate);
 console.log('PASS single-user editing, serialized HTTP save, newer edits, failure/retry, unload protection, language save');
})().catch(e=>{console.error(e);process.exit(1)});
