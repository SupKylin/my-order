import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePurchaseFields } from '../src/lib/purchase-derived.js';

test('采购限价和价格系数按精度计算并四舍五入', () => {
  assert.deepEqual(
    derivePurchaseFields({ orderAmount: '100', tax: '0', purchaseLinkAmount: '60' }),
    { purchaseLimit: '66.00', priceFactor: '1.4167' },
  );
  assert.equal(
    derivePurchaseFields({ orderAmount: '1', tax: '0', purchaseLinkAmount: '10.005' })
      .purchaseLimit,
    '11.01',
  );
});

test('采购限价计算允许空税费，来源无效或分母非正时留空', () => {
  assert.deepEqual(
    derivePurchaseFields({ orderAmount: '100', tax: '', purchaseLinkAmount: '50' }),
    { purchaseLimit: '55.00', priceFactor: '1.7000' },
  );
  for (const values of [
    { orderAmount: '待定', tax: '0', purchaseLinkAmount: '50' },
    { orderAmount: '100', tax: '0', purchaseLinkAmount: '0' },
    { orderAmount: '100', tax: '-1', purchaseLinkAmount: '50' },
  ]) {
    assert.deepEqual(derivePurchaseFields(values), { purchaseLimit: null, priceFactor: null });
  }
});
