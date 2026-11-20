/**
 * Independent external GET-only probe. Runs on a Linux GitHub Actions runner.
 * Does not claim gameplay, domain ownership, real SMTP delivery or phone service.
 */
const base = new URL(process.env.AGENT_CITY_PUBLIC_URL || 'https://agents-city.pages.dev');
if (base.protocol !== 'https:' || !base.hostname.endsWith('.pages.dev')) {
  throw Error('Only HTTPS Cloudflare Pages origins are permitted for this public probe');
}
const checks = [
  {name:'frontend',route:'/',contentType:'text/html',required:true},
  {name:'job-feed',route:'/api/jobs/real',contentType:'application/json',required:true},
  {name:'mail-status',route:'/api/mail/status',contentType:'application/json',required:true},
  {name:'phone-status',route:'/api/phone/status',contentType:'application/json',required:true},
  {name:'browserbro-status',route:'/api/browser/status',contentType:'application/json',required:false},
];
const output={checkedAt:new Date().toISOString(),target:base.origin,results:[]};
for(const check of checks){
  const url=new URL(check.route,base);
  try{
    const response=await fetch(url,{method:'GET',redirect:'error',
      signal:AbortSignal.timeout(12000),headers:{'accept':'application/json, text/html',
        'user-agent':'agent-city-independent-release-probe/1.0'}});
    const body=await response.text();
    if(body.length>2_000_000) throw Error('Response exceeds public probe safety limit');
    const ctype=response.headers.get('content-type')||'';
    const statusOK=response.status===200;
    let valid=false,proof={};
    if(ctype.includes('application/json')){
      try{
        const data=JSON.parse(body);
        valid=typeof data==='object' && data!==null && !Array.isArray(data);
        proof={
          ok:data.ok,connected:data.connected,configured:data.configured,
          publicDeliveryVerified:data.publicDeliveryVerified,
          publicNumbers:data.publicNumbers,sourceCount:Array.isArray(data.sources)?data.sources.length:undefined,
          jobsCount:Array.isArray(data.jobs)?data.jobs.length:undefined,
          error:typeof data.error==='string'?data.error.slice(0,130):undefined,
        };
      }catch{}
    }else if(ctype.includes('text/html')){
      valid=/<html|<!doctype html/i.test(body);
      proof={hasHtmlShell:valid};
    }
    const passed=statusOK&&ctype.includes(check.contentType)&&valid;
    output.results.push({name:check.name,required:check.required,passed,status:response.status,
      contentType:ctype,proof});
  }catch(error){
    output.results.push({name:check.name,required:check.required,passed:false,
      error:error instanceof Error?error.name+': '+error.message:'unexpected fetch error'});
  }
}
const renderURL='https://agent-mail-service.onrender.com/health';
try{
  const response=await fetch(renderURL,{signal:AbortSignal.timeout(8000),redirect:'error'});
  output.legacyRender={status:response.status,alive:response.ok,note:'Historical separate backend; NOT Cloudflare mail'};
}catch(err){
  output.legacyRender={alive:false,error:err instanceof Error?err.message:String(err)};
}
console.log(JSON.stringify(output,null,2));
if(output.results.some(x=>x.required&&!x.passed)){
  console.error('Public verification gate failed; no claim of live readiness');
  process.exitCode=1;
}
