import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
const request = (path, options) => worker.fetch(new Request(`https://test.invalid${path}`, options), {});
test('public health endpoint reports configuration without exposing a secret', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.authConfigured, false);
});
test('protected endpoints require a configured bearer token', async () => {
  assert.equal((await request('/api/auctions')).status, 503);
  const res = await worker.fetch(new Request('https://test.invalid/api/auctions'), {ADMIN_TOKEN:'1234567890123456'});
  assert.equal(res.status,401);
});
test('dashboard assets are passed to the assets binding', async () => {
  const res = await worker.fetch(new Request('https://test.invalid/'), {ASSETS: {fetch: async()=>new Response('dashboard')}});
  assert.equal(await res.text(), 'dashboard');
});
