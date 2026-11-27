import test from 'node:test';
import assert from 'node:assert/strict';
import { publicShipment, track123Request } from '../src/services/track123.js';

test('Track123 请求只发送单号和服务端密钥，按业务码判断成功', async () => {
  const calls = [];
  const data = await track123Request('import', [{ trackNo: 'T-123' }], {
    secret: 'test-secret',
    transport: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({ code: '00000', data: { accepted: [{ trackNo: 'T-123' }], rejected: [] } }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(data.accepted, [{ trackNo: 'T-123' }]);
  assert.equal(calls[0].url, 'https://api.track123.com/gateway/open-api/tk/v2.1/track/import');
  assert.equal(calls[0].options.headers['Track123-Api-Secret'], 'test-secret');
  assert.equal(calls[0].options.body, '[{"trackNo":"T-123"}]');
  await assert.rejects(
    track123Request('query', {}, { secret: '', transport: () => assert.fail('不应发起请求') }),
    { status: 424 },
  );
  await assert.rejects(
    track123Request(
      'query',
      {},
      {
        secret: 'test-secret',
        transport: async () => new Response('{"code":"A0400","msg":"failed"}'),
      },
    ),
    { status: 502 },
  );
});

test('仅向页面返回物流状态和轨迹，不返回 Track123 关联的客户信息', () => {
  const shipment = publicShipment({
    trackNo: 'T-123',
    customerEmail: 'private@example.com',
    orderNo: 'other-order',
    transitStatus: 'IN_TRANSIT',
    localLogisticsInfo: {
      courierNameEN: 'Carrier',
      trackingDetails: [{ eventTime: '2026-11-27 12:00:00', eventDetail: 'In transit' }],
    },
  });
  assert.equal(shipment.transitStatus, 'IN_TRANSIT');
  assert.equal(shipment.localLogisticsInfo.trackingDetails.length, 1);
  assert.equal(JSON.stringify(shipment).includes('private@example.com'), false);
  assert.equal(JSON.stringify(shipment).includes('other-order'), false);
});
