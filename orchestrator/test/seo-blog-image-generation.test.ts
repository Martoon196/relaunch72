import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { generateImageCandidate, prepareImageGenerationRequest, ImageGenerationInputError, SEO_IMAGE_REQUEST, SEO_IMAGE_TRANSPORT_LIMITS } from '../src/seo-blog/image-generation.js';

const command = { brandId: '10000000-0000-4000-8000-000000000001', actorId: '20000000-0000-4000-8000-000000000002', prompt: 'A calm British coastal town, editorial architectural photograph.' };
const apiKey = 'image-test-key-for-injected-transport-only';
const image = jpeg.encode({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 255) }, 70).data;
const encoded = image.toString('base64');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const response = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ data: [{ b64_json: encoded }], ...extra }), { headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_private' } });
const transport = (reply: () => Response | Promise<Response>): typeof fetch => async () => reply();

test('one exact official request uses explicit credential and hashed identity; returns private owned candidate, not measured dimensions', async () => {
  const previous = process.env.OPENAI_API_KEY;
  let calls = 0;
  const result = await generateImageCandidate(command, { apiKey, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, SEO_IMAGE_REQUEST.endpoint); assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers); assert.equal(headers.get('authorization'), `Bearer ${apiKey}`); assert.equal(headers.get('accept-encoding'), 'identity');
    const { endpoint: _endpoint, ...parameters } = SEO_IMAGE_REQUEST;
    assert.deepEqual(JSON.parse(String(init.body)), { ...parameters, prompt: command.prompt, safety_identifier: sha(`${command.brandId}:${command.actorId}`) });
    assert.ok(!String(init.body).includes(command.actorId)); assert.ok(init.signal instanceof AbortSignal);
    return response();
  } });
  assert.equal(calls, 1); assert.equal(process.env.OPENAI_API_KEY, previous);
  assert.equal(result.outcome, 'candidate_received'); assert.equal(result.usage, null, 'absent usage remains unknown');
  assert.equal(result.providerRequestIdSha256, sha('req_test_private')); assert.equal(result.candidate!.sha256, sha(image));
  assert.equal(result.candidate!.validation, 'candidate_only'); assert.equal(result.candidate!.requestedSize, '1536x1024');
  assert.equal(Object.hasOwn(result.candidate!, 'width'), false, 'request size is never passed off as measured dimensions');
  assert.deepEqual(result.candidate!.bytes, image); result.candidate!.bytes.fill(0); assert.deepEqual(result.candidate!.bytes, image);
  const logged = JSON.stringify(result); for (const secret of [apiKey, command.prompt, command.actorId, encoded, 'req_test_private']) assert.equal(logged.includes(secret), false);
  assert.equal(Object.hasOwn(JSON.parse(logged).candidate, 'bytes'), false);
});

test('invalid caller inputs and pre-abort perform no transport request', async () => {
  let calls = 0; const fetchImpl = transport(() => { calls++; return response(); });
  for (const bad of [{ ...command, actorId: 'person@example.com' }, { ...command, prompt: 'x'.repeat(8001) },
    { ...command, prompt: 'https://example.com/image.jpg' }, { ...command, prompt: 'bad\0prompt' }]) {
    await assert.rejects(generateImageCandidate(bad, { apiKey, fetchImpl }), ImageGenerationInputError);
  }
  await assert.rejects(generateImageCandidate(command, { apiKey: 'wrong\nkey', fetchImpl }), ImageGenerationInputError);
  const controller = new AbortController(); controller.abort();
  const result = await generateImageCandidate(command, { apiKey, fetchImpl, signal: controller.signal });
  assert.equal(result.outcome, 'not_started'); assert.equal(result.code, 'aborted'); assert.equal(calls, 0);
});

test('streamed response bound applies with missing, excessive and lying content length; body is cancelled', async () => {
  for (const declared of [undefined, '1', String(SEO_IMAGE_TRANSPORT_LIMITS.responseBytes + 1)]) {
    let cancelled = false, calls = 0;
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      if (declared !== String(SEO_IMAGE_TRANSPORT_LIMITS.responseBytes + 1)) c.enqueue(Buffer.alloc(SEO_IMAGE_TRANSPORT_LIMITS.responseBytes + 1));
    }, cancel() { cancelled = true; } });
    const headers: Record<string, string> = { 'content-type': 'application/json' }; if (declared !== undefined) headers['content-length'] = declared;
    const result = await generateImageCandidate(command, { apiKey, fetchImpl: transport(() => { calls++; return new Response(stream, { headers }); }) });
    assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'response_limit'); assert.equal(calls, 1); assert.equal(cancelled, true);
  }
  const result = await generateImageCandidate(command, { apiKey, fetchImpl: transport(() => new Response('{"data":[]}', { headers: { 'content-type': 'application/json', 'content-length': '1' } })) });
  assert.equal(result.code, 'invalid_response');
});

test('noncanonical base64, multiple images, URL-only payloads, unsupported encoding and malformed JSON never trigger fallback requests', async () => {
  const replies = [
    new Response(JSON.stringify({ data: [{ b64_json: encoded + '\n' }] }), { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ data: [{ b64_json: encoded.slice(0, -1) + 'A' }] }), { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ data: [{ b64_json: encoded }, { b64_json: encoded }] }), { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ data: [{ url: 'https://untrusted.example/asset.jpg' }] }), { headers: { 'content-type': 'application/json' } }),
    new Response('{bad json', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    new Response('{"data":[]}', { headers: { 'content-type': 'text/html' } }),
  ];
  for (const reply of replies) {
    let calls = 0; const result = await generateImageCandidate(command, { apiKey, fetchImpl: transport(() => { calls++; return reply; }) });
    assert.equal(calls, 1); assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'invalid_response');
  }
});

test('optional metadata is checked and bounded usage retained without inventing missing counters or costs', async () => {
  const usage = { input_tokens: 12, input_tokens_details: { text_tokens: 10, image_tokens: 2 }, output_tokens: 30, total_tokens: 42 };
  const result = await generateImageCandidate(command, { apiKey, fetchImpl: transport(() => response({ model: 'gpt-image-2', size: '1536x1024', output_format: 'jpeg', usage })) });
  assert.equal(result.outcome, 'candidate_received'); assert.deepEqual(result.usage, { inputTokens: 12, inputTextTokens: 10, inputImageTokens: 2, outputTokens: 30, totalTokens: 42, outputImageTokens: null });
  assert.equal(Object.hasOwn(result, 'cost'), false);
  for (const extra of [{ model: 'other-model' }, { size: '1024x1024' }, { usage: { input_tokens: -1 } }, { usage: { input_tokens: 12, output_tokens: 30, total_tokens: 41 } }, { usage: { total_tokens: 1e15 } }]) {
    const invalid = await generateImageCandidate(command, { apiKey, fetchImpl: transport(() => response(extra)) });
    assert.equal(invalid.outcome, 'outcome_unknown'); assert.equal(invalid.code, 'invalid_response');
    assert.deepEqual(invalid.candidate!.bytes, image, 'known candidate survives bad metadata for durable recovery');
  }
});

test('timeout and caller abort after transport starts return unknown; no paid retry and safe error output', async () => {
  for (const abort of [false, true]) {
    let calls = 0; const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++; if (abort) controller.abort();
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error(apiKey + command.prompt)), { once: true }); });
    };
    const result = await generateImageCandidate(command, { apiKey, fetchImpl, timeoutMs: 10, signal: controller.signal });
    assert.equal(calls, 1); assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'transport_interrupted');
    assert.equal(JSON.stringify(result).includes(apiKey), false); assert.equal(JSON.stringify(result).includes(command.prompt), false);
  }
  let cancelled = false;
  const result = await generateImageCandidate(command, { apiKey, timeoutMs: 10, fetchImpl: transport(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } })) });
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(cancelled, true, 'stalled body shares the total deadline');
});

test('confirmed HTTP rejection differs from unknown server or transport failure; raw error bodies are never returned', async () => {
  for (const [status, expected] of [[401, 'rejected'], [429, 'rejected'], [500, 'outcome_unknown']] as const) {
    let calls = 0;
    const result = await generateImageCandidate(command, { apiKey, fetchImpl: transport(() => { calls++; return new Response(apiKey + command.prompt, { status }); }) });
    assert.equal(result.outcome, expected); assert.equal(result.httpStatus, status); assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes(apiKey), false);
  }
  const result = await generateImageCandidate(command, { apiKey, fetchImpl: async () => { throw new Error(apiKey); } });
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.httpStatus, null);
});


test('pure preparation privately freezes the exact wire identity reused by transport', async () => {
  const mutable = { ...command }; const prepared = prepareImageGenerationRequest(mutable);
  mutable.prompt = 'Owner edited a later prompt.';
  assert.equal(prepared.command.prompt, command.prompt); assert.ok(Object.isFrozen(prepared.command));
  assert.equal(prepared.requestSha256, sha(prepared.body));
  const metadata = JSON.parse(JSON.stringify(prepared));
  assert.equal(Object.hasOwn(metadata, 'body'), false); assert.equal(Object.hasOwn(metadata, 'command'), false);
  assert.equal(JSON.stringify(metadata).includes(command.prompt), false); assert.equal(JSON.stringify(metadata).includes(command.actorId), false);
  let calls = 0;
  const result = await generateImageCandidate(prepared.command, { apiKey, fetchImpl: async (_url, init) => {
    calls++; assert.equal(String(init?.body), prepared.body); return response();
  } });
  assert.equal(result.requestSha256, prepared.requestSha256); assert.equal(calls, 1);
});
