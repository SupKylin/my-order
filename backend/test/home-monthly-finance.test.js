import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchReconciliation,
  storeFinance,
  transactionDay,
} from '../src/services/home/reconciliation.js';
const now = Date.parse('2026-11-03T12:00:00-08:00');
const summary = (start = '10/20/2026', end = '11/02/2026', amount = '123.45') => ({
  'Transaction Type': 'PaymentSummary',
  'Period Start Date': start,
  'Period End Date': end,
  'Total Payable': amount,
  'Transaction Description': 'Deposited in account',
  Currency: 'USD',
  'Transaction Posted Timestamp': '11/03/2026',
});
const refund = (date, amount = '-10', order = 'OLD-ORDER') => ({
  'Transaction Type': 'Refund',
  'Amount Type': 'Product Price',
  Amount: amount,
  'Customer Order #': order,
  'Transaction Posted Timestamp': date,
});
async function load(rows) {
  return fetchReconciliation({
    request: async (path) =>
      path.includes('availableReconFiles')
        ? { availableApReportDates: ['11032026'] }
        : { reportData: rows, totalRecords: rows.length, nextOffset: -1 },
  });
}

test('退款按交易月而非下单月统计，含跨月税费和冲正，账期实际支付及日期独立', async () => {
  const cache = await load([
    summary(),
    summary(),
    refund('10/31/2026', '-100'),
    refund('11/01/2026'),
    refund('11/02/2026', '2'),
    { ...refund('11/02/2026', '-0.80'), 'Amount Type': 'Product Tax' },
    refund('12/01/2026', '-50'),
  ]);
  const data = storeFinance(cache, now);
  assert.equal(data.monthlyRefund.value, '8.80');
  assert.equal(data.monthlyRefund.status, 'partial');
  assert.equal(data.monthlyRefund.coverageThrough, '2026-11-02');
  assert.equal(data.monthlyRefund.periodStart, '2026-11-01');
  assert.equal(data.previousPayment.value, '123.45');
  assert.equal(data.previousPayment.periodStart, '2026-10-20');
  assert.equal(data.previousPayment.periodEnd, '2026-11-02');
  assert.equal(data.previousPayment.reportUpdatedAt, '2026-11-03');
  assert.equal(
    storeFinance(cache, Date.parse('2026-12-01T12:00:00-08:00')).monthlyRefund.value,
    undefined,
  );
});
test('上月报表不作为当月退款；上期回款直接使用Total Payable，不校验支付描述', async () => {
  const cache = await load([
    { ...summary('10/01/2026', '10/17/2026'), 'Transaction Description': 'Reserve' },
    refund('10/10/2026'),
  ]);
  assert.equal(storeFinance(cache, now).monthlyRefund.value, undefined);
  assert.equal(storeFinance(cache, now).previousPayment.value, '123.45');
});
test('缺退款日期不回退为原订单日期；旧缓存必须重新下载后才按月汇总', async () => {
  const cache = await load([summary(), refund('')]);
  assert.equal(storeFinance(cache, now).monthlyRefund.value, undefined);
  let calls = 0;
  await fetchReconciliation(
    {
      request: async (path) => {
        calls++;
        return path.includes('availableReconFiles')
          ? { availableApReportDates: ['11032026'] }
          : { reportData: [summary()], totalRecords: 1, nextOffset: -1 };
      },
    },
    {
      version: 2,
      status: 'ok',
      reports: { 11032026: { start: '2026-10-20', end: '2026-11-02', refunds: [] } },
    },
  );
  assert.equal(calls, 2);
});
test('最新已结束账期缺付款不拿更早账期替代；新报表下载失败不冒充上一期', async () => {
  const cache = await load([summary()]);
  cache.reports['10202026'] = {
    ...cache.reports['11032026'],
    start: '2026-10-01',
    end: '2026-10-17',
    paidAmount: '999',
  };
  cache.reports['11032026'].paidAmount = null;
  assert.equal(storeFinance(cache, now).previousPayment.value, undefined);
  cache.reports['11032026'].paidAmount = '123';
  cache.availableDates.push('11042026');
  cache.status = 'error';
  assert.equal(storeFinance(cache, now).previousPayment.value, undefined);
});
test('PST月份边界严格转换，日期无时区按官方日期，非法日期拒绝', () => {
  assert.equal(transactionDay('2026-11-01T07:59:59Z'), '2026-10-31');
  assert.equal(transactionDay('2026-11-01T08:00:00Z'), '2026-11-01');
  assert.equal(transactionDay('11/01/2026'), '2026-11-01');
  assert.throws(() => transactionDay('2026-02-30'));
  assert.throws(() => transactionDay('2026-11-01T12:00:00'));
});
test('当月完整报表无退款可为零，含负向冲正保留精确净额', async () => {
  const cache = await load([summary('11/01/2026', '11/03/2026')]);
  assert.equal(storeFinance(cache, now).monthlyRefund.value, '0.00');
  assert.equal(storeFinance(cache, now).monthlyRefund.status, 'ok');
  const adjusted = await load([summary(), refund('11/02/2026', '2.015')]);
  assert.equal(storeFinance(adjusted, now).monthlyRefund.value, '-2.02');
});

test('付款描述缺失或未确认不阻塞官方金额展示', async () => {
  const cache = await load([
    { ...summary('10/01/2026', '10/17/2026'), 'Transaction Description': 'Reserve' },
  ]);
  const data = storeFinance(cache, now);
  assert.equal(data.monthlyRefund.status, 'pending');
  assert.equal(data.monthlyRefund.statusText, '待出当月报表');
  assert.equal(data.previousPayment.status, 'ok');
  assert.equal(data.previousPayment.value, '123.45');
  const missing = await load([{ ...summary(), 'Transaction Description': undefined }]);
  assert.equal(storeFinance(missing, now).previousPayment.value, '123.45');
  assert.equal(storeFinance(undefined, now).monthlyRefund.statusText, '等待同步');
});

test('付款校验记录缺失金额和币种原因，旧缓存不猜测缺失原因，有效零付款保留', async () => {
  const invalid = await load([{ ...summary(), 'Total Payable': '', Currency: 'CAD' }]);
  assert.deepEqual(invalid.reports['11032026'].paymentIssues, [
    'payment_amount',
    'payment_currency',
  ]);
  assert.match(storeFinance(invalid, now).previousPayment.error, /缺失.*币种/);
  delete invalid.reports['11032026'].paymentIssues;
  assert.match(storeFinance(invalid, now).previousPayment.error, /缺少有效的 Total Payable/);
  const zero = storeFinance(await load([summary(undefined, undefined, '0')]), now).previousPayment;
  assert.equal(zero.value, '0.00');
  assert.equal(zero.status, 'ok');
  assert.equal(zero.statusText, undefined);
});

test('实际请求失败保留错误原因，有历史金额时保留金额且标记更新失败', async () => {
  const failed = {
    version: 2,
    status: 'error',
    error: '财务对账接口未授权，请检查店铺 API 权限',
    reports: {},
  };
  for (const metric of Object.values(storeFinance(failed, now))) {
    assert.equal(metric.status, 'error');
    assert.equal(metric.statusText, '接口请求失败');
    assert.equal(metric.error, failed.error);
    assert.equal(metric.value, undefined);
  }
  const cache = await load([summary(), refund('11/01/2026')]);
  cache.status = 'error';
  cache.error = 'Walmart 网络超时或连接失败';
  const data = storeFinance(cache, now);
  assert.equal(data.previousPayment.value, '123.45');
  assert.equal(data.previousPayment.statusText, '历史金额 · 更新失败');
  assert.equal(data.monthlyRefund.value, '10.00');
  assert.equal(data.monthlyRefund.statusText, '部分金额 · 更新失败');
  for (const metric of Object.values(data)) assert.match(metric.error, /网络超时/);
});

test('缺交易日期属于数据待核实，不显示接口请求失败', async () => {
  const data = storeFinance(await load([summary(), refund('')]), now);
  assert.equal(data.monthlyRefund.status, 'unverified');
  assert.equal(data.monthlyRefund.statusText, '退款数据待核实');
  assert.equal(data.monthlyRefund.value, undefined);
});

test('旧版支付描述校验缓存重新获取，新版缓存复用', async () => {
  const old = await load([summary()]);
  old.version = 1;
  old.reports['11032026'].paidAmount = null;
  let requests = 0;
  const client = {
    request: async (path) => {
      requests++;
      return path.includes('availableReconFiles')
        ? { availableApReportDates: ['11032026'] }
        : {
            reportData: [{ ...summary(), 'Transaction Description': 'Reserve' }],
            totalRecords: 1,
            nextOffset: -1,
          };
    },
  };
  const fresh = await fetchReconciliation(client, old);
  assert.equal(requests, 2);
  assert.equal(storeFinance(fresh, now).previousPayment.value, '123.45');
  requests = 0;
  await fetchReconciliation(client, fresh);
  assert.equal(requests, 1);
});
