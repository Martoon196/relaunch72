import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicClient } from '../src/llm/client.js';
import { seoBlogRuntime } from '../src/portal/seo-blog-service.js';

// Inspect configuration only. No complete(), SDK request or provider call is made.
function sdk(client: AnthropicClient | null) {
  assert.ok(client);
  return (client as unknown as { client: { apiKey: string | null; authToken: string | null; maxRetries: number } }).client;
}

function withCredentials(values: Record<string, string | undefined>, check: () => void) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    check();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('explicit Anthropic key works without global credentials and does not mutate the environment', () => {
  withCredentials({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }, () => {
    const client = sdk(new AnthropicClient('synthetic-scoped-key'));
    assert.equal(client.apiKey, 'synthetic-scoped-key');
    assert.equal(client.authToken, null);
    assert.equal(client.maxRetries, 4);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
  });
});

test('explicit Anthropic key does not inherit an ambient bearer token', () => {
  withCredentials({ ANTHROPIC_API_KEY: 'synthetic-global-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-token' }, () => {
    const client = sdk(new AnthropicClient('synthetic-scoped-key'));
    assert.equal(client.apiKey, 'synthetic-scoped-key');
    assert.equal(client.authToken, null);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'synthetic-global-key');
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-token');
  });
});

test('no-argument Anthropic client preserves global API-key and bearer-token behaviour', () => {
  withCredentials({ ANTHROPIC_API_KEY: 'synthetic-global-key', ANTHROPIC_AUTH_TOKEN: undefined }, () => {
    assert.equal(sdk(new AnthropicClient()).apiKey, 'synthetic-global-key');
  });
  withCredentials({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: 'synthetic-token' }, () => {
    assert.equal(sdk(new AnthropicClient()).authToken, 'synthetic-token');
  });
  withCredentials({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }, () => {
    assert.throws(() => new AnthropicClient(), /No Anthropic credentials/);
    assert.throws(() => new AnthropicClient(' '), /explicit Anthropic API key must not be empty/);
  });
});

test('SEO composition prefers its scoped key without requiring or mutating the global environment', () => {
  withCredentials({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: 'synthetic-token' }, () => {
    const runtime = seoBlogRuntime({ SEO_BLOG_ANTHROPIC_API_KEY: 'synthetic-scoped-key', ANTHROPIC_API_KEY: 'synthetic-fallback' });
    const client = sdk(runtime.llm as AnthropicClient | null);
    assert.equal(client.apiKey, 'synthetic-scoped-key');
    assert.equal(client.authToken, null);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-token');
  });
});

test('SEO generation off remains unavailable with a scoped credential; existing global fallback remains supported', () => {
  assert.equal(seoBlogRuntime({ SEO_BLOG_ANTHROPIC_API_KEY: 'synthetic-scoped-key', SEO_BLOG_GENERATION: 'off' }).llm, null);
  assert.equal(seoBlogRuntime({}).llm, null);
  withCredentials({ ANTHROPIC_API_KEY: 'synthetic-global-key', ANTHROPIC_AUTH_TOKEN: undefined }, () => {
    const runtime = seoBlogRuntime({ ANTHROPIC_API_KEY: 'synthetic-global-key' });
    assert.equal(sdk(runtime.llm as AnthropicClient | null).apiKey, 'synthetic-global-key');
  });
});
