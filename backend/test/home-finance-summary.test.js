import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementSummary } from '../../frontend/src/utils/settlement-summary.js';

test('平台已支付与待结算独立汇总，跨页全部店铺精确加总，零、负数及历史金额明确区分', () => {
  const stores = [
    {
      snapshotDate: '2026-10-28',
      remote: {
        settlement: { value: '100', status: 'ok' },
        paidToYou: { value: '0', status: 'ok' },
      },
    },
    { snapshotDate: '2026-10-28', remote: { paidToYou: { value: '10.10', status: 'ok' } } },
    { snapshotDate: '2026-10-27', remote: { paidToYou: { value: '-0.20', status: 'error' } } },
    { snapshotDate: '2026-10-28', remote: { paidToYou: { status: 'error' } } },
  ];
  assert.deepEqual(settlementSummary(stores, '2026-10-28', 'paidToYou'), {
    value: '9.90',
    available: 3,
    missing: 1,
    historical: 1,
  });
  assert.equal(settlementSummary(stores, '2026-10-28').value, '100.00');
  assert.equal(settlementSummary(stores.slice(0, 1), '2026-10-28', 'paidToYou').value, '0.00');
  assert.equal(settlementSummary(stores.slice(3), '2026-10-28', 'paidToYou').value, '—');
});
