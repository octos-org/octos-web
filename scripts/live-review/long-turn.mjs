import {setup} from './setup.mjs';
import {chromium,expect} from '@playwright/test';
const {root,c,base}=await setup('long-turn');
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1500,height:1000}});
page.setDefaultTimeout(30000);const marker='LONG_ACCEPTED_'+Date.now()+'_END';
try {
 await page.goto(base+'login?redirect=%2Fchat');
 await page.getByTestId('token-input').fill(c.a.token);await page.getByTestId('login-button').click();
 await expect(page).not.toHaveURL(/\/login/);
 await page.getByTestId('chat-input').fill(`Use bash to run exactly: sleep 36; printf '${marker}\\n'. This is an authorized isolated latency regression. Do not use any other tool. After the command finishes reply exactly ${marker}.`);
 const started=Date.now();await page.getByTestId('send-button').click();
 await expect(page.getByTestId('cancel-button')).toBeVisible();
 await page.waitForTimeout(32000);
 await expect(page.getByTestId('cancel-button')).toBeVisible();
 await expect(page.locator('body')).not.toContainText('Send not confirmed within 30s.');
 await page.screenshot({path:new URL('long-turn-at-32s.png',root).pathname});
 await expect(page.getByTestId('assistant-message').filter({has:page.getByText(marker,{exact:true})})).toHaveCount(1,{timeout:60000});
 await expect(page.getByTestId('cancel-button')).toHaveCount(0);
 await expect(page.getByTestId('ghost-bubble')).toHaveCount(0);
 await page.reload();await expect(page.getByTestId('assistant-message').filter({has:page.getByText(marker,{exact:true})})).toHaveCount(1);
 await expect(page.locator('body')).not.toContainText('Send not confirmed within 30s.');
 await page.screenshot({path:new URL('long-turn-complete.png',root).pathname});
 console.log(JSON.stringify({event:'PASS',elapsedMs:Date.now()-started,checks:['actual 36-second bash turn','no false warning after 32 seconds','canonical completion','reload preserves final answer']}));
}finally{await browser.close();}
