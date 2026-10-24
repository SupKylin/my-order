import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgementDecision,
  mapOrderLine,
  platformDate,
  sourceKey,
} from '../src/services/walmart/mapping.js';
import { acknowledgePersistedOrder } from '../src/services/walmart/acknowledgement.js';
import { WalmartClient } from '../src/services/walmart/client.js';
import { validatePatch } from '../src/validation.js';

function order(status = 'Created') {
  return {
    purchaseOrderId: 'PO-1',
    customerOrderId: 'CUSTOMER-1',
    orderDate: 1791558000000,
    shipNode: { type: 'SellerFulfilled' },
    shippingInfo: { estimatedShipDate: 1791558000000 },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'SKU-1', productName: '标题中的蓝色不得作为变体' },
          orderLineQuantity: { amount: '3' },
          charges: {
            charge: [
              { chargeType: 'PRODUCT', chargeAmount: { amount: 0.1, currency: 'USD' } },
              { chargeType: 'PRODUCT', chargeAmount: { amount: 0.2, currency: 'USD' } },
            ],
          },
          orderLineStatuses: { orderLineStatus: [{ status }] },
        },
      ],
    },
  };
}

test('Walmart 资助使用原商品金额加运费，激励不重复加回，其他优惠仍用成交价', () => {
  const raw = order();
  const line = raw.orderLines.orderLine[0];
  line.orderLineQuantity.amount = '1';
  line.charges.charge = [
    {
      chargeType: 'PRODUCT',
      chargeAmount: { amount: '49.59', currency: 'USD' },
      tax: { taxAmount: { amount: '3.22' } },
    },
    {
      chargeType: 'SHIPPING',
      chargeAmount: { amount: '25.99', currency: 'USD' },
      tax: { taxAmount: { amount: '1.69' } },
    },
  ];
  line.incentive = {
    type: 'Walmart funded',
    originalPrice: { amount: '55.09', currency: 'USD' },
    walmartFundedIncentive: { amount: '-5.50', currency: 'USD' },
  };
  const mapped = () => mapOrderLine({ id: 1, systemStoreName: '测试' }, raw, line);
  assert.equal(mapped().fields.orderAmount, '81.08000000000000000000');
  assert.equal(mapped().fields.tax, '4.91000000000000000000');
  assert.deepEqual(mapped().walmart.incentive, line.incentive);
  assert.equal(mapped().fields.quantity, '1');
  line.charges.charge[0].chargeAmount.amount = '55.09';
  assert.equal(mapped().fields.orderAmount, '81.08000000000000000000');
  line.charges.charge[0].chargeAmount.amount = '49.59';
  for (const type of ['Reduced referral', 'Seller funded', 'UNKNOWN']) {
    line.incentive.type = type;
    assert.equal(mapped().fields.orderAmount, '75.58000000000000000000');
  }
  line.incentive.type = 'Walmart funded';
  for (const original of [
    null,
    { amount: '-1', currency: 'USD' },
    { amount: '55.09', currency: 'EUR' },
  ]) {
    line.incentive.originalPrice = original;
    assert.throws(mapped, /金额|USD/);
  }
  delete line.incentive;
  assert.equal(mapped().fields.orderAmount, '75.58000000000000000000');
});

test('多件资助订单以原单价乘商品数量，运费与普通费用不重复乘数量', () => {
  const raw = order();
  const line = raw.orderLines.orderLine[0];
  line.orderLineQuantity.amount = '2';
  line.charges.charge = [
    { chargeType: 'PRODUCT', chargeAmount: { amount: '165.78', currency: 'USD' } },
    { chargeType: 'SHIPPING', chargeAmount: { amount: '10', currency: 'USD' } },
  ];
  line.incentive = {
    type: 'Walmart funded',
    originalPrice: { amount: '90.77', currency: 'USD' },
    walmartFundedIncentive: { amount: '-7.88', currency: 'USD' },
  };
  const mapped = () => mapOrderLine({ id: 1, systemStoreName: '测试' }, raw, line);
  assert.equal(Number(mapped().fields.orderAmount), 191.54);
  line.incentive.originalPrice.amount = '31.50';
  line.charges.charge = [{ chargeType: 'PRODUCT', chargeAmount: { amount: '57.94', currency: 'USD' } }];
  assert.equal(Number(mapped().fields.orderAmount), 63);
  for (const quantity of ['', '0', '-1', '1.5']) {
    line.orderLineQuantity.amount = quantity;
    assert.throws(mapped, /数量/);
  }
  line.orderLineQuantity.amount = '2';
  delete line.incentive;
  assert.equal(Number(mapped().fields.orderAmount), 57.94);
});

test('订单列表、后续游标与详情查询均请求 incentiveInfo', async () => {
  const urls = [];
  const client = new WalmartClient(
    { clientId: 'id', clientSecret: 'secret' },
    {
      fetchImpl: async (url) => {
        if (url.pathname === '/v3/token')
          return new Response(JSON.stringify({ access_token: 'token' }));
        urls.push(url);
        if (url.pathname === '/v3/orders/PO-1')
          return new Response(JSON.stringify({ order: order() }));
        return new Response(
          JSON.stringify({
            list: {
              elements: { order: [] },
              meta: { nextCursor: url.searchParams.has('cursor') ? null : '?cursor=2' },
            },
          }),
        );
      },
    },
  );
  for await (const _ of client.orders(new Date(), new Date())) {
  }
  await client.order('PO-1');
  assert.equal(urls.length, 7);
  assert.ok(urls.every((url) => url.searchParams.get('incentiveInfo') === 'true'));
});

test('自动确认回执省略激励时保留刚查询的金额，避免保存后降回优惠价', async () => {
  const latest = order();
  latest.orderLines.orderLine[0].incentive = {
    type: 'Walmart funded',
    originalPrice: { amount: '55.09', currency: 'USD' },
  };
  for (const missing of [undefined, null]) {
    const saved = [];
    const acknowledged = order('Acknowledged');
    if (missing === null) acknowledged.orderLines.orderLine[0].incentive = null;
    const result = await acknowledgePersistedOrder({
      purchaseOrderId: 'PO-1',
      client: { order: async () => latest, acknowledge: async () => acknowledged },
      save: async (raw) =>
        saved.push(
          mapOrderLine({ id: 1, systemStoreName: '测试' }, raw, raw.orderLines.orderLine[0]),
        ),
      mark: async () => {},
    });
    assert.equal(result, 'acknowledged');
    assert.equal(saved[0].fields.orderAmount, saved[1].fields.orderAmount);
    assert.equal(saved[1].fields.orderAmount, '165.27000000000000000000');
  }
});

test('取消申请按商品行独立保存，不将已确认改为已取消，FALSE 不误判为真', () => {
  const raw = order('Acknowledged');
  const line = raw.orderLines.orderLine[0];
  for (const [value, expected] of [
    ['TRUE', true],
    [true, true],
    [' true ', true],
    ['FALSE', false],
    [false, false],
    [undefined, false],
    [null, false],
    ['', false],
  ]) {
    line.intentToCancel = value;
    const result = mapOrderLine({ id: 1, systemStoreName: '店铺' }, raw, line);
    assert.equal(result.walmart.intentToCancel, expected);
    assert.equal(result.fields.platformOrderStatus, '已确认');
    assert.equal(result.fields.purchaseStatus, undefined);
  }
});

test('官方图片直接映射到商品图片字段，缺失图片清空旧值，不接受其他域名', () => {
  const raw = order();
  const line = raw.orderLines.orderLine[0];
  const url = 'https://i5.walmartimages.com/test-product.jpeg';
  line.item.imageUrl = url;
  const mapped = mapOrderLine({ id: 1, systemStoreName: '系统店铺' }, raw, line);
  assert.equal(mapped.fields.productImage, url);
  assert.equal(mapped.walmart.imageUrl, url);
  assert.equal(validatePatch(mapped.fields).productImage, url);
  for (const invalid of [
    undefined,
    'https://other.example/image.png',
    'https://walmartimages.com.example/image.png',
    'https://i5.walmartimages.com:3000/image.png',
    'https://user@i5.walmartimages.com/image.png',
  ]) {
    line.item.imageUrl = invalid;
    assert.equal(
      mapOrderLine({ id: 1, systemStoreName: '店铺' }, raw, line).fields.productImage,
      null,
    );
  }
  assert.throws(
    () => validatePatch({ productImage: 'https://other.example/image.png' }),
    /字段校验/,
  );
});

test('只确认所有商品行为 Created 的卖家自配送订单，混合/缺失状态和 WFS 跳过', () => {
  assert.equal(acknowledgementDecision(order()).action, 'acknowledge');
  for (const status of ['Acknowledged', 'Shipped', 'Cancelled', 'Delivered'])
    assert.equal(acknowledgementDecision(order(status)).action, 'skip');
  const wfs = order();
  wfs.shipNode.type = 'WFSFulfilled';
  assert.equal(acknowledgementDecision(wfs).action, 'skip');
  const mixed = order();
  mixed.orderLines.orderLine.push(order('Cancelled').orderLines.orderLine[0]);
  assert.equal(acknowledgementDecision(mixed).action, 'review');
  const empty = order();
  empty.orderLines.orderLine[0].orderLineStatuses.orderLineStatus = [];
  assert.equal(acknowledgementDecision(empty).action, 'review');
});

test('字段只按接口映射，平台状态不覆盖内部状态，费用不乘数量', () => {
  const raw = order();
  const line = raw.orderLines.orderLine[0];
  const result = mapOrderLine({ id: 1, systemStoreName: '系统店铺' }, raw, line, {
    item: {
      variantGroupId: 'group',
      variantGroupInfo: {
        groupingAttributes: [
          { name: 'actual_color', value: 'Red' },
          { name: 'pattern', value: 'Card Bag' },
        ],
      },
    },
  });
  assert.equal(result.fields.orderAmount, '0.30000000000000000000');
  assert.equal(result.fields.quantity, '3');
  assert.equal(result.fields.orderStatus, undefined);
  assert.equal(result.fields.purchaseStatus, undefined);
  assert.equal(result.fields.platformOrderStatus, '待确认');
  assert.equal(result.fields.productSpecification, 'Red, Card Bag');
  assert.equal(result.walmart.attributes[0].value, 'Red');
  assert.deepEqual(
    mapOrderLine({ id: 1, systemStoreName: '店铺' }, raw, line).walmart.attributes,
    [],
  );
  assert.equal(platformDate(Date.UTC(2026, 9, 9, 7, 0)), '2026-10-08');
  assert.equal(
    sourceKey('店铺A', raw, line),
    sourceKey('店铺A', { ...raw, purchaseOrderId: 'NEW-PO' }, { ...line, lineNumber: '2' }),
  );
  assert.notEqual(
    sourceKey('店铺A', raw, line),
    sourceKey('店铺A', raw, { ...line, item: { sku: 'OTHER' } }),
  );
  assert.notEqual(sourceKey('店铺A', raw, line), sourceKey('店铺B', raw, line));
  assert.notEqual(
    sourceKey('店铺A', raw, line),
    sourceKey('店铺A', { ...raw, customerOrderId: 'OTHER' }, line),
  );
  assert.equal(
    mapOrderLine({ id: 1, systemStoreName: '店铺' }, raw, line, { item: {} }).fields
      .productSpecification,
    null,
  );
  assert.equal(
    Object.hasOwn(
      mapOrderLine({ id: 1, systemStoreName: '店铺' }, raw, line, { error: 'timeout' }).fields,
      'productSpecification',
    ),
    false,
  );
});

test('订单金额精确合计商品和运费，不含税费或其他费用，履约方保留接口原值', () => {
  const raw = order();
  const line = raw.orderLines.orderLine[0];
  line.charges.charge.push(
    {
      chargeType: 'SHIPPING',
      chargeAmount: { amount: '0.45', currency: 'USD' },
      tax: { taxAmount: { amount: '0.03' } },
    },
    { chargeType: 'FEE', chargeAmount: { amount: '10', currency: 'USD' } },
  );
  raw.shipNode.type = 'WFSFulfilled';
  const mapped = mapOrderLine({ id: 1, systemStoreName: '测试' }, raw, line);
  assert.equal(mapped.fields.orderAmount, '0.75000000000000000000');
  assert.equal(mapped.fields.tax, '0.03000000000000000000');
  assert.equal(mapped.fields.fulfillmentParty, 'WFSFulfilled');
});

test('保存提交后才能确认；保存失败和实时取消不会发 POST', async () => {
  let posts = 0;
  const events = [];
  const client = {
    order: async () => order(),
    acknowledge: async () => {
      posts++;
      events.push('post');
      return order('Acknowledged');
    },
  };
  assert.equal(
    await acknowledgePersistedOrder({
      purchaseOrderId: 'PO-1',
      client,
      save: async () => {
        throw new Error('数据库事务失败');
      },
      mark: async (s) => events.push(s),
    }),
    'failed',
  );
  assert.equal(posts, 0);
  assert.equal(
    await acknowledgePersistedOrder({
      purchaseOrderId: 'PO-1',
      client: { ...client, order: async () => order('Cancelled') },
      save: async () => {},
      mark: async () => {},
    }),
    'skip',
  );
  assert.equal(posts, 0);
  events.length = 0;
  assert.equal(
    await acknowledgePersistedOrder({
      purchaseOrderId: 'PO-1',
      client,
      save: async () => {
        events.push('committed');
      },
      mark: async (s) => events.push(s),
    }),
    'acknowledged',
  );
  assert.deepEqual(events, ['committed', 'sending', 'post', 'committed', 'acknowledged']);
});

test('确认超时后下一次先 GET，远端已确认则不重复 POST', async () => {
  let remote = order();
  let posts = 0;
  const client = {
    order: async () => remote,
    acknowledge: async () => {
      posts++;
      remote = order('Acknowledged');
      throw new Error('timeout');
    },
  };
  const args = { purchaseOrderId: 'PO-1', client, save: async () => {}, mark: async () => {} };
  assert.equal(await acknowledgePersistedOrder(args), 'failed');
  assert.equal(await acknowledgePersistedOrder(args), 'skip');
  assert.equal(posts, 1);
});

test('接口解析 ItemResponse，POST 确认不直接重试，错误不泄露密钥', async () => {
  const requests = [];
  const client = new WalmartClient(
    { clientId: 'private-id', clientSecret: 'private-secret' },
    {
      fetchImpl: async (url, options) => {
        requests.push({ path: url.pathname, options });
        if (url.pathname === '/v3/token')
          return new Response(JSON.stringify({ access_token: 'private-token', expires_in: 900 }));
        if (url.pathname.includes('/items/'))
          return new Response(
            JSON.stringify({
              ItemResponse: [{ sku: 'SKU-1', variantGroupInfo: { groupingAttributes: [] } }],
            }),
          );
        return new Response('private-secret private-token', { status: 500 });
      },
      sleep: async () => {},
    },
  );
  assert.equal((await client.item('SKU-1')).sku, 'SKU-1');
  await assert.rejects(
    client.acknowledge('PO-1'),
    (error) => /HTTP 500/.test(error.message) && !/private/.test(error.message),
  );
  assert.equal(requests.filter((r) => r.path.endsWith('acknowledge')).length, 1);
  assert.equal(requests.at(-1).options.headers['WM_SEC.ACCESS_TOKEN'], 'private-token');
});

test('订单列表分页阻止外部地址，不将 token 传到其他站点', async () => {
  let count = 0;
  const client = new WalmartClient(
    { clientId: 'id', clientSecret: 'secret' },
    {
      fetchImpl: async (url) => {
        count++;
        if (url.pathname === '/v3/token')
          return new Response(JSON.stringify({ access_token: 'token' }));
        return new Response(
          JSON.stringify({
            list: {
              elements: { order: [] },
              meta: { nextCursor: 'https://invalid.example/v3/orders?cursor=1' },
            },
          }),
        );
      },
    },
  );
  await assert.rejects(async () => {
    for await (const _ of client.orders(new Date(), new Date())) {
    }
  }, /分页地址无效/);
  assert.equal(count, 2);
});
