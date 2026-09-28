import {chromium,webkit,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {setup} from './setup.mjs';

const {root,c,base}=await setup('auth-recovery');
const engine=process.env.OCTOS_LIVE_REVIEW_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(30000);
const errors=[],results=[];
page.on('pageerror',error=>errors.push(error.message));
const tokenSnapshot=()=>page.evaluate(()=>JSON.stringify(['octos_session_token','octos_auth_token'].map(key=>localStorage.getItem(key))));
async function login(){
  await page.getByTestId('token-input').fill(c.a.token);
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}
try{
  await page.goto(base+'login?redirect=%2Fchat');
  await login();
  const before=await tokenSnapshot();
  let probes=0;
  await page.route('**/api/auth/me',route=>++probes<=2?route.abort('connectionfailed'):route.continue());
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Unable to verify your session');
  await expect(page.getByTestId('chat-input')).toBeVisible({timeout:15000});
  expect(probes).toBe(3);
  expect(await tokenSnapshot()).toBe(before);
  results.push({case:'automatic recovery',probes,actualAuthentication:true,tokenPreserved:true});
  await page.screenshot({path:new URL('automatic-recovery.png',root).pathname,animations:'disabled'});
  await page.unroute('**/api/auth/me');

  probes=0;
  await page.route('**/api/auth/me',route=>{probes++;return route.abort('connectionfailed');});
  await page.goto(base+'chat?review=auth-recovery#return-here');
  await expect.poll(()=>probes,{timeout:15000}).toBe(3);
  await expect(page.getByRole('alert')).toBeVisible();
  await page.waitForTimeout(4500);
  expect(probes).toBe(3);
  expect(await tokenSnapshot()).toBe(before);
  const outageWindowProbes=probes;
  const signIn=page.getByRole('link',{name:'Sign in again'});
  expect(await signIn.getAttribute('href')).toBe('/app/login?redirect='+encodeURIComponent('/chat?review=auth-recovery#return-here'));
  await page.screenshot({path:new URL('persistent-outage.png',root).pathname,animations:'disabled'});
  await signIn.click();
  await expect(page.getByTestId('token-input')).toBeVisible();
  await page.unroute('**/api/auth/me');
  await login();
  await expect(page).toHaveURL(base+'chat?review=auth-recovery#return-here');
  results.push({case:'bounded outage and sign-in recovery',outageWindowProbes,actualAuthentication:true,destinationPreserved:true,tokenPreserved:true});

  // A fresh browser with an invalid token exercises actual server rejection.
  const invalid=await browser.newContext();
  try{
    await invalid.addInitScript(()=>{
      if(!location.pathname.endsWith('/login'))localStorage.setItem('octos_session_token','invalid-synthetic-review-token');
    });
    const rejected=await invalid.newPage();
    let actualRejection=false;
    rejected.on('response',response=>{if(new URL(response.url()).pathname==='/api/auth/me'&&response.status()===401)actualRejection=true;});
    await rejected.goto(base+'chat');
    await expect(rejected).toHaveURL(/\/app\/login\?redirect=/);
    await expect(rejected.getByTestId('token-input')).toBeVisible();
    expect(actualRejection).toBe(true);
    results.push({case:'invalid credentials',actualRejection:401,signInShown:true});
  }finally{await invalid.close();}

  const malformed=await browser.newContext();
  try{
    await malformed.addInitScript(()=>{
      if(!location.pathname.endsWith('/login'))localStorage.setItem('octos_auth_token','invalid\n凭据');
    });
    const repaired=await malformed.newPage();
    repaired.on('pageerror',error=>errors.push(error.message));
    let publicOptionsLoaded=false;
    repaired.on('response',response=>{
      if(new URL(response.url()).pathname==='/api/auth/status'&&response.status()===200)publicOptionsLoaded=true;
    });
    await repaired.goto(base+'chat');
    await expect(repaired).toHaveURL(/\/app\/login\?redirect=/);
    await expect(repaired.getByTestId('token-input')).toBeVisible();
    expect(publicOptionsLoaded).toBe(true);
    await repaired.getByTestId('token-input').fill('invalid\n凭据');
    await repaired.getByTestId('login-button').click();
    await expect(repaired.getByText('That token has an invalid format. Paste only the token value.')).toBeVisible();
    expect(await repaired.evaluate(()=>localStorage.getItem('octos_auth_token')||localStorage.getItem('octos_session_token'))).toBeNull();
    await repaired.getByTestId('token-input').fill(c.a.token);
    await repaired.getByTestId('login-button').click();
    await expect(repaired.getByTestId('chat-input')).toBeVisible();
    results.push({case:'malformed saved and pasted credentials',publicOptionsLoaded,invalidPasteRejected:true,actualSignInRecovered:true});
  }finally{await malformed.close();}
  expect(errors).toEqual([]);
  const result={result:'PASS',browser:engine.name(),runtimeWeb:process.env.OCTOS_LIVE_REVIEW_WEB_COMMIT??'unspecified',runner:(await import('node:os')).hostname(),faultInjection:'Abort validation requests only; successful authentication and rejection use the real server',results,pageErrors:errors};
  await writeFile(new URL('results.json',root),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}catch(error){
  await page.screenshot({path:new URL('failure.png',root).pathname,animations:'disabled'}).catch(()=>{});
  throw error;
}finally{await browser.close();}
