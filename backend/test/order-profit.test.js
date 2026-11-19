import test from 'node:test';
import assert from 'node:assert/strict';
import {
  itemProfit,
  normalizeCommissionRate,
  moneyText,
  moneyUnits,
} from '../src/lib/order-profit.js';
import { createProfitStatistics, profitReport } from '../src/services/home/profit.js';
import { normalizeValue } from '../src/validation.js';
import { fieldMap } from '../src/fields.js';
const row = (time = '2026-11-02T00:00:00-08:00', extra = {}) => ({
  orderAmount: '100',
  walmart: { orderDate: Date.parse(time), statuses: ['Acknowledged'] },
  purchase: { settlement: '已结算', commissionRate: '15', purchaseCost: '70' },
  ...extra,
});
const refundLine = (amount, extra = {}) => ({
  status: '已退款',
  refundStatus: 'REFUND_COMPLETED',
  amount,
  currency: 'USD',
  returnOrderId: 'R1',
  lineNumber: '1',
  ...extra,
});

test('只读官方卖家净额参与利润，采购退款和争议独立加回', () => {
  const item = row(undefined, {
    returnInfo: {
      lines: [
        refundLine('10.01'),
        refundLine('10.01'),
        refundLine('3.02', { returnOrderId: 'R2', quantity: 3 }),
        refundLine('999', { status: '退款处理中' }),
      ],
    },
    sellerRefund: { amount: '13.03', through: '2026-11-03' },
    purchaseAfterSale: { status: 'open', purchaseRefundAmount: '5.12' },
    purchase: {
      settlement: '已结算',
      commissionRate: '15',
      purchaseCost: '70',
      disputeSuccessAmount: '2.03',
    },
  });
  const result = itemProfit(item);
  assert.equal(result.walmartRefundAmount, '13.03');
  assert.equal(result.purchaseRefundAmount, '5.12');
  assert.equal(result.orderProfit, '9.12');
  assert.equal(
    itemProfit({ ...item, purchaseAfterSale: { ...item.purchaseAfterSale, status: 'completed' } })
      .orderProfit,
    '9.12',
  );
});

test('未退款、无工单及未填争议金额显示空并按零计；官方有效零正常显示', () => {
  const result = itemProfit(
    row(undefined, { returnInfo: { lines: [refundLine('20', { status: '申请中' })] } }),
  );
  assert.equal(result.walmartRefundAmount, null);
  assert.equal(result.purchaseRefundAmount, null);
  assert.equal(result.disputeSuccessAmount, null);
  assert.equal(result.orderProfit, '15.00');
  const zeros = itemProfit(
    row(undefined, {
      returnInfo: { lines: [refundLine('0')] },
      sellerRefund: { amount: '0', through: '2026-11-03' },
      purchaseAfterSale: { purchaseRefundAmount: '0' },
    }),
  );
  assert.equal(zeros.walmartRefundAmount, '0.00');
  assert.equal(zeros.purchaseRefundAmount, '0.00');
  assert.equal(zeros.orderProfit, '15.00');
});

test('已退款金额缺失或无效、重复记录冲突和工单金额未填写不得伪装为零', () => {
  const incomplete = [
    { returnInfo: { statuses: ['已退款'], lines: [] } },
    ...[null, '', '-1', 'bad'].map((amount) => ({ returnInfo: { lines: [refundLine(amount)] } })),
    { returnInfo: { lines: [refundLine('1', { currency: 'CAD' })] } },
    { returnInfo: { lines: [refundLine('1'), refundLine('2')] } },
    { purchaseAfterSale: { status: 'open', purchaseRefundAmount: null } },
    { purchaseAfterSale: { status: 'completed', purchaseRefundAmount: null } },
  ];
  for (const extra of incomplete) {
    const result = itemProfit(row(undefined, extra));
    assert.equal(result.orderProfit, null, JSON.stringify(extra));
    assert.ok(result.profitMessage);
  }
});

test('争议金额限定非负两位，空与零区分，保留精确分值', () => {
  const field = fieldMap.disputeSuccessAmount;
  assert.equal(normalizeValue(field, ''), null);
  assert.equal(normalizeValue(field, '0'), '0.00');
  assert.equal(normalizeValue(field, '999999999999.99'), '999999999999.99');
  for (const value of ['-1', '1.001', 'abc', {}, ['1'], '1000000000000'])
    assert.throws(() => normalizeValue(field, value));
});

test('周月退款与争议按原订单日期归组，缺退款明细不进入任何金额合计', () => {
  const stats = createProfitStatistics(Date.parse('2026-11-09T12:00:00-08:00'), {
    start: Date.parse('2026-10-31T00:00:00-08:00'),
    end: Date.parse('2026-11-09T00:00:00-08:00'),
  });
  stats.add(
    row('2026-10-31T12:00:00-08:00', {
      returnInfo: { lines: [refundLine('10', { completedAt: '2026-11-09T08:00:00Z' })] },
      sellerRefund: { amount: '10', through: '2026-11-10' },
      purchaseAfterSale: { purchaseRefundAmount: '2' },
      purchase: {
        settlement: '已结算',
        commissionRate: '15',
        purchaseCost: '70',
        disputeSuccessAmount: '3',
      },
    }),
  );
  stats.add(
    row('2026-11-02T12:00:00-08:00', { purchaseAfterSale: { purchaseRefundAmount: null } }),
  );
  const result = stats.result();
  const october = result.month.find((r) => r.periodStart === '2026-10-01');
  assert.equal(october.walmartRefundAmount, '10.00');
  assert.equal(october.purchaseRefundAmount, '2.00');
  assert.equal(october.disputeSuccessAmount, '3.00');
  assert.equal(october.orderProfit, '10.00');
  assert.equal(result.month[0].uncomputedItems, 1);
  assert.equal(result.month[0].orderProfit, null);
  const report = profitReport([
    { id: 1, name: '自有', metrics: { profit: result } },
    { id: 2, name: '三方', isThirdParty: true, metrics: { profit: result } },
  ]);
  for (const type of ['week', 'month'])
    for (const total of report[type].totals) {
      assert.equal(total.walmartRefundAmount, '10.00');
      assert.equal(total.purchaseRefundAmount, '2.00');
      assert.equal(total.disputeSuccessAmount, '3.00');
      assert.equal(total.orderProfit, '10.00');
      assert.equal(total.uncomputedItems, 1);
    }
});
test('佣金按百分比、零费率有效，利润支持亏损和十进制舍入', () => {
  assert.equal(normalizeCommissionRate('15.25'), '15.25');
  assert.equal(normalizeCommissionRate(''), null);
  assert.equal(itemProfit(row()).orderProfit, '15.00');
  assert.equal(
    itemProfit(
      row(undefined, {
        purchase: { settlement: '已结算', commissionRate: '0', purchaseCost: '0' },
      }),
    ).orderProfit,
    '100.00',
  );
  assert.equal(
    itemProfit(
      row(undefined, {
        purchase: { settlement: '已结算', commissionRate: '15', purchaseCost: '90' },
      }),
    ).orderProfit,
    '-5.00',
  );
  assert.equal(
    itemProfit(
      row(undefined, {
        orderAmount: '0.05',
        purchase: { settlement: '已结算', commissionRate: '10', purchaseCost: '0' },
      }),
    ).commissionAmount,
    '0.01',
  );
  assert.equal(moneyText(moneyUnits('-0.005')), '-0.01');
});
test('缺费率、未结算、无成本和取消不得伪装利润；零利润正常显示', () => {
  for (const purchase of [
    { settlement: '已结算', purchaseCost: '20' },
    { commissionRate: '15', purchaseCost: '20' },
    { settlement: '已结算', commissionRate: '15' },
  ])
    assert.equal(itemProfit(row(undefined, { purchase })).orderProfit, null);
  assert.equal(
    itemProfit(row(undefined, { walmart: { statuses: ['Cancelled'] } })).orderProfit,
    null,
  );
  assert.equal(
    itemProfit(
      row(undefined, {
        purchase: { settlement: '已结算', commissionRate: '15', purchaseCost: '85' },
      }),
    ).orderProfit,
    '0.00',
  );
});
test('PST跨周跨月按下单时间，取消排除、缺失计数，所有金额只统计计算成功的明细', () => {
  const now = Date.parse('2026-11-07T12:00:00-08:00');
  const range = {
    start: Date.parse('2026-10-31T00:00:00-08:00'),
    end: Date.parse('2026-11-04T00:00:00-08:00'),
  };
  const stats = createProfitStatistics(now, range);
  stats.add(row('2026-11-01T07:59:59Z'));
  stats.add(
    row('2026-11-02T08:00:00Z', {
      purchase: { settlement: '已结算', commissionRate: '20', purchaseCost: '90' },
    }),
  );
  stats.add(row('2026-11-02T09:00:00Z', { purchase: {} }));
  stats.add(
    row('2026-11-02T10:00:00Z', {
      walmart: { orderDate: Date.parse('2026-11-02T10:00:00Z'), statuses: ['Cancelled'] },
    }),
  );
  stats.add(row('2026-11-04T08:00:00Z'));
  const result = stats.result();
  assert.deepEqual(
    result.week.map((r) => [r.periodStart, r.orderProfit, r.uncomputedItems, r.cancelledItems]),
    [
      ['2026-11-02', '-10.00', 1, 1],
      ['2026-10-26', '15.00', 0, 0],
    ],
  );
  assert.deepEqual(
    result.month.map((r) => [r.periodStart, r.orderProfit]),
    [
      ['2026-11-01', '-10.00'],
      ['2026-10-01', '15.00'],
    ],
  );
  const report = profitReport([
    { id: 1, name: '自有', metrics: { profit: result } },
    { id: 2, name: '三方', isThirdParty: true, metrics: { profit: result } },
  ]);
  assert.equal(report.week.totals[0].orderProfit, '5.00');
  assert.equal(report.week.totals[1].orderProfit, '5.00');
  assert.equal(report.month.totals[0].orderProfit, '5.00');
});
