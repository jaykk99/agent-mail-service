import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const bridge = 'super-secret-only-on-server-'.repeat(2);
const endpoint = (path,method='GET',body,valid=true) => new Request(
  'https://mail.example.com' + path,
  {method,
   headers:{authorization:'Bearer '+(valid?bridge:'invalid-token'),
    ...(body?{'content-type':'application/json'}:{})},
   body:body?JSON.stringify(body):undefined},
);

function createDB(){
  const addresses=new Map(), inbox=[];
  const counts=new Map();
  return {
    addresses,inbox,
    prepare(sql){
      let vals=[];
      return {
        bind(...args){vals=args;return this;},
        async first(){
          if(sql.includes('SELECT 1 AS up'))return {up:1};
          if(sql.includes('COUNT(*)'))return {n:addresses.size};
          if(sql.includes('FROM identities WHERE agent_id')){
            const a=addresses.get(vals[0]);
            return a || null;
          }
          if(sql.includes('RETURNING sends')){
            const key=vals[0]+':'+vals[1],v=(counts.get(key)||0);
            if(v>=5)return null;
            counts.set(key,v+1);
            return {sends:v+1};
          }
          return null;
        },
        async run(){
          if(sql.includes('INSERT INTO identities')){
            const [id,slug,address]=vals;
            if(addresses.has(id)||[...addresses.values()].some(i=>i.slug===slug))throw Error('unique constraint');
            addresses.set(id,{agentId:id,slug,address});
          }
          if(sql.includes('INSERT INTO messages')){
            inbox.push(vals);
          }
          return {success:true};
        },
        async all(){
          return {results:inbox.filter(x=>x[1]===vals[0]&&x[2]==='inbound')
            .map(x=>({id:x[0],sender:x[3],subject:x[5],text:x[6]}))};
        },
      };
    },
  };
}
const env=()=>({DB:createDB(),EMAIL:{async send(input){return {messageId:'real-provider-accepted-'+input.from};}},
  MAIL_DOMAIN:'agents.example.com',BRIDGE_TOKEN:bridge});

test('Cloudflare mail remains inaccessible to anonymous browsers',async()=>{
  const e=env();
  const no=await worker.fetch(endpoint('/v1/agents/4/claim','POST',{slug:'river-music'},false),e);
  assert.equal(no.status,401);
  assert.equal(e.DB.addresses.size,0);
});

test('operator claims personal agent names; sender cannot impersonate another address',async()=>{
  const e=env();
  const claim=await worker.fetch(endpoint('/v1/agents/4/claim','POST',{slug:'river-music'}),e);
  assert.equal(claim.status,201);
  const data=await claim.json();
  assert.equal(data.identity.address,'river-music@agents.example.com');
  const tooMany=await worker.fetch(endpoint('/v1/agents/5/claim','POST',{slug:'river-music'}),e);
  assert.equal(tooMany.status,409);
  const missingSender=await worker.fetch(endpoint('/v1/agents/5/send','POST',
    {to:'someone@example.com',subject:'Hello',text:'Message'}),e);
  assert.equal(missingSender.status,404);
  const actual=await worker.fetch(endpoint('/v1/agents/4/send','POST',
    {to:'someone@example.com',subject:'My own idea',text:'This is my message.'}),e);
  assert.equal(actual.status,200);
  const accepted=await actual.json();
  assert.equal(accepted.provider,'cloudflare-email-service');
  assert.equal(accepted.accepted,true);
});

test('five sends per day are enforced and malformed recipients refused',async()=>{
  const e=env();
  await worker.fetch(endpoint('/v1/agents/4/claim','POST',{slug:'river-music'}),e);
  const bad=await worker.fetch(endpoint('/v1/agents/4/send','POST',
    {to:'not-an-email',subject:'hi',text:'body'}),e);
  assert.equal(bad.status,400);
  for(let i=0;i<5;i++){
    const r=await worker.fetch(endpoint('/v1/agents/4/send','POST',
      {to:'someone@example.com',subject:'hi',text:'body '+i}),e);
    assert.equal(r.status,200);
  }
  const sixth=await worker.fetch(endpoint('/v1/agents/4/send','POST',
    {to:'someone@example.com',subject:'hi',text:'last'}),e);
  assert.equal(sixth.status,429);
});
