import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, MODELS, DEFAULT_MODEL, endpointFor, priceOf, costOf, errorOf, scrubKey, clampTokens
} from './ai-providers.js';

test('every provider has a default model, and it is in the price table', () => {
  for (const id of Object.keys(PROVIDERS)) {
    assert.ok(DEFAULT_MODEL[id], id + ' has no default model');
    assert.ok(priceOf(id, DEFAULT_MODEL[id]), id + ' defaults to an unpriced model');
  }
});

test('the endpoint host is fixed per provider', () => {
  assert.equal(new URL(endpointFor('anthropic', 'claude-sonnet-5')).host, 'api.anthropic.com');
  assert.equal(new URL(endpointFor('openai', 'gpt-5-mini')).host, 'api.openai.com');
  assert.equal(new URL(endpointFor('gemini', 'gemini-3.7-flash')).host, 'generativelanguage.googleapis.com');
});

test('a model id cannot escape the URL path', () => {
  // Only Gemini puts the model in the path, but the guard is unconditional: a model id is
  // client-supplied, and this is the one place it becomes part of a URL.
  for (const bad of ['../../v1beta/models/x', 'a/b', 'http://evil.test/', '', 'x'.repeat(200), 'a b']) {
    assert.throws(() => endpointFor('gemini', bad), /bad model id/, JSON.stringify(bad));
  }
});

test('an unknown provider throws instead of guessing', () => {
  assert.throws(() => endpointFor('ollama', 'llama3'), /unknown provider/);
});

test('the key goes in the header each provider actually reads', () => {
  assert.deepEqual(PROVIDERS.anthropic.headers('K'), { 'x-api-key': 'K', 'anthropic-version': '2023-06-01' });
  assert.deepEqual(PROVIDERS.openai.headers('K'), { authorization: 'Bearer K' });
  assert.deepEqual(PROVIDERS.gemini.headers('K'), { 'x-goog-api-key': 'K' });
});

test('usage is read from each provider’s own field names', () => {
  assert.deepEqual(PROVIDERS.anthropic.usageOf({ usage: { input_tokens: 12, output_tokens: 3 } }), { in: 12, out: 3 });
  assert.deepEqual(PROVIDERS.openai.usageOf({ usage: { input_tokens: 12, output_tokens: 3 } }), { in: 12, out: 3 });
  assert.deepEqual(
    PROVIDERS.gemini.usageOf({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } }),
    { in: 12, out: 3 }
  );
});

test('a response with no usage prices as zero, not as NaN', () => {
  for (const id of Object.keys(PROVIDERS)) {
    assert.deepEqual(PROVIDERS[id].usageOf({}), { in: 0, out: 0 });
  }
});

test('cost matches the published rate', () => {
  // Sonnet 5 at $2/$10 per million: 1500 in + 800 out.
  assert.equal(costOf('anthropic', 'claude-sonnet-5', { in: 1500, out: 800 }), 0.011);
});

test('an unpriced model costs null, not zero', () => {
  assert.equal(costOf('anthropic', 'claude-something-new', { in: 1000, out: 1000 }), null);
  assert.equal(costOf('nope', 'x', { in: 1, out: 1 }), null);
});

test('anything key-shaped is scrubbed out of a provider error', () => {
  assert.equal(scrubKey('invalid x-api-key: sk-ant-api03-AbCdEfGh12345678xyz'), 'invalid x-api-key: sk-ant-***');
  assert.equal(scrubKey('bad Bearer sk-proj-QQQQWWWWEEEERRRR'), 'bad Bearer sk-***');
  assert.equal(scrubKey('key AIzaSyA1B2C3D4E5F6G7H8 rejected'), 'key AIza*** rejected');
  assert.equal(scrubKey(null), '');
});

test('a provider error message is found wherever that provider nests it', () => {
  assert.equal(errorOf(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 'invalid x-api-key');
  assert.equal(errorOf(400, { error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } }), 'API key not valid');
  assert.equal(errorOf(502, null, '<html>Bad Gateway</html>'), '<html>Bad Gateway</html>');
  assert.equal(errorOf(500, {}), 'provider returned HTTP 500');
});

test('the output ceiling is applied in each provider’s own field', () => {
  assert.equal(clampTokens('anthropic', { max_tokens: 999999 }, 4096).max_tokens, 4096);
  assert.equal(clampTokens('openai', { max_output_tokens: 999999 }, 4096).max_output_tokens, 4096);
  assert.equal(clampTokens('gemini', { generationConfig: { maxOutputTokens: 999999 } }, 4096).generationConfig.maxOutputTokens, 4096);
});

test('a body that omits the ceiling gets one anyway', () => {
  // The field is the direct lever on what one call can cost, so "unset" must not mean "unbounded".
  assert.equal(clampTokens('anthropic', {}, 4096).max_tokens, 4096);
  assert.equal(clampTokens('openai', {}, 4096).max_output_tokens, 4096);
  assert.equal(clampTokens('gemini', {}, 4096).generationConfig.maxOutputTokens, 4096);
});

test('a request asking for less than the ceiling keeps what it asked for', () => {
  assert.equal(clampTokens('anthropic', { max_tokens: 512 }, 4096).max_tokens, 512);
});

test('every listed model is priced', () => {
  for (const [provider, list] of Object.entries(MODELS)) {
    for (const m of list) {
      assert.ok(m.in > 0 && m.out > 0, provider + '/' + m.id + ' has no price');
      assert.ok(m.label, provider + '/' + m.id + ' has no label');
    }
  }
});
