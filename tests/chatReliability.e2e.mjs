import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium } from 'playwright'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = `${root}/output/chat-reliability`
await mkdir(output, { recursive: true })
const fixture = `import {createApp,h,reactive} from 'vue';
import {createPinia} from 'pinia';
import {createRouter,createMemoryHistory} from 'vue-router';
import Conversation from '/src/components/content/ThreadConversation.vue';
import Composer from '/src/components/content/ThreadComposer.vue';
import {useComposerDraftStore} from '/src/stores/composerDrafts.ts';
import '/src/style.css';
const count=Number(new URLSearchParams(location.search).get('count')||2000);
const text='A useful result with **formatting**, a [link](https://example.com), and detail.\\n\\n'+Array.from({length:12},(_,i)=>'- Detail '+i+' describes the work, checks and next steps.').join('\\n');
const state=reactive({messages:Array.from({length:count},(_,i)=>({id:'message-'+i,role:i%3===0?'user':'assistant',text:i%3===0?'Request '+i:'Result '+i+'\\n\\n'+text,turnId:'turn-'+Math.floor(i/3),turnIndex:Math.floor(i/3)})), activeThreadId:'chat-1', submits:0});
window.fixture=state;
const pinia=createPinia();
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}},{path:'/thread/:threadId',name:'thread',component:{render:()=>null}}]});
const App={setup(){const store=useComposerDraftStore();window.drafts=store;return()=>h('div',{style:'height:100dvh;display:flex;flex-direction:column'},[h('div',{style:'min-height:0;flex:1;display:flex;flex-direction:column'},[h(Conversation,{messages:state.messages,pendingRequests:[],liveOverlay:null,isLoading:false,activeThreadId:state.activeThreadId,scrollState:null,automationProposals:[],automationTasks:[],onAddResponseAnnotation:(a)=>store.draftFor(state.activeThreadId).responseTextAnnotations.push(a)})]), h(Composer,{activeThreadId:state.activeThreadId,models:['gpt-6-astra'],selectedModel:'gpt-6-astra',selectedReasoningEffort:'low',disabled:false,isTurnInProgress:false,installedSkills:[],onSubmit:()=>state.submits++})])}};
createApp(App).use(pinia).use(router).mount('#app');
`
await writeFile(`${output}/fixture.js`, fixture)
await writeFile(`${output}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="/output/chat-reliability/fixture.js"></script></body></html>')
const server=await createServer({root,configFile:false,plugins:[vue(),tailwind()],resolve:{alias:{'@':`${root}/src`}},optimizeDeps:{include:['vue','pinia','vue-router']},server:{host:'127.0.0.1',port:4191,strictPort:true,watch:null}})
await server.listen();const browser=await chromium.launch({headless:true,args:['--js-flags=--expose-gc']});
const results = {};
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(() => {
   Object.defineProperty(navigator, 'mediaDevices', {value:{getUserMedia:async()=>{
     if(window.deferMicrophonePermission) await new Promise(resolve=>window.resolveMicrophonePermission=resolve);
     return {getTracks:()=>[{stop(){window.permissionTrackStops=(window.permissionTrackStops||0)+1}}]};
   }}});
   window.MediaRecorder=class {
     state='inactive';mimeType='audio/webm';
     start(){this.state='recording';window.audioRecordStarts=(window.audioRecordStarts||0)+1}
     stop(){this.state='inactive';setTimeout(()=>{this.ondataavailable?.({data:new Blob(['audio'],{type:'audio/webm'})});this.onstop?.()},0)}
   };
 });
 const start=Date.now();await page.goto('http://127.0.0.1:4191/output/chat-reliability/index.html?count=2000');
 await page.locator('.conversation-item').last().waitFor();await page.waitForTimeout(1000);
 const metrics=await page.evaluate(()=>{window.gc?.();return {dom:document.querySelectorAll('*').length,rendered:document.querySelectorAll('.message-body').length,shells:document.querySelectorAll('[data-virtualized]').length,heap:performance.memory?.usedJSHeapSize}});
 results.longChat={...metrics,loadMs:Date.now()-start};assert.ok(metrics.rendered<100);
 await page.screenshot({path:`${output}/long-chat-desktop.png`});
 await page.locator('.conversation-list').evaluate(el=>el.scrollTop=0);await page.getByText('Request 0',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();await page.waitForTimeout(400);
 assert.ok((await page.locator('.message-body').count())<100);
 // Use the visible native selection interaction before dictating an annotation.
 const selectLastAnswer=async()=>{
   await page.locator('[data-response-selection-surface]').last().evaluate(surface=>{
     surface.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));
     const range=document.createRange();range.selectNodeContents(surface.querySelector('p'));
     window.getSelection().removeAllRanges();window.getSelection().addRange(range);
     surface.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse'}));
   });
   await page.locator('[data-response-selection-add]').click();
 };
 await selectLastAnswer();
 let attempts=0;let finishTranscript;
 await page.route('**/codex-api/transcribe',async route=>{
   attempts++;
   if(attempts===1) await route.fulfill({status:500,body:'temporary error'});
   else {await new Promise(resolve=>finishTranscript=resolve);await route.fulfill({json:{text:'Please check the mobile layout too.'}})}
 });
 await page.getByRole('button',{name:'Dictate comment',exact:true}).click();
 await page.getByText('Recording… Stop when you’re ready.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Stop dictation',exact:true}).click();
 await page.getByRole('button',{name:'Retry transcription',exact:true}).click();
 await page.getByText('Transcribing…',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Add',exact:true}).isDisabled(),true);
 await page.locator('.conversation-list').click({position:{x:20,y:20}});
 assert.equal(await page.locator('[data-response-annotation-editor]').count(),1);
 finishTranscript();
 await page.getByText('Ready — review your words before sending.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Note',exact:true}).inputValue(),'Please check the mobile layout too.');
 assert.equal(await page.evaluate(()=>fixture.submits),0);
 await page.screenshot({path:`${output}/dictation-ready.png`});
 await page.getByRole('button',{name:'Add',exact:true}).click();
 assert.equal(await page.evaluate(()=>drafts.draftFor('chat-1').responseTextAnnotations[0].annotation),'Please check the mobile layout too.');
 assert.equal(await page.evaluate(()=>fixture.submits),0);
 // A transcription that finishes after changing chat belongs to the original draft.
 await selectLastAnswer();
 await page.getByRole('button',{name:'Dictate comment',exact:true}).click();
 await page.getByRole('button',{name:'Stop dictation',exact:true}).click();
 await page.getByText('Transcribing…',{exact:true}).waitFor();
 await page.evaluate(()=>fixture.activeThreadId='chat-2');
 finishTranscript();await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>drafts.draftFor('chat-1').responseTextAnnotations.length),2);
 assert.equal(await page.evaluate(()=>drafts.draftFor('chat-2').responseTextAnnotations.length),0);
 // Permission arriving after a chat switch must never start an invisible microphone.
 await selectLastAnswer();
 await page.getByRole('textbox',{name:'Note',exact:true}).fill('Keep this typed note.');
 const startsBeforePermission=await page.evaluate(()=>window.audioRecordStarts||0);
 await page.evaluate(()=>window.deferMicrophonePermission=true);
 await page.getByRole('button',{name:'Dictate comment',exact:true}).click();
 await page.getByText('Opening microphone…',{exact:true}).waitFor();
 await page.evaluate(()=>fixture.activeThreadId='chat-3');
 await page.evaluate(()=>window.resolveMicrophonePermission());
 await page.waitForTimeout(80);
 assert.equal(await page.evaluate(()=>window.audioRecordStarts||0),startsBeforePermission);
 assert.equal(await page.evaluate(()=>drafts.draftFor('chat-2').responseTextAnnotations[0].annotation),'Keep this typed note.');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:`${output}/long-chat-mobile.png`});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 results.dictation={retry:true,manualSend:true,chatSwitchPreserved:true,pendingPermissionCancelled:true};
 console.log(JSON.stringify(results,null,2));await writeFile(`${output}/smoke-results.json`,JSON.stringify(results,null,2));
 await page.close();
} finally {await browser.close();await server.close()}
