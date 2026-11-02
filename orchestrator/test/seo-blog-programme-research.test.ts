import test from 'node:test';
import assert from 'node:assert/strict';
import { DataForSeoSerpProvider, ResearchProviderError } from '../src/seo-blog/research.js';
import { researchDiagnostic } from '../src/seo-blog/programme.js';

test('only allowlisted supplier40101 is transient; safe diagnostics never display raw provider text', async () => {
  for (const code of [40101,40103,40100,40104,40200,40203,40204,49999]) {
    let calls = 0;
    const provider = new DataForSeoSerpProvider('fixture-login','fixture-password', async () => {
      calls++; return new Response(JSON.stringify({ status_code: 20000, tasks: [{ id: 'task-12345678', status_code: code, status_message: 'SECRET_PROVIDER_TEXT fixture-password', cost: 0.002 }] }), { status: 200 });
    });
    await assert.rejects(provider.search('letting questions', { locale:'en-GB',limit:4 }), (error: unknown) => {
      assert.ok(error instanceof ResearchProviderError); assert.equal(error.diagnostic.supplierCode,code); assert.equal(error.diagnostic.retryable,code===40101);
      assert.equal(error.diagnostic.taskId,'task-12345678'); assert.equal(error.providerReportedCost,0.002);
      assert.doesNotMatch(error.message,/SECRET_PROVIDER_TEXT|fixture-password/); return true;
    });
    assert.equal(calls,1,'the transport never sleeps or retries itself');
  }
});
test('HTTP and network uncertainty do not become supplier-code retries; success receipts retain hits and separate provider cost', async () => {
  for (const status of [401,403,429,500]) {
    const provider = new DataForSeoSerpProvider('l','p',async () => new Response('private provider body',{status}));
    await assert.rejects(provider.search('query',{locale:'en-GB',limit:4}),(error:unknown) => { assert.ok(error instanceof ResearchProviderError); assert.equal(error.diagnostic.retryable,false); assert.equal(error.diagnostic.supplierCode,null); assert.doesNotMatch(error.message,/private provider body/); return true; });
  }
  const provider = new DataForSeoSerpProvider('l','p',async () => new Response(JSON.stringify({ status_code:20000,tasks:[{id:'task-12345678',status_code:20000,cost:0.001,result:[{items:[{type:'organic',url:'https://example.test/guide',title:'Useful guide',description:'Evidence'}]}]}] })));
  const receipt = await provider.searchReceipt('query',{locale:'en-GB',limit:4});
  assert.equal(receipt.hits.length,1); assert.equal(receipt.providerReportedCost,0.001);
  assert.equal(researchDiagnostic(null,503,'invalid/task/secret').taskId,null);
});
