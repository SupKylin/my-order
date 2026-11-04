import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchReconciliation, reconciliationTotals } from '../src/services/home/reconciliation.js';

const directory = '/v3/report/reconreport/availableReconFiles?reportVersion=v1';
const period = { 'Period Start Date': '09/19/2026', 'Period End Date': '10/03/2026' };
const summary = { ...period, 'Transaction Type': 'PaymentSummary' };
function refund(type, amount, order = 'CUSTOMER-A', extra = {}) {
  return {
    'Transaction Type': 'Refund',
    'Amount Type': type,
    Amount: amount,
    'Customer Order #': order,
    Currency: '',
    ...extra,
  };
}
function page(reportData, nextOffset = -1) {
  return { reportData, totalRecords: reportData.length, nextOffset };
}
function clientFor(rows, dates = ['10062026']) {
  return {
    request: async (path) => (path === directory ? { availableApReportDates: dates } : page(rows)),
  };
}

test('目录按日期排序，分页使用官方字节偏移；实际退款含税并抵减冲正，排除佣金和代扣税', async () => {
  const calls = [];
  const client = {
    request: async (path) => {
      calls.push(path);
      if (path === directory)
        return { availableApReportDates: ['10202026', '09222026', '10062026', '10062026'] };
      const url = new URL(path, 'https://example.invalid');
      const date = url.searchParams.get('reportDate');
      const offset = Number(url.searchParams.get('offset'));
      if (date === '10062026' && offset === 0)
        return page(
          [
            summary,
            refund('Product price', '-26.65'),
            refund('Shipping', '-19.99'),
            refund('Product tax', '-1.60'),
            refund('Shipping tax', '-0.40'),
            refund('Product tax withheld', '1.60'),
            refund('Shipping tax withheld', '0.40'),
            refund('Commission on product', '4.00'),
            refund('Commission on shipping', '3.00'),
            refund('Fee/Reimbursement', '0.50'),
            refund('Item fees', '-1.00'),
            { 'Transaction Type': 'Sale', 'Amount Type': 'Product price', Amount: '100' },
          ],
          123456,
        );
      if (date === '10062026' && offset === 123456)
        return page([
          refund('Product price', '1.00', 'CUSTOMER-A', { 'Customer Name': 'Not cached' }),
          refund('Product price', '-0.104', 'ROUND'),
          refund('Product tax', '-0.104', 'ROUND'),
        ]);
      assert.equal(date, '10202026');
      assert.equal(offset, 0);
      return page([
        { ...summary, 'Period Start Date': '10/03/2026', 'Period End Date': '10/17/2026' },
        refund('Product price', '2.00'),
        refund('Product price', '0.50', 'REVERSAL-ONLY'),
      ]);
    },
  };
  const cache = await fetchReconciliation(client);
  assert.equal(cache.status, 'ok');
  assert.equal(calls.length, 4);
  assert.match(calls[1], /reportDate=10062026&offset=0/);
  assert.match(calls[2], /offset=123456/);
  assert.doesNotMatch(
    JSON.stringify(cache),
    /Customer Name|Not cached|PaymentSummary|Product price/,
  );
  const totals = reconciliationTotals(cache);
  assert.equal(totals.amount('CUSTOMER-A'), '45.64');
  assert.equal(totals.amount('ROUND'), '0.21');
  assert.equal(totals.amount('REVERSAL-ONLY'), '0.00');
  assert.equal(totals.amount('NO-REFUND'), '0.00');
  assert.equal(totals.state('2026-10-17').refundStatus, 'ok');
  assert.equal(totals.state('2026-10-18').refundStatus, 'partial');
  assert.equal(totals.state('2026-10-18').refundAsOf, '2026-10-17');
});

test('完整历史报表复用缓存；失败账期保留成功账期，下次只补失败账期', async () => {
  const calls = [];
  let failing = true;
  const client = {
    request: async (path) => {
      calls.push(path);
      if (path === directory) return { availableApReportDates: ['10062026', '10202026'] };
      if (path.includes('10202026')) {
        if (failing) throw new Error('暂时失败');
        return page([
          { ...summary, 'Period Start Date': '10/03/2026', 'Period End Date': '10/17/2026' },
        ]);
      }
      return page([summary, refund('Product price', '-2')]);
    },
  };
  const first = await fetchReconciliation(client);
  assert.equal(first.status, 'error');
  assert.equal(Object.keys(first.reports).length, 1);
  assert.equal(reconciliationTotals(first).state('2026-10-02').refundStatus, 'partial');
  failing = false;
  calls.length = 0;
  const second = await fetchReconciliation(client, first);
  assert.equal(second.status, 'ok');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /10202026/);
  calls.length = 0;
  const third = await fetchReconciliation(client, second);
  assert.equal(third.status, 'ok');
  assert.deepEqual(calls, [directory]);
});

test('平台资助及超额退款调整不计入客户实际退款，正负结算调整均排除', async () => {
  const rows = [summary, refund('Product price', '-20'), refund('Product tax', '-1.60')];
  for (const type of [
    'Total Walmart Funded Savings',
    'ExcessRefundAdjustment',
    'Excess Refund Adjustment',
  ])
    for (const amount of ['5.50', '-2.00']) rows.push(refund(type, amount));
  const cache = await fetchReconciliation(clientFor(rows));
  assert.equal(cache.status, 'ok');
  assert.equal(reconciliationTotals(cache).amount('CUSTOMER-A'), '21.60');
});

test('账期只取 PaymentSummary，跨页服务费的分段或越界日期不影响覆盖范围', async () => {
  const cache = await fetchReconciliation({
    request: async (path) => {
      if (path === directory) return { availableApReportDates: ['10062026'] };
      if (path.includes('offset=0&'))
        return page(
          [
            {
              ...summary,
              'Transaction Type': 'Service Fee',
              'Period Start Date': '09/01/2026',
              'Period End Date': '09/02/2026',
            },
            summary,
            refund('Product price', '-8'),
          ],
          12345,
        );
      return page([
        summary,
        {
          ...summary,
          'Transaction Type': 'Service Fee',
          'Period Start Date': '10/01/2026',
          'Period End Date': '10/02/2026',
        },
        {
          ...summary,
          'Transaction Type': 'Service Fee',
          'Period Start Date': '10/04/2026',
          'Period End Date': '10/05/2026',
        },
      ]);
    },
  });
  assert.equal(cache.status, 'ok');
  assert.equal(cache.reports['10062026'].start, '2026-09-19');
  assert.equal(cache.reports['10062026'].end, '2026-10-03');
  assert.equal(reconciliationTotals(cache).state('2026-10-04').refundStatus, 'partial');
});

test('空目录无可用金额；账期缺口回退已出报表并标记非完整', async () => {
  const empty = await fetchReconciliation(clientFor([], []));
  assert.equal(empty.status, 'ok');
  assert.equal(reconciliationTotals(empty).state('2026-10-01').refundStatus, 'pending');
  const covered = await fetchReconciliation(clientFor([summary]));
  assert.equal(reconciliationTotals(covered).amount('NO-REFUND'), '0.00');
  assert.equal(reconciliationTotals(covered).state('2026-10-03').refundStatus, 'ok');
  covered.reports['10202026'] = { start: '2026-10-05', end: '2026-10-17', refunds: [] };
  assert.equal(reconciliationTotals(covered).state('2026-10-05').refundStatus, 'partial');
  const changed = await fetchReconciliation(clientFor([], []), covered);
  assert.deepEqual(changed.reports, {});
});

test('未知费用、币种、无订单号、缺账期、非法金额和分页异常均不生成误导的零', async (t) => {
  const cases = [
    ['未知费用', page([summary, refund('Unknown type', '-1')])],
    ['币种', page([summary, refund('Product price', '-1', 'A', { Currency: 'CAD' })])],
    ['订单号', page([summary, refund('Product price', '-1', '')])],
    ['账期', page([refund('Product price', '-1')])],
    ['仅服务费账期', page([{ ...summary, 'Transaction Type': 'Service Fee' }])],
    [
      '汇总缺账期',
      page([
        { 'Transaction Type': 'PaymentSummary' },
        { ...summary, 'Transaction Type': 'Service Fee' },
      ]),
    ],
    ['汇总账期冲突', page([summary, { ...summary, 'Period Start Date': '09/20/2026' }])],
    ['金额', page([summary, refund('Product price', 'invalid')])],
    ['条数', { ...page([summary]), totalRecords: 2 }],
    ['分页缺失', { ...page([summary]), nextOffset: null }],
    ['分页停滞', page([summary], 0)],
    ['未返回明细', { reportData: null }],
  ];
  for (const [name, response] of cases)
    await t.test(name, async () => {
      const cache = await fetchReconciliation({
        request: async (path) =>
          path === directory ? { availableApReportDates: ['10062026'] } : response,
      });
      assert.equal(cache.status, 'error');
      assert.deepEqual(cache.reports, {});
      assert.equal(reconciliationTotals(cache).state('2026-10-01').refundStatus, 'unavailable');
    });
});

test('权限失败保留历史缓存用于重试，但不得将其当作完整结果', async () => {
  const previous = await fetchReconciliation(clientFor([summary, refund('Product price', '-1')]));
  const cache = await fetchReconciliation(
    {
      request: async () => {
        const error = new Error('Forbidden');
        error.apiStatus = 403;
        throw error;
      },
    },
    previous,
  );
  assert.equal(cache.status, 'error');
  assert.match(cache.error, /未授权/);
  assert.deepEqual(cache.reports, previous.reports);
  assert.equal(reconciliationTotals(cache).state('2026-10-02').refundStatus, 'partial');
});
