import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReturns,
  fetchMonthlyReturns,
  monthlyReturnsMetric,
} from '../src/services/home/returns.js';
const now = new Date('2026-11-03T12:00:00-08:00');
const usd = (amount) => ({ currencyAmount: amount, currencyUnit: 'USD' });
const line = (id = 1, amount = '69.86', time = '2026-11-02T15:42:27Z') => ({
  returnOrderLineNumber: id,
  quantity: { measurementValue: 1 },
  refundedQty: 1,
  currentRefundStatus: 'REFUND_COMPLETED',
  currentTrackingStatuses: [
    {
      currentRefundStatus: 'REFUND_COMPLETED',
      statusTime: time,
      quantity: { measurementValue: 1 },
    },
  ],
  chargeTotals: [{ name: 'lineTotal', value: usd(amount) }],
});
const record = (id = 'r1', lines = [line()], amount = '69.86') => ({
  returnOrderId: id,
  customerOrderId: 'old-order',
  returnOrderDate: '2026-10-01T00:00:00Z',
  totalRefundAmount: usd(amount),
  returnOrderLines: lines,
});
const response = (rows, total = rows.length, cursor) => ({
  meta: { totalCount: total, nextCursor: cursor },
  returnOrders: rows,
});

test('含税退款以完成时间归月，旧订单可计入；申请中不计入，PST月边界准确', () => {
  const pending = {
    ...line(2),
    refundedQty: 0,
    currentRefundStatus: 'REFUND_INITIATED',
    currentTrackingStatuses: [],
  };
  const result = calculateReturns(
    [
      record(),
      record('r2', [line(1, '10', '2026-11-01T07:59:59Z')], '10'),
      record('r3', [pending]),
    ],
    now,
  );
  assert.equal(result.value, '69.86');
  assert.equal(result.completedLines, 1);
  assert.equal(
    calculateReturns([record('r4', [line(1, '0.10', '2026-11-01T08:00:00Z')], '0.10')], now).value,
    '0.10',
  );
  assert.equal(calculateReturns([], now).value, '0.00');
});

test('实际接口NOT_REFUNDED、取消和发起状态不计入，即使退货已COMPLETED且refundedQty大于0', () => {
  const rows = ['NOT_REFUNDED', 'NOT_REFUNDED', 'CANCELLED', 'REFUND_INITIATED'].map((state, i) => {
    const l = line();
    l.status = 'COMPLETED';
    l.currentRefundStatus = state;
    l.refundedQty = i < 2 ? 0 : 1;
    l.currentTrackingStatuses[0].currentRefundStatus = state;
    return record(`ignored-${i}`, [l]);
  });
  const result = calculateReturns([...rows, record()], now);
  assert.equal(result.value, '69.86');
  assert.equal(result.unverifiedLines, 0);
  assert.equal(result.completedLines, 1);
  const cancelledWithCompletion = line();
  cancelledWithCompletion.currentRefundStatus = 'CANCELLED';
  assert.equal(
    calculateReturns([record('ambiguous', [cancelledWithCompletion])], now).value,
    '0.00',
  );
});
test('多明细和同订单多个退货单独立累加，重复完成事件不重复计数', () => {
  const first = line(1, '0.10');
  first.currentTrackingStatuses.push(structuredClone(first.currentTrackingStatuses[0]));
  const result = calculateReturns(
    [record('a', [first, line(2, '0.20')], '0.30'), record('b', [line(1, '0.40')], '0.40')],
    now,
  );
  assert.equal(result.value, '0.70');
  assert.equal(result.completedLines, 3);
});
test('全部数量一次退款时直接使用整行金额，不重复乘数量', () => {
  const l = line(1, '60');
  l.quantity.measurementValue =
    l.refundedQty =
    l.currentTrackingStatuses[0].quantity.measurementValue =
      3;
  assert.equal(calculateReturns([record('a', [l], '60')], now).value, '60.00');
});

test('跨月多明细只计本月完成部分，未知状态和未来完成时间不伪装为零', () => {
  assert.equal(
    calculateReturns(
      [record('r', [line(1, '10', '2026-10-31T09:00:00Z'), line(2, '20')], '30')],
      now,
    ).value,
    '20.00',
  );
  const future = record('r', [line(1, '10', '2026-12-01T09:00:00Z')], '10');
  assert.equal(calculateReturns([future], now).status, 'partial');
  const unknown = {
    ...line(),
    currentRefundStatus: 'UNKNOWN',
    currentTrackingStatuses: [],
    refundedQty: 0,
  };
  assert.equal(calculateReturns([record('r', [unknown])], now).status, 'partial');
});

test('同一退货单在跨窗口采集中改变时拒绝混合金额，不能静默覆盖', async () => {
  let calls = 0;
  const result = await fetchMonthlyReturns(
    {
      request: async () => response([record('same', [line(1, ++calls === 1 ? '10' : '20')], '10')]),
    },
    undefined,
    new Date('2026-11-10T12:00:00-08:00'),
  );
  assert.equal(result.status, 'error');
  assert.match(result.error, /发生变化/);
  assert.equal(result.value, undefined);
});
test('直接累计接口行金额，不核对数量和整单金额；同月多次完成不重复计额', () => {
  const l = line(1, '12.34');
  l.quantity.measurementValue = 3;
  l.refundedQty = 2;
  l.currentTrackingStatuses.push({
    ...l.currentTrackingStatuses[0],
    statusTime: '2026-11-03T09:00:00Z',
  });
  const result = calculateReturns([record('a', [l], '999.99')], now);
  assert.equal(result.value, '12.34');
  assert.equal(result.status, 'ok');
  assert.equal(result.completedLines, 1);
});
test('缺失时间或金额等异常只跳过该明细，同单其他有效金额仍显示', () => {
  const variants = [
    (l) => {
      l.currentTrackingStatuses = [];
    },
    (l) => {
      l.chargeTotals = [];
    },
    (l) => {
      l.chargeTotals[0].value.currencyUnit = 'CAD';
    },
    (l) => {
      l.currentRefundStatus = 'UNKNOWN';
    },
    (l) => {
      l.currentTrackingStatuses[0].statusTime = '2026-11-02';
    },
    (l) => {
      l.currentTrackingStatuses.push({
        ...l.currentTrackingStatuses[0],
        statusTime: '2026-10-20T09:00:00Z',
      });
    },
  ];
  for (const mutate of variants) {
    const bad = line(2);
    mutate(bad);
    const result = calculateReturns([record('a', [line(1, '15'), bad], '999')], now);
    assert.equal(result.value, '15.00');
    assert.equal(result.status, 'partial');
    assert.equal(result.completedLines, 1);
    assert.equal(result.unverifiedLines, 1);
    assert.match(result.statusText, /已跳过 1 条/);
    assert.equal(calculateReturns([record('only-invalid', [bad])], now).value, undefined);
  }
});
test('分页跨页去重，查询带完整修改时间范围，返回数据不含原始记录', async () => {
  const paths = [];
  const result = await fetchMonthlyReturns(
    {
      request: async (path) => {
        paths.push(path);
        return paths.length === 1
          ? response([record()], 2, '?offset=1')
          : response([record(), record('r2')], 2);
      },
    },
    undefined,
    now,
  );
  assert.equal(result.value, '139.72');
  assert.equal(result.recordCount, 2);
  for (const path of paths) {
    const u = new URL(path, 'https://example.com');
    assert.equal(u.searchParams.get('returnLastModifiedStartDate'), '2026-11-01T08:00:00.000Z');
    assert.equal(u.searchParams.get('returnLastModifiedEndDate'), now.toISOString());
  }
  assert.doesNotMatch(JSON.stringify(result), /old-order|returnOrderId/);
});
test('分7天窗口重叠记录去重，不依赖订单下单月份', async () => {
  let calls = 0;
  const result = await fetchMonthlyReturns(
    {
      request: async () => {
        calls++;
        return response([record()]);
      },
    },
    undefined,
    new Date('2026-11-16T12:00:00-08:00'),
  );
  assert.equal(calls, 3);
  assert.equal(result.value, '69.86');
});
test('分页缺失/变化/循环/外部游标不能显示零；请求失败只保留同月历史金额', async () => {
  const cases = [
    response([], 1),
    response([], 0, 'https://evil.example/v3/returns'),
    {},
    response([record()], 2, '?offset=1'),
  ];
  for (const body of cases) {
    const result = await fetchMonthlyReturns({ request: async () => body }, undefined, now);
    assert.equal(result.status, 'error');
    assert.equal(result.value, undefined);
  }
  const fail = {
    request: async () => {
      throw Object.assign(new Error('forbidden'), { apiStatus: 403 });
    },
  };
  const old = {
    version: 2,
    periodStart: '2026-11-01',
    value: '12.34',
    fetchedAt: 'old',
    asOf: 'old',
  };
  const same = await fetchMonthlyReturns(fail, old, now);
  assert.equal(same.value, '12.34');
  assert.match(same.error, /未授权/);
  assert.equal(
    (await fetchMonthlyReturns(fail, { ...old, periodStart: '2026-10-01' }, now)).value,
    undefined,
  );
  assert.equal(monthlyReturnsMetric(old, new Date('2026-12-01T12:00:00-08:00')).value, undefined);
});
