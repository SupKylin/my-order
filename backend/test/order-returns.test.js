import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/models.js';
import { compactReturn, returnStatus, fetchReturnOrders } from '../src/services/walmart/returns.js';
after(() => db.close());
export function returnSample(
  id = 'R1',
  customer = 'C1',
  po = 'PO1',
  sku = 'SKU-A',
  status = 'REFUND_COMPLETED',
) {
  return {
    returnOrderId: id,
    customerOrderId: customer,
    returnOrderDate: '2026-10-20T10:00:00Z',
    customerName: { firstName: 'private' },
    returnOrderLines: [
      {
        returnOrderLineNumber: 1,
        purchaseOrderId: po,
        item: { sku },
        status: 'COMPLETED',
        currentRefundStatus: status,
        quantity: { measurementValue: 1 },
        refundedQty: status === 'REFUND_COMPLETED' ? 1 : 0,
        chargeTotals: [
          { name: 'lineTotal', value: { currencyAmount: '12.34', currencyUnit: 'USD' } },
        ],
        currentTrackingStatuses: [
          { currentRefundStatus: 'REFUND_COMPLETED', statusTime: '2026-10-21T10:00:00Z' },
        ],
      },
    ],
  };
}
test('退货完成不等于退款完成；处理中/已取消不显示旧退款完成时间', () => {
  assert.equal(
    returnStatus({ status: 'COMPLETED', currentRefundStatus: 'NOT_REFUNDED' }),
    '申请中',
  );
  for (const status of ['REFUND_INITIATED', 'REFUND_PENDING']) {
    const data = compactReturn(returnSample('R', 'C', 'P', 'S', status));
    assert.equal(data.lines[0].status, '退款处理中');
    assert.equal(data.lines[0].completedAt, null);
  }
  assert.equal(returnStatus({ currentRefundStatus: 'REFUND_CANCELLED' }), '已取消');
  assert.equal(returnStatus({ currentRefundStatus: 'UNKNOWN' }), '状态待核实');
  const data = compactReturn(returnSample());
  assert.equal(data.lines[0].amount, '12.34');
  assert.equal(data.lines[0].completedAt, '2026-10-21T10:00:00.000Z');
  assert.ok(!JSON.stringify(data).includes('private'));
  const invalid = returnSample();
  invalid.returnOrderLines[0].chargeTotals = [];
  assert.equal(compactReturn(invalid).lines[0].amount, null);
});
test('分页、七天窗口重叠去重，不过滤申请状态或WFS', async () => {
  const paths = [];
  const data = await fetchReturnOrders(
    {
      request: async (path) => {
        paths.push(path);
        const url = new URL(path, 'https://marketplace.walmartapis.com');
        assert.equal(url.searchParams.has('status'), false);
        assert.equal(url.searchParams.has('isWFSEnabled'), false);
        const page = url.searchParams.get('offset');
        return {
          meta: { totalCount: 2, ...(!page ? { nextCursor: '?offset=1' } : {}) },
          returnOrders: [returnSample(page ? 'R2' : 'R1')],
        };
      },
    },
    new Date('2026-10-01T08:00:00Z'),
    new Date('2026-10-09T08:00:00Z'),
  );
  assert.equal(paths.length, 4);
  assert.equal(data.length, 2);
  assert.ok(
    paths.every(
      (p) => p.includes('returnLastModifiedStartDate') && p.includes('returnLastModifiedEndDate'),
    ),
  );
});
test('不完整分页、跨域游标、重复行及暂停时拒绝推进', async () => {
  const from = new Date('2026-10-01T08:00:00Z'),
    to = new Date('2026-10-02T08:00:00Z');
  await assert.rejects(
    fetchReturnOrders(
      { request: async () => ({ meta: { totalCount: 2 }, returnOrders: [returnSample()] }) },
      from,
      to,
    ),
    /分页未完整/,
  );
  await assert.rejects(
    fetchReturnOrders(
      {
        request: async () => ({
          meta: { totalCount: 2, nextCursor: 'https://example.com/v3/returns' },
          returnOrders: [],
        }),
      },
      from,
      to,
    ),
    /地址无效/,
  );
  await assert.rejects(
    fetchReturnOrders({ request: async () => assert.fail() }, from, to, async () => false),
    /已暂停/,
  );
  const raw = returnSample();
  raw.returnOrderLines.push(raw.returnOrderLines[0]);
  assert.throws(() => compactReturn(raw), /行号重复/);
});
