import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walmartFetch } from '../src/services/walmart/transport.js';

test('仅Windows读取及令牌网络故障使用备用连接，不重发业务写入、不绕过证书错误', async () => {
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  });
  let calls = 0;
  const settings = {
    platform: 'win32',
    fetchImpl: async () => {
      throw error;
    },
    fallback: async () => {
      calls++;
      return new Response('{}');
    },
  };
  const origin = 'https://marketplace.walmartapis.com';
  await walmartFetch(origin + '/v3/returns', { method: 'GET' }, settings);
  await walmartFetch(origin + '/v3/token', { method: 'POST' }, settings);
  assert.equal(calls, 2);
  await assert.rejects(walmartFetch(origin + '/v3/orders/p/refund', { method: 'POST' }, settings));
  await assert.rejects(
    walmartFetch(origin + '/v3/orders/p/acknowledge', { method: 'POST' }, settings),
  );
  await assert.rejects(
    walmartFetch(origin + '/v3/returns', { method: 'GET' }, { ...settings, platform: 'linux' }),
  );
  await assert.rejects(
    walmartFetch('https://other.example/v3/returns', { method: 'GET' }, settings),
  );
  await assert.rejects(
    walmartFetch(origin + '/v3/returns', { method: 'GET', signal: AbortSignal.abort() }, settings),
  );
  error.cause.code = 'CERT_HAS_EXPIRED';
  await assert.rejects(walmartFetch(origin + '/v3/returns', { method: 'GET' }, settings));
  assert.equal(calls, 2);
});
test('成功和HTTP错误原样返回，不切换连接', async () => {
  for (const status of [200, 401, 429, 500]) {
    const result = await walmartFetch(
      'https://marketplace.walmartapis.com/v3/returns',
      { method: 'GET' },
      {
        platform: 'win32',
        fetchImpl: async () => new Response('{}', { status }),
        fallback: async () => {
          throw new Error('unexpected fallback');
        },
      },
    );
    assert.equal(result.status, status);
  }
});
