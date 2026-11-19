import test from 'node:test';
import assert from 'node:assert/strict';
import { itemProfit } from '../src/lib/order-profit.js';
import { sellerRefundLookup } from '../src/services/home/seller-refund.js';
import { fetchReconciliation } from '../src/services/home/reconciliation.js';
import { fieldMap } from '../src/fields.js';
import { fetchRemoteMetrics, REMOTE_METRICS } from '../src/services/home/remote.js';
import { RETURNS_VERSION } from '../src/services/home/returns.js';

const item = () => ({
  order: { orderNumber: 'ORDER-A' },
  orderAmount: '197.96',
  purchase: {
    settlement: '已结算',
    commissionRate: '12',
    purchaseCost: '70',
    disputeSuccessAmount: '88.58',
  },
  returnInfo: {
    lines: [
      {
        returnOrderId: 'R1',
        lineNumber: '1',
        status: '已退款',
        amount: '104.42',
        currency: 'USD',
        sku: 'SKU-A',
        purchaseOrderId: 'PO-A',
        completedAt: '2026-11-11T17:29:15Z',
      },
    ],
  },
});
// 金额分项复现2026-11-18已核对的官方交易，订单标识使用测试值。
function reports(extra = []) {
  const components = [
    ['Product price', '-78.99'],
    ['Shipping', '-19.99'],
    ['Product tax', '-4.34'],
    ['Shipping tax', '-1.10'],
    ['Product tax withheld', '4.34'],
    ['Shipping tax withheld', '1.10'],
    ['Commission on product', '8.30'],
    ['Commission on shipping', '2.10'],
  ].map(([type, amount]) => ({
    'Transaction Type': 'Refund',
    'Transaction Key': 'TX-A',
    'Customer Order #': 'ORDER-A',
    'Partner Item Id': 'SKU-A',
    'Purchase Order #': 'PO-A',
    'Amount Type': type,
    Amount: amount,
    'Transaction Posted Timestamp': '11/11/2026',
    Currency: 'USD',
  }));
  const rows = [
    {
      'Transaction Type': 'PaymentSummary',
      'Period Start Date': '11/01/2026',
      'Period End Date': '11/15/2026',
      'Total Payable': '10',
    },
    ...components,
    ...extra,
  ];
  return {
    rows,
    components,
    client: {
      request: async (url) =>
        url.includes('availableReconFiles')
          ? { availableApReportDates: ['11172026'] }
          : { reportData: rows, nextOffset: -1, totalRecords: rows.length },
    },
  };
}
test('Walmart退款只采用官方净扣款，旧手填数据不再参与展示或利润', () => {
  const row = item();
  row.purchase.sellerRefundManualAmount = '88.58';
  row.purchase.sellerRefundBasis = 'legacy';
  assert.equal(itemProfit(row).walmartRefundAmount, null);
  assert.equal(itemProfit(row).orderProfit, null);
  row.sellerRefund = { amount: '88.58', through: '2026-11-15' };
  assert.equal(itemProfit(row).walmartRefundAmount, '88.58');
  assert.equal(itemProfit(row).orderProfit, '104.20');
  for (const key of ['refundBasisToken', 'sellerRefundManualStale', 'walmartRefundSource'])
    assert.equal(Object.hasOwn(itemProfit(row), key), false);
  row.sellerRefund.amount = '0';
  assert.equal(itemProfit(row).walmartRefundAmount, '0.00');
  assert.equal(itemProfit(row).orderProfit, '192.78');
});
test('已退款明细按退货单和行去重，重复冲突或缺少标识不使用官方净额', async () => {
  const cache = await fetchReconciliation(reports().client);
  const row = item();
  row.returnInfo.lines.push({ ...row.returnInfo.lines[0] });
  assert.equal(sellerRefundLookup(cache)(row).amount, '88.58');
  for (const key of ['amount', 'sku', 'purchaseOrderId', 'completedAt']) {
    const conflicting = structuredClone(row);
    conflicting.returnInfo.lines[1][key] = key === 'amount' ? '99' : 'OTHER';
    assert.equal(sellerRefundLookup(cache)(conflicting), null, key);
  }
  for (const key of ['returnOrderId', 'lineNumber']) {
    const invalid = item();
    delete invalid.returnInfo.lines[0][key];
    assert.equal(sellerRefundLookup(cache)(invalid), null);
  }
});
test('报表按订单/SKU/PO匹配净扣款，争议不并入退款', async () => {
  const fixture = reports([{ 'Transaction Type': 'Dispute Settlement', Amount: '88.58' }]);
  fixture.rows.push(fixture.components[0]); // 重复页/报表不重复扣款
  const cache = await fetchReconciliation(fixture.client);
  const row = item();
  row.sellerRefund = sellerRefundLookup(cache)(row);
  assert.deepEqual(row.sellerRefund, { amount: '88.58', through: '2026-11-15' });
  assert.equal(itemProfit(row).orderProfit, '104.20');
  assert.equal(itemProfit(row).walmartRefundAmount, '88.58');
  assert.equal(Object.hasOwn(itemProfit(row), 'customerRefundAmount'), false);
  assert.equal(Object.hasOwn(itemProfit(row), 'walmartRefundSource'), false);
  for (const field of ['sku', 'purchaseOrderId']) {
    const other = item();
    other.returnInfo.lines[0][field] = 'OTHER';
    assert.equal(sellerRefundLookup(cache)(other), null);
  }
});
test('未完整出报表、旧缓存、冲突、缺关联和新退款均不误用部分官方净额', async () => {
  const base = await fetchReconciliation(reports().client);
  const mutations = [
    (c) => {
      c.status = 'error';
    },
    (c) => {
      c.availableDates.push('12012026');
    },
    (c) => {
      delete c.reports['11172026'].sellerRefundVersion;
    },
    (c) => {
      c.reports['11172026'].sellerRefundRows.pop();
      c.reports['11172026'].sellerRefundRows[0].po = '';
    },
    (c) => {
      const rows = c.reports['11172026'].sellerRefundRows;
      rows.push({ ...rows[0], amount: '-999' });
    },
  ];
  for (const mutate of mutations) {
    const cache = structuredClone(base);
    mutate(cache);
    assert.equal(sellerRefundLookup(cache)(item()), null);
  }
  const newer = item();
  newer.returnInfo.lines[0].completedAt = '2026-11-16T20:00:00Z';
  assert.equal(sellerRefundLookup(base)(newer), null);
  const partial = item();
  partial.returnInfo.lines.push({ ...partial.returnInfo.lines[0], returnOrderId: 'R2' });
  assert.equal(sellerRefundLookup(base)(partial), null);
});
test('仅保留一个只读计算字段；旧报表升级仅重新下载一次', async () => {
  assert.equal(fieldMap.walmartRefundAmount.readOnly, true);
  assert.equal(fieldMap.walmartRefundAmount.computed, true);
  assert.equal(fieldMap.sellerRefundManualAmount, undefined);
  const fixture = reports();
  const old = await fetchReconciliation(fixture.client);
  delete old.reports['11172026'].sellerRefundVersion;
  let count = 0;
  const counted = {
    request: async (path) => {
      count++;
      return fixture.client.request(path);
    },
  };
  const upgraded = await fetchReconciliation(counted, old);
  assert.equal(count, 2);
  count = 0;
  await fetchReconciliation(counted, upgraded);
  assert.equal(count, 1);
});

test('每日指标重试不复用缺少净扣款明细的旧报表，不重复请求其他成功指标', async () => {
  const fixture = reports();
  const reconciliation = await fetchReconciliation(fixture.client);
  delete reconciliation.reports['11172026'].sellerRefundVersion;
  const previous = {
    ...Object.fromEntries(Object.keys(REMOTE_METRICS).map((key) => [key, { status: 'ok' }])),
    monthlyReturns: { version: RETURNS_VERSION, periodStart: '2026-11-01', status: 'ok' },
    reconciliation,
  };
  const calls = [];
  const client = {
    request: async (url) => {
      calls.push(url);
      return fixture.client.request(url);
    },
  };
  const result = await fetchRemoteMetrics({}, previous, {
    client,
    retryOnly: true,
    now: new Date('2026-11-17T12:00:00Z'),
  });
  assert.equal(calls.length, 2);
  assert.equal(result.reconciliation.reports['11172026'].sellerRefundVersion, 1);
  assert.equal(sellerRefundLookup(result.reconciliation)(item()).amount, '88.58');
});
