import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callTrack123Mcp,
  getTrack123Endpoint,
  listTrack123Endpoints,
} from '../src/services/track123-mcp.js';

const transport = (content) => async (url, options) => {
  assert.equal(url, 'https://docs.track123.com/mcp');
  assert.equal(options.headers['Track123-Api-Secret'], undefined);
  assert.equal(JSON.parse(options.body).method, 'tools/call');
  return new Response(
    `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(content) }] }, jsonrpc: '2.0', id: 1 })}\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
};

test('MCP 仅允许读取文档，统一列表与搜索结果格式', async () => {
  await assert.rejects(callTrack123Mcp('execute-request', {}, transport({})), { status: 400 });
  const list = await listTrack123Endpoints(
    '',
    transport({ '/tk/v2.1/track/query': { post: 'Get trackings' } }),
  );
  assert.deepEqual(list, [
    { method: 'POST', path: '/tk/v2.1/track/query', summary: 'Get trackings' },
  ]);
  const search = await listTrack123Endpoints(
    'tracking',
    transport([
      {
        endpoints: [
          { method: 'POST', path: '/tk/v2.1/track/import', summary: 'Register trackings' },
        ],
      },
    ]),
  );
  assert.equal(search[0].path, '/tk/v2.1/track/import');
});

test('MCP 接口详情只返回请求结构，不转发响应中的客户数据', async () => {
  const detail = await getTrack123Endpoint(
    '/tk/v2.1/track/query',
    'POST',
    transport({
      paths: {
        '/tk/v2.1/track/query': {
          post: {
            summary: 'Get trackings',
            parameters: [{ name: 'Track123-Api-Secret', in: 'header', required: true }],
            requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
            responses: { 200: { example: { customerEmail: 'private@example.com' } } },
          },
        },
      },
    }),
  );
  assert.equal(detail.summary, 'Get trackings');
  assert.equal(detail.requestSchema.type, 'object');
  assert.equal(JSON.stringify(detail).includes('private@example.com'), false);
});
