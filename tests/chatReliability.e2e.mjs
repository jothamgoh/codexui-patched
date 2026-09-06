import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { chromium, webkit } from 'playwright'
const root = fileURLToPath(new URL('..', import.meta.url))
const engine=process.env.CODEXUI_CHAT_ENGINE==='webkit'?'webkit':'chromium'
const output = `${root}/output/chat-reliability${engine==='webkit'?'-webkit':''}`
await mkdir(output, { recursive: true })
const fixture = `import {createApp,h,reactive} from 'vue';
import {createPinia} from 'pinia';
import {createRouter,createMemoryHistory} from 'vue-router';
import Conversation from '/src/components/content/ThreadConversation.vue';
import Composer from '/src/components/content/ThreadComposer.vue';
import {useComposerDraftStore} from '/src/stores/composerDrafts.ts';
import {normalizeThreadMessagesV2} from '/src/api/normalizers/v2.ts';
import '/src/style.css';
const count=Number(new URLSearchParams(location.search).get('count')||2000);
const text='A useful result with **formatting**, a [link](https://example.com), and detail.\\n\\n'+Array.from({length:12},(_,i)=>'- Detail '+i+' describes the work, checks and next steps.').join('\\n');
const state=reactive({messages:Array.from({length:count},(_,i)=>({id:'message-'+i,role:i%3===0?'user':'assistant',text:i%3===0?'Request '+i:'Result '+i+'\\n\\n'+text,turnId:'turn-'+Math.floor(i/3),turnIndex:Math.floor(i/3)})), activeThreadId:'chat-1', submits:0,loading:true,pending:[],overlay:null,replies:[]});
setTimeout(()=>{state.loading=false},75);
window.fixture=state;
window.loadActivityHistory=(items)=>{state.live=false;state.activeThreadId='chat-1';state.messages=normalizeThreadMessagesV2({thread:{cwd:'/project',turns:[{id:'activity-turn',status:'completed',items}]}})};
window.startActivityStream=async()=>{const {useDesktopState}=await import('/src/composables/useDesktopState.ts');window.desktop=useDesktopState();desktop.selectedThreadId.value='chat-1';desktop.startPolling();state.live=true};
const pinia=createPinia();
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}},{path:'/thread/:threadId',name:'thread',component:{render:()=>null}}]});
window.fixtureRouter=router;
const App={setup(){const store=useComposerDraftStore();window.drafts=store;return()=>h('div',{style:'height:100dvh;display:flex;flex-direction:column'},[h('div',{style:'min-height:0;flex:1;display:flex;flex-direction:column'},[h(Conversation,{messages:state.live?desktop.messages.value:state.messages,pendingRequests:state.pending,liveOverlay:state.overlay,isLoading:state.loading,activeThreadId:state.activeThreadId,scrollState:null,automationProposals:[],automationTasks:[],onRespondServerRequest:(reply)=>{state.replies.push(reply);state.pending.find(request=>request.id===reply.id).replyState='sending'},onAddResponseAnnotation:(a)=>store.draftFor(state.activeThreadId).responseTextAnnotations.push(a)})]), h(Composer,{activeThreadId:state.activeThreadId,models:['gpt-6-astra'],selectedModel:'gpt-6-astra',selectedReasoningEffort:'low',disabled:false,isTurnInProgress:false,installedSkills:[],onSubmit:()=>state.submits++})])}};
createApp(App).use(pinia).use(router).mount('#app');
`
await writeFile(`${output}/fixture.js`, fixture)
await writeFile(`${output}/index.html`, `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="app"></div><script type="module" src="${output.slice(root.length)}/fixture.js"></script></body></html>`)
const server=await createServer({root,configFile:false,plugins:[vue(),tailwind()],resolve:{alias:{'@':`${root}/src`}},optimizeDeps:{include:['vue','pinia','vue-router']},server:{host:'127.0.0.1',port:4191,strictPort:true,watch:null}})
await server.listen();const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{args:['--js-flags=--expose-gc']}: {})});
const results = {};
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(() => {
   // Real geometry with delayed observer delivery reproduces the records a busy
   // browser can batch while moving away from, then back to, the latest reply.
   const NativeIntersectionObserver=window.IntersectionObserver;
   window.pendingIntersections=[];
   window.IntersectionObserver=class extends NativeIntersectionObserver {
     constructor(callback, options) {
       const pending=[];
       super((entries, observer)=>{
         if(window.holdIntersections) pending.push(...entries);
         else callback(entries, observer);
       }, options);
       window.pendingIntersections.push(()=>{if(pending.length) callback(pending.splice(0),this)});
     }
   };
   window.EventSource=class {constructor(){window.activityStream=this} close(){}};
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
 const start=Date.now();await page.goto('http://127.0.0.1:4191'+output.slice(root.length)+'/index.html?count=2000');
 await page.locator('.conversation-item').last().waitFor();await page.waitForTimeout(1000);
 const metrics=await page.evaluate(()=>{window.gc?.();return {dom:document.querySelectorAll('*').length,rendered:document.querySelectorAll('.message-body').length,shells:document.querySelectorAll('[data-virtualized]').length,heap:performance.memory?.usedJSHeapSize}});
 results.longChat={...metrics,loadMs:Date.now()-start};assert.ok(metrics.rendered<100);
 await page.screenshot({path:`${output}/long-chat-desktop.png`});
 await page.locator('.conversation-list').evaluate(el=>el.scrollTop=0);await page.getByText('Request 0',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();await page.waitForTimeout(400);
 assert.ok((await page.locator('.message-body').count())<100);
 // Latest text must remain inside the actual scroll viewport after history
 // remounts, resize, chat switching and a burst of live items.
 const assertLatestVisible=async()=>{
   try { await page.waitForFunction(()=>{
     const list=document.querySelector('.conversation-list');
     const rows=[...list.querySelectorAll('.conversation-item')];
     const last=rows.at(-1);
     const body=last?.querySelector('.message-body');
     if(!body?.textContent?.trim()) return false;
     const a=body.getBoundingClientRect(),b=list.getBoundingClientRect();
     return a.bottom>b.top && a.top<b.bottom && list.scrollHeight-list.scrollTop-list.clientHeight<24;
   },null,{timeout:5000}); } catch(error) {
     await page.screenshot({path:`${output}/latest-not-visible.png`});
     console.log('Tail layout failure', JSON.stringify(await page.locator('.conversation-list').evaluate(list=>({
       top:list.scrollTop,height:list.scrollHeight,viewport:list.clientHeight,
       rows:[...list.querySelectorAll('.conversation-item')].slice(-5).map(row=>({
         top:row.getBoundingClientRect().top,height:row.getBoundingClientRect().height,
         virtual:row.dataset.virtualized,textLength:row.textContent.trim().length,style:row.getAttribute('style'),
       })),
     })),null,2));
     throw error;
   }
 };
 await assertLatestVisible();
 for(let reload=0;reload<3;reload++) {
   await page.reload();
   await page.locator('.conversation-item').last().waitFor();
   await assertLatestVisible();
   const finalAnswer=page.locator('[data-response-message-id="message-1999"]');
   assert.match(await finalAnswer.innerText(),/Detail 11 describes the work, checks and next steps\./);
   assert.equal(await finalAnswer.locator('strong').innerText(),'formatting');
   assert.ok((await page.locator('.message-body').count())<100);
 }
 results.reload={attempts:3,fullFinalText:true,formatting:true,boundedBodies:true};
 await page.evaluate(()=>window.holdIntersections=true);
 await page.locator('.conversation-list').evaluate(el=>el.scrollTop=0);
 await page.waitForTimeout(150);
 await page.locator('.conversation-list').evaluate(el=>el.scrollTop=el.scrollHeight);
 await page.waitForTimeout(150);
 await page.evaluate(()=>{window.holdIntersections=false;window.pendingIntersections.forEach(flush=>flush())});
 await assertLatestVisible();
 assert.match(await page.locator('[data-response-message-id="message-1999"]').innerText(),/Detail 11/);
 results.reload.batchedVisibility=true;
 // An approval must stay actionable while slow history loading replaces the
 // transcript, and remain at the tail after virtualized history settles.
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{
   window.approvalHistory=fixture.messages;
   fixture.pending=[{id:812,method:'item/commandExecution/requestApproval',threadId:'chat-1',turnId:'approval-turn',itemId:'approval-command',receivedAtIso:new Date().toISOString(),params:{availableDecisions:['accept',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['npm','test']}},'cancel'],command:'npm test -- --runInBand --testPathPattern=tests/meaningful-combined-feature-regression.test.ts',cwd:'/fixture/project/long-directory-for-the-combined-feature-check',reason:'Run the combined feature checks before marking this work ready.'}}];
   fixture.overlay={activityLabel:'Thinking',activityDetails:[],reasoningText:'',errorText:''};
 });
 const approval=page.locator('.request-card');
 const assertApprovalAtTail=async()=>{
   await page.waitForFunction(()=>{
     const list=document.querySelector('.conversation-list'),card=list?.querySelector('.request-card');
     if(!card) return false;
     const a=card.getBoundingClientRect(),b=list.getBoundingClientRect();
     return a.top>=b.top && a.bottom<=b.bottom && list.scrollHeight-list.scrollTop-list.clientHeight<24;
   });
   assert.equal(await page.locator('.live-overlay-inline').count(),0);
   assert.equal(await approval.getByRole('button',{name:'Accept',exact:true}).isVisible(),true);
 };
 await assertApprovalAtTail();
 await page.evaluate(()=>{fixture.loading=true;fixture.messages=[]});
 await assertApprovalAtTail();
 assert.equal(await page.locator('.conversation-loading').count(),0,'History loading must not replace the pending approval');
 assert.equal(await approval.getByRole('button',{name:'Accept for Session',exact:true}).count(),0);
 assert.equal(await approval.getByRole('button',{name:'Decline',exact:true}).count(),0);
 assert.equal(await approval.getByRole('button',{name:'Cancel',exact:true}).count(),1);
 assert.match(await approval.locator('pre').innerText(),/meaningful-combined-feature-regression/);
 assert.match(await approval.innerText(),/Folder:.*long-directory/);
 assert.ok(await approval.getByRole('button',{name:'Accept',exact:true}).evaluate(button=>button.getBoundingClientRect().height>=44));
 await page.screenshot({path:`${output}/approval-loading-mobile.png`});
 await page.evaluate(()=>{fixture.messages=[...window.approvalHistory];fixture.loading=false});
 await assertApprovalAtTail();
 await page.locator('.conversation-list').evaluate(list=>list.scrollTop=0);
 await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
 await assertApprovalAtTail();
 await page.locator('[data-response-message-id="message-1999"]').waitFor();
 assert.ok(await approval.evaluate(card=>card.scrollWidth<=card.clientWidth),'Long command and folder stay within the phone card');
 await page.screenshot({path:`${output}/approval-tail-mobile.png`});
 await approval.getByRole('button',{name:'Accept',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>fixture.replies),[{id:812,result:{decision:'accept'}}]);
 assert.equal(await approval.getByRole('button',{name:'Accept',exact:true}).isDisabled(),true);
 await page.evaluate(()=>{fixture.pending[0].replyState='failed';fixture.pending[0].replyError='Could not send your decision. Try again.'});
 await approval.getByRole('alert').waitFor();
 assert.equal(await approval.getByRole('button',{name:'Accept',exact:true}).isEnabled(),true);
 assert.equal(await page.evaluate(()=>fixture.replies.length),1,'Rendering or retry readiness must not send another decision');
 await page.evaluate(()=>{fixture.pending=[];fixture.overlay=null});
 await page.setViewportSize({width:1100,height:850});
 await assertLatestVisible();
 results.approval={visibleDuringLoading:true,visibleAfterHydration:true,tailNavigation:true,mobileActions:true,explicitDecision:true,retry:true};
 for(const width of [390,1100]) {
   await page.setViewportSize({width,height:844});
   for(let i=0;i<3;i++) {
     await page.locator('.conversation-list').evaluate(el=>el.scrollTop=0);
     await page.waitForTimeout(80);
     await page.locator('.conversation-list').evaluate(el=>el.scrollTop=el.scrollHeight);
     await assertLatestVisible();
   }
 }
 await page.evaluate(()=>{fixture.activeThreadId='changed-chat';fixture.messages=fixture.messages.slice(-70)});
 await assertLatestVisible();
 await page.evaluate(()=>{fixture.messages=[...fixture.messages,...Array.from({length:35},(_,i)=>({id:'burst-'+i,role:'assistant',text:'New live result '+i,turnId:'burst-turn'}))]});
 await assertLatestVisible();
 await page.evaluate(()=>fixture.activeThreadId='chat-1');
 await assertLatestVisible();
 results.bottomRendering={resize:true,historyRemount:true,chatSwitch:true,liveBurst:true};
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
 await assertLatestVisible();
 // Phone-height/composer changes keep the tail visible, but resizing while
 // reading older history must not pull the reader back to the latest reply.
 await page.locator('.conversation-list').evaluate(el=>el.scrollTop=0);
 await page.waitForTimeout(150);
 await page.setViewportSize({width:390,height:640});
 await page.waitForTimeout(250);
 assert.ok(await page.locator('.conversation-list').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight>1000));
 await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
 await assertLatestVisible();
 await page.locator('.thread-composer-input').fill(Array.from({length:9},(_,i)=>'Draft line '+i).join('\n'));
 await assertLatestVisible();
 await page.locator('.thread-composer-input').fill('');
 await page.setViewportSize({width:390,height:844});
 await assertLatestVisible();
 results.bottomRendering.phoneResize=true;
 results.bottomRendering.composerResize=true;
 results.bottomRendering.preservedHistoryReading=true;
 await page.screenshot({path:`${output}/long-chat-mobile.png`});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 // Main composer dictation uses visual controls without helper prose taking
 // space. Preserve accessible status, errors/retry, cancellation and manual send.
 await page.evaluate(()=>window.deferMicrophonePermission=false);
 let mainTranscriptions=0;
 let resolveMainTranscript;
 let rejectMainTranscript=true;
 await page.route('**/codex-api/transcribe',async route=>{
   mainTranscriptions++;
   if(rejectMainTranscript){rejectMainTranscript=false;await route.fulfill({status:503,body:'temporary error'});return}
   await new Promise(resolve=>resolveMainTranscript=resolve);
   await route.fulfill({json:{text:'Dictated addition.'}});
 });
 const mainComposer=page.locator('.thread-composer');
 const mainInput=page.locator('.thread-composer-input');
 for(const [label,width,height] of [['desktop',1100,850],['mobile',390,844]]){
   await page.setViewportSize({width,height});
   await mainInput.fill('Typed context.');
   const attemptsBeforeCancel=mainTranscriptions;
   await mainComposer.getByRole('button',{name:'Start dictation',exact:true}).click();
   const mic=mainComposer.getByRole('button',{name:'Stop dictation',exact:true});
   await mic.waitFor();
   assert.equal(await mic.getAttribute('aria-pressed'),'true');
   const quietStatus=mainComposer.locator('[data-dictation-status]');
   const statusBounds=await quietStatus.boundingBox();
   assert.ok(statusBounds.height<=1&&statusBounds.width<=1,'Routine speech status is available to screen readers without adding visible prose');
   assert.equal(await mainComposer.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
   if(label==='mobile'){
     assert.ok((await mic.boundingBox()).height>=44);
     assert.ok((await mainComposer.getByRole('button',{name:'Cancel dictation',exact:true}).boundingBox()).width>=44);
   }
   await page.screenshot({path:`${output}/main-dictation-${label}.png`});
   await mainComposer.getByRole('button',{name:'Cancel dictation',exact:true}).click();
   assert.equal(await mainInput.inputValue(),'Typed context.');
   assert.equal(mainTranscriptions,attemptsBeforeCancel,'Cancel must not upload or insert discarded audio');
   await mainComposer.getByRole('button',{name:'Start dictation',exact:true}).click();
   await mainComposer.getByRole('button',{name:'Stop dictation',exact:true}).click();
   if(label==='desktop'){
     await mainComposer.getByRole('alert').filter({hasText:'Transcription failed: 503'}).waitFor();
     await mainComposer.getByRole('button',{name:'Retry transcription',exact:true}).click();
   }
   await mainComposer.locator('.thread-composer-mic-spinner').waitFor();
   const deadline=Date.now()+5000;
   while(!resolveMainTranscript&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
   assert.ok(resolveMainTranscript);
   resolveMainTranscript();resolveMainTranscript=undefined;
   await page.waitForFunction(()=>document.querySelector('.thread-composer-input').value==='Typed context.\nDictated addition.');
   assert.equal(await mainComposer.getByRole('alert').count(),0);
   assert.equal(await mainComposer.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true);
   assert.equal(await page.evaluate(()=>fixture.submits),0,'Finishing dictation does not send');
   assert.equal(await mainComposer.locator('[data-dictation-status]').getAttribute('class'),'sr-only');
 }
 // Persisted activity cards retain names, task context, lifecycle labels and child links.
 const activity=(id,kind,agentPath,extra={})=>({id,type:'subAgentActivity',kind,agentPath,agentThreadId:'child-'+id,...extra});
 const activities=[
   {id:'activity-request',type:'userMessage',content:[{type:'text',text:'Review the mobile UI and check the release.'}]},
   activity('design','started','/root/design_review',{prompt:'Check the mobile layout, touch targets, and visual hierarchy.'}),
   activity('tests','interacted','/root/test_coverage',{name:'Ada',prompt:'Run the focused regression checks and report any failures.'}),
   activity('docs','completed','/root/docs_review'),
   activity('release','interrupted','/root/release_check'),
   {id:'fallback',type:'sub_agent_activity',kind:'future-event',unexpected:{large:'x'.repeat(2000)}},
 ];
 await page.evaluate(items=>loadActivityHistory(items),activities);
 await page.locator('.subagent-activity-card').last().waitFor();
 assert.equal(await page.locator('.subagent-activity-card').count(),5);
 assert.equal(await page.getByText('Unsupported item: subAgentActivity',{exact:true}).count(),0);
 assert.equal(await page.locator('.message-raw-details').count(),0);
 assert.equal(await page.locator('.subagent-activity-card[data-agent-status="unknown"] a').count(),0);
 await page.setViewportSize({width:1100,height:850});
 await page.screenshot({path:`${output}/subagent-activity-desktop.png`});
 await page.getByRole('link',{name:'Open Design review subagent',exact:true}).focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>fixtureRouter.currentRoute.value.params.threadId),'child-design');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:`${output}/subagent-activity-mobile.png`});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 // Exercise the actual app-server notification consumer, including an item/completed
 // envelope whose agent remains active, an update to the same item, and turn isolation.
 await page.route('**/codex-api/**',route=>route.fulfill({json:{requests:[],data:[],result:{data:[]}}}));
 await page.evaluate(()=>startActivityStream());
 const notify=async(method,item,threadId='chat-1')=>page.evaluate(({method,item,threadId})=>activityStream.onmessage({data:JSON.stringify({method,params:{threadId,turnId:'activity-turn',item}})}),{method,item,threadId});
 await notify('item/completed',activity('live','started','/root/live_review'));
 await page.locator('[data-agent-thread-id="child-live"][data-agent-status="active"]').waitFor();
 await notify('item/started',activity('other','started','/root/other_chat'),'different-parent');
 assert.equal(await page.locator('.subagent-activity-card').count(),1);
 await notify('item/completed',activity('live','completed','/root/live_review',{prompt:'The UI review is complete.'}));
 await page.locator('[data-agent-thread-id="child-live"][data-agent-status="completed"]').waitFor();
 assert.equal(await page.locator('.subagent-activity-card').count(),1);
 assert.equal(await page.locator('.subagent-activity-task').textContent(),'The UI review is complete.');
 await page.evaluate(()=>desktop.stopPolling());
 results.subagentActivity={persisted:true,liveNotifications:true,childNavigation:true,unknownFallback:true,mobileOverflow:false};
 assert.deepEqual(errors,[]);
 results.dictation={retry:true,manualSend:true,chatSwitchPreserved:true,pendingPermissionCancelled:true,quietMainComposer:true,mainCancelPreservesDraft:true};
 console.log(JSON.stringify(results,null,2));await writeFile(`${output}/smoke-results.json`,JSON.stringify(results,null,2));
 await page.close();
} finally {await browser.close();await server.close()}
