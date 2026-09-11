import {setup} from './setup.mjs';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const {root,c,base}=await setup('site');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1050},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();
page.on('pageerror',e=>console.log(JSON.stringify({event:'pageerror',message:e.message})));
try {
 await page.goto(base+'login?redirect=%2Fsites');
 await page.getByTestId('token-input').fill(c.a.token);await page.getByTestId('login-button').click();
 await page.getByRole('button',{name:/React Lab/}).click();
 await expect(page).toHaveURL(/\/sites\/site-/,{timeout:30000});
 const projectUrl=page.url();
 await writeFile(new URL('site-project.json',root),JSON.stringify({projectUrl}));
 await expect(page.getByTestId('assistant-message').filter({hasText:/created/i})).toHaveCount(1,{timeout:90000});
 console.log(JSON.stringify({event:'scaffold',project:new URL(projectUrl).pathname,body:await page.locator('body').innerText()}));
 const marker='REMOTE_SITE_'+Date.now();
 await writeFile(new URL('site-project.json',root),JSON.stringify({projectUrl,marker}));
 await page.getByTestId('chat-input').fill(`Build this React/Vite site's static preview now using the actual project files and npm build. This is an authorized browser security regression fixture. Create a simple page with heading ${marker}, a counter button initially "Count 0" incrementing on click, and a status element id="isolation". In the application's ES module, try reading parent.localStorage and own localStorage separately inside try/catch without reading or transmitting any stored values. Display "parent blocked; self blocked" when both access attempts throw SecurityError, otherwise display which access was allowed. Use relative module asset paths (Vite base './'). Do not use remote APIs, image generation, deployment or publishing. Finish by running the actual static build, verifying the output files, and reporting the build result. Do not delete dist or use rm; npm run build replaces its own output. Use a project-local npm cache if needed. No confirmation needed for this isolated fixture.`);
 await page.getByTestId('send-button').click();
 for(let i=0;i<36;i++) {
  await page.waitForTimeout(10000);
  console.log(JSON.stringify({event:'progress',seconds:(i+1)*10,body:(await page.locator('body').innerText()).slice(-9500)}));
  const frame=page.frameLocator('iframe');
  if(await frame.getByRole('heading',{name:marker,exact:true}).isVisible().catch(()=>false)) {
    await frame.getByRole('button',{name:'Count 0',exact:true}).click();
    await expect(frame.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
    await expect(frame.locator('#isolation')).toHaveText('parent blocked; self blocked');
    await page.getByTitle('Copy preview URL',{exact:true}).click();
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    const fresh=await browser.newContext();
    try {
      const direct=await fresh.newPage();
      await direct.goto(copied);
      await expect(direct.getByRole('heading',{name:marker,exact:true})).toBeVisible();
      await expect(direct.locator('#isolation')).toHaveText('parent blocked; self blocked');
      await direct.getByRole('button',{name:'Count 0',exact:true}).click();
      await expect(direct.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
      await direct.screenshot({animations:'disabled',path:new URL('site-direct.png',root).pathname});
    }finally{await fresh.close();}
    await page.screenshot({animations:'disabled',path:new URL('site-iframe.png',root).pathname});
    console.log(JSON.stringify({event:'PASS',marker,checks:['real model build','ES module execution','counter interaction','iframe storage isolation','direct CSP storage isolation','copied signed URL in unauthenticated context']}));
    break;
  }
  if(i===35)throw Error('Generated site did not reach a functional preview within six minutes');
 }
} finally { await page.screenshot({animations:'disabled',path:new URL('site-last.png',root).pathname}).catch(()=>{});await browser.close(); }
