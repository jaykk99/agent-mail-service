import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// Real MIME parsing is exercised. D1 is replaced by a small in-memory
// adapter so these checks run without a Cloudflare account.
function createEnv() {
  const aliases = new Map([
    ['river-music@agents.example.com', {agentId:4}],
    ['aurora-paints@agents.example.com', {agentId:5}],
  ]);
  const stored = new Map();
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values){args=values;return this;},
        async first() {
          if(sql.includes('FROM identities WHERE address='))return aliases.get(args[0]) ?? null;
          return null;
        },
        async run() {
          if(sql.includes('INSERT OR IGNORE INTO messages')) {
            if(!stored.has(args[0]))stored.set(args[0],args);
          }
          return {success:true};
        },
      };
    },
  };
  return {DB,stored,MAIL_DOMAIN:'agents.example.com'};
}
function email(to,source) {
  const rejections=[];
  const bytes=new TextEncoder().encode(source);
  return {
    to,
    from:'researcher@example.net',
    raw:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),
    setReject(reason){rejections.push(reason);},
    rejections,
  };
}
const source=[
  'From: Researcher <researcher@example.net>',
  'To: River <river-music@agents.example.com>',
  'Subject: A genuine external message',
  'Message-ID: <original-123@example.net>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello River, this is an actual MIME payload.',
].join('\r\n');

test('actual MIME input is parsed, routed and stored for the claimed mailbox',async()=>{
  const env=createEnv();
  const delivery=email('river-music@agents.example.com',source);
  await worker.email(delivery,env);
  assert.deepEqual(delivery.rejections,[]);
  assert.equal(env.stored.size,1);
  const row=[...env.stored.values()][0];
  assert.equal(row[1],4);
  assert.equal(row[3],'researcher@example.net');
  assert.equal(row[4],'river-music@agents.example.com');
  assert.equal(row[5],'A genuine external message');
  assert.match(row[6],/actual MIME payload/);
});
test('unknown aliases are rejected; no inbox entry is invented',async()=>{
  const env=createEnv();
  const delivery=email('unclaimed@agents.example.com',source);
  await worker.email(delivery,env);
  assert.match(delivery.rejections[0],/not provisioned/i);
  assert.equal(env.stored.size,0);
});
test('cross-domain inbound is rejected, avoiding spoofed catch-all handling',async()=>{
  const env=createEnv();
  const delivery=email('someone@another.example.org',source);
  await worker.email(delivery,env);
  assert.match(delivery.rejections[0],/unrecognized/i);
  assert.equal(env.stored.size,0);
});
test('message IDs are unique per recipient; duplicate redelivery is idempotent',async()=>{
  const env=createEnv();
  const original=email('river-music@agents.example.com',source);
  const duplicate=email('river-music@agents.example.com',source);
  const secondAlias=email('aurora-paints@agents.example.com',source);
  await worker.email(original,env);
  await worker.email(duplicate,env);
  await worker.email(secondAlias,env);
  assert.equal(env.stored.size,2);
  assert.deepEqual([...env.stored.values()].map(row=>row[1]).sort(),[4,5]);
});
