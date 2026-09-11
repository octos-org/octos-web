import {setup} from './setup.mjs';
import {chromium,expect} from '@playwright/test';
const {root,c,base}=await setup('long-chat');
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1500,height:1000}});
page.setDefaultTimeout(30000);const marker='LONG_REPLY_'+Date.now()+'_END';let final=false;let deltas=0;let compacted=false;
page.on('websocket',s=>s.on('framereceived',f=>{try{const x=JSON.parse(String(f.payload));if(x.method==='projection/envelope'){if(x.params.payload.type==='assistant_delta')deltas++;if(x.params.payload.type==='turn_terminal')final=true;}if(x.result?.projection_thread_sequences&&x.result.messages?.length>0&&Math.max(...Object.values(x.result.projection_thread_sequences))>800&&x.result.replayed_projection_envelopes?.length<10)compacted=true;}catch{}}));
try {
 await page.goto(base+'login?redirect=%2Fchat');await page.getByTestId('token-input').fill(c.a.token);await page.getByTestId('login-button').click();await expect(page).not.toHaveURL(/\/login/);
 await page.getByTestId('chat-input').fill(`Write a detailed 2,500-word guide to keeping a household reading journal, in plain prose with ten sections. Do not use tools. Put this unique marker on a separate final line, exactly once at the very end: ${marker}. This long response is an authorized streaming regression test.`);const started=Date.now();await page.getByTestId('send-button').click();
 await expect.poll(()=>final,{timeout:240000}).toBe(true);
 const reply=page.getByTestId('assistant-message').filter({has:page.getByText(marker,{exact:true})});
 await expect(reply).toHaveCount(1);await expect(page.getByTestId('assistant-message')).toHaveCount(1);
 const text=await reply.innerText();expect(text.length).toBeGreaterThan(7000);expect(deltas).toBeGreaterThan(800);
 await page.screenshot({path:new URL('long-chat-before-reload.png',root).pathname});
 await page.reload();await expect(reply).toHaveCount(1);await expect(page.getByTestId('assistant-message')).toHaveCount(1);
 expect((await reply.innerText()).length).toBeGreaterThan(7000);
 await expect(page.locator('body')).not.toContainText('[oversized field omitted]');
 console.log(JSON.stringify({event:'PASS',elapsedMs:Date.now()-started,deltas,compacted,characters:text.length,checks:['actual long streamed response','one final bubble before reload','one intact final bubble after reload']}));
}finally{await page.screenshot({path:new URL('long-chat-last.png',root).pathname}).catch(()=>{});await browser.close();}
