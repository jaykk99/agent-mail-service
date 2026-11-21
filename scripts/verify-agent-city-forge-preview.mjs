/**
 * Browser QA of the PUBLIC Cloudflare preview URL only.
 * Does not checkout or export either private source repository.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const TARGET_URL = process.env.PREVIEW_URL || 'https://97b19806.agents-city.pages.dev';
const output = 'forge3d-preview-qa';
fs.mkdirSync(output, {recursive:true});
const scenarios = [
  {name:'desktop',context:{viewport:{width:1440,height:900}}},
  {name:'mobile',context:{...devices['Pixel 7']}},
];
const results = [];
for (const scenario of scenarios) {
  const browser = await chromium.launch({headless:true,args:[
    '--enable-webgl','--use-gl=angle','--use-angle=swiftshader',
    '--disable-dev-shm-usage','--disable-gpu-sandbox',
  ]});
  const errors = [];
  const observed = {device:scenario.name,entered:false,phoneOpen:false,
    memoryOpen:false,memorySearch:false,walletVisible:false,
    screenshotPaths:[],errors};
  try {
    const context = await browser.newContext(scenario.context);
    const page = await context.newPage();
    page.on('pageerror',e=>errors.push(e.message.slice(0,300)));
    const response = await page.goto(TARGET_URL,{waitUntil:'domcontentloaded',timeout:60000});
    observed.status = response?.status();
    await page.waitForTimeout(3000);
    observed.title = await page.title();
    observed.canvas = await page.locator('canvas').count();
    const shot = async label => {
      const path=output+'/'+scenario.name+'-'+label+'.png';
      await page.screenshot({path,fullPage:false});
      observed.screenshotPaths.push(path);
    };
    await shot('entry');
    const enter = page.getByRole('button',{name:/enter agent city/i}).first();
    const legacyGate = page.getByText(/(?:Click|Tap) anywhere to step inside/i).first();
    if(await enter.count()) await enter.click({timeout:20000});
    else if(await legacyGate.count()) await legacyGate.click({timeout:20000});
    await page.waitForTimeout(5000);
    observed.entered = await page.getByRole('button',{name:/open your phone/i}).count()>0;
    await shot('city');
    if(observed.entered){
      if(scenario.name==='desktop'){
        await page.keyboard.down('w');
        await page.waitForTimeout(700);
        await page.keyboard.up('w');
      }
      const openPhone = page.getByRole('button',{name:/open your phone/i}).first();
      if(scenario.name==='desktop'){
        try{await openPhone.click({timeout:3000});}
        catch{await page.keyboard.press('p');}
      } else await openPhone.click({timeout:12000});
      const dialog = page.getByRole('dialog',{name:'Agent City phone'});
      await dialog.waitFor({state:'visible',timeout:14000});
      observed.phoneOpen=true;
      await shot('phone');
      const wallet=await dialog.getByText(/Citizens with Vouchers/).first().innerText();
      observed.walletVisible=/\d/.test(wallet);
      observed.walletText=wallet.slice(0,160);
      await dialog.getByRole('button',{name:'Memory app'}).click();
      const memory = dialog.getByRole('region',{name:'Citizen memory'});
      await memory.waitFor({state:'visible',timeout:14000});
      observed.memoryOpen=true;
      observed.memorySummary=(await memory.innerText()).slice(0,300);
      await shot('resident-memory');
      await memory.getByRole('button',{name:'Show full memory'}).click();
      observed.memorySearch=await memory.getByRole('searchbox',{name:'Search selected citizen memories'}).isVisible();
      await shot('full-memory');
      const viewport=await dialog.evaluate(el=>{
        const r=el.getBoundingClientRect();
        return {left:r.left,right:r.right,viewport:innerWidth};
      });
      observed.phoneFits=viewport.left>=-2 && viewport.right<=viewport.viewport+2;
    }
    observed.passed=observed.status===200&&observed.canvas>0&&observed.entered&&
      observed.phoneOpen&&observed.memoryOpen&&observed.memorySearch&&
      observed.walletVisible&&observed.phoneFits&&errors.length===0;
    await context.close();
  }catch(e){
    observed.passed=false;
    observed.error=String(e).slice(0,800);
  }finally{
    results.push(observed);
    await browser.close();
  }
}
const report={at:new Date().toISOString(),target:TARGET_URL,scope:'PUBLIC_CLOUDFLARE_PR_PREVIEW_ONLY',results};
fs.writeFileSync(output+'/verification.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(results.some(x=>!x.passed))process.exitCode=1;
