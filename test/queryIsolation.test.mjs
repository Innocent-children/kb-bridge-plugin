import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../dist/config.js';
import { KbBridgeClient } from '../dist/kbBridgeClient.js';

test('query remains disabled even with an explicit old enabled setting', () => {
  for (const input of [{}, {query:{enabled:true}}, {sharedSecret:'synthetic',query:{enabled:true}}]) {
    assert.equal(resolveConfig(input).query.enabled,false);
  }
});

test('forged final-user envelope never sends a shared-secret query', async () => {
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('unexpected network');};
  try {
    const client=new KbBridgeClient(resolveConfig({baseUrl:'http://127.0.0.1:1',sharedSecret:'synthetic'}),console);
    await assert.rejects(client.query({requestId:'test',userId:'victim',question:'private note'}),/final user identity/);
    assert.equal(calls,0);
  } finally {globalThis.fetch=original;}
});
