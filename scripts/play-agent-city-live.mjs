/**
 * Visual smoke test of the *currently deployed public* Agent City.
 * This is NOT the private PR preview; tests the live deployment only.
 */
import {chromium,devices} from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('live-gameplay-artifacts',{recursive:true});
const target='https://agents-city.pages.dev';
const configs=[
  {name:'desktop',use:{viewport:{width:1440,height:900}}},
  {name:'mobile',use:{...devices['Pixel 7']}},
];
const results=[];
for(const config of configs){
  const errors=[];
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:[
      '--enable-webgl','--use-gl=angle','--use-angle=swiftshader',
      '--disable-dev-shm-usage','--disable-gpu-sandbox',
    ]});
    const context=await browser.newContext(config.use);
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(String(error.message).slice(0,400)));
    const response=await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(3500);
    const first={
      status:response?.status()||null,
      title:await page.title(),
      canvas:await page.locator('canvas').count(),
      bodyText:(await page.locator('body').innerText()).slice(0,450),
      buttons:(await page.locator('button').allTextContents()).slice(0,30).map(v=>v.trim()).filter(Boolean),
    };
    await page.screenshot({path:'live-gameplay-artifacts/'+config.name+'-entry.png',fullPage:false});
    let enterAttempted=false,entered=false,phoneOpened=false,computerOpened=false;
    const entryBtn=page.getByRole('button',{name:/enter.*city|enter.*world|start.*game|play/i}).first();
    if(await entryBtn.count()){
      enterAttempted=true;
      await entryBtn.click({timeout:12000}).catch(e=>errors.push('enter: '+String(e.message).slice(0,150)));
      await page.waitForTimeout(2000);
      entered=await page.locator('canvas').count()>0;
      await page.screenshot({path:'live-gameplay-artifacts/'+config.name+'-world.png'});
    }
    const computer=page.getByRole('button',{name:/open browserbro city computer/i}).first();
    if(await computer.count()){
      await computer.click({timeout:12000}).catch(e=>errors.push('computer: '+String(e.message).slice(0,150)));
      computerOpened=await page.getByText('Browser tabs').count()>0;
      await page.screenshot({path:'live-gameplay-artifacts/'+config.name+'-computer.png'});
      const close=page.getByRole('button',{name:/step back from computer/i}).first();
      if(await close.count())await close.click();
    }
    const phone=page.getByRole('button',{name:/open your phone/i}).first();
    if(await phone.count()){
      await phone.click({timeout:12000}).catch(e=>errors.push('phone: '+String(e.message).slice(0,150)));
      phoneOpened=await page.getByText('Your Phone',{exact:false}).count()>0;
      await page.screenshot({path:'live-gameplay-artifacts/'+config.name+'-phone.png'});
    }
    results.push({device:config.name,first,enterAttempted,entered,
      computerOpened,phoneOpened,errors,passed:first.status===200&&first.canvas>0});
    await context.close();
  }catch(error){
    results.push({device:config.name,passed:false,error:String(error).slice(0,700),errors});
  }finally{await browser?.close();}
}
fs.writeFileSync('live-gameplay-artifacts/verification.json',JSON.stringify({
  at:new Date().toISOString(),target,scope:'LIVE_MAIN_NOT_PRIVATE_PR',results,
},null,2));
console.log(JSON.stringify({target,scope:'LIVE_MAIN_NOT_PRIVATE_PR',results},null,2));
if(results.some(x=>!x.passed))process.exitCode=1;
