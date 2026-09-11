import {setup} from './setup.mjs';
import{chromium,expect}from'@playwright/test';
const {root,c,base,origin}=await setup('expired-auth');
const issued=await fetch(origin+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:c.b.email,code:c.otp})});
const session=await issued.json();expect(session.ok).toBe(true);
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(30000);
try{
 const destination='/sites?review=expired#return-destination';
 await page.goto(base+'login?redirect='+encodeURIComponent(destination));
 await page.getByTestId('token-input').fill(session.token);await page.getByTestId('login-button').click();
 await expect(page).toHaveURL(base.replace(/\/$/,'')+destination);
 const revoked=await fetch(origin+'/api/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+session.token}});expect(revoked.status).toBe(200);
 const rejected=await fetch(origin+'/api/auth/me',{headers:{Authorization:'Bearer '+session.token}});expect(rejected.status).toBe(401);
 await page.reload();await expect(page).toHaveURL(/\/app\/login\?/);
 const login=new URL(page.url());expect(login.pathname).toBe('/app/login');expect(login.searchParams.get('redirect')).toBe(destination);
 expect(await page.evaluate(()=>Object.entries(localStorage).filter(([k,v])=>['octos_session_token','octos_auth_token'].includes(k)&&v).length)).toBe(0);
 await page.screenshot({path:new URL('expired-auth.png',root).pathname});
 console.log(JSON.stringify({event:'PASS',checks:['actual session revocation','actual auth/me 401','app base preserved','path query and hash preserved in login return route']}));
}finally{await browser.close();}
