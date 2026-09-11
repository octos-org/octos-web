import {setup} from './setup.mjs';
import {chromium,expect} from '@playwright/test';
const {root,c,base}=await setup('slides-links');
const session=process.env.OCTOS_LIVE_REVIEW_SLIDES_SESSION;
if (!session || !/^slides-[a-zA-Z0-9-]+$/.test(session)) throw Error('Set OCTOS_LIVE_REVIEW_SLIDES_SESSION to an existing synthetic slide scaffold.');
const browser=await chromium.launch();
try {
 for (const route of [`slides/${session}`,`slides/${session}/present`]) {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[],fileLists=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{const url=new URL(response.url());if(url.pathname==='/api/files/list')fileLists.push(response.status());});
  await page.goto(base+'login?redirect='+encodeURIComponent('/'+route));
  await page.getByTestId('token-input').fill(c.a.token);await page.getByTestId('login-button').click();
  if(route.endsWith('/present')) await expect(page.getByRole('button',{name:'Back',exact:true})).toBeVisible({timeout:30000});
  else {
   await expect(page.getByTestId('chat-input')).toBeVisible({timeout:30000});
   for (const name of ['script.js','memory.md','changelog.md'])
    await expect(page.getByText(name,{exact:true})).toHaveCount(1,{timeout:30000});
   await expect(page.getByTestId('assistant-message').filter({hasText:/project.*created/i})).toHaveCount(1,{timeout:30000});
  }
  await expect(page.locator('body')).not.toContainText('Local runtime is stopped');
  await expect(page.locator('body')).not.toContainText('Slides session unavailable');
  expect(fileLists.filter(status=>status===200).length).toBeGreaterThan(0);
  await page.waitForTimeout(6000);
  expect(fileLists.length).toBeLessThan(30);
  expect(errors).toEqual([]);
  await page.screenshot({animations:'disabled',path:new URL(route.endsWith('/present')?'present-direct.png':'editor-direct.png',root).pathname});
  console.log(JSON.stringify({event:'PASS',route,freshBrowser:true,fileListRequests:fileLists.length,fileListStatuses:[...new Set(fileLists)],checks:['actual session hydration','direct authenticated link','no standalone gateway requirement','bounded file polling over six seconds','no browser errors']}));
  await context.close();
 }
}finally{await browser.close();}
