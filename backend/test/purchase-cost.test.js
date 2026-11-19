import test from 'node:test';
import assert from 'node:assert/strict';
import { channelDiscount, purchaseCost } from '../src/lib/channel-discount.js';
import {
  discountPreview,
  costPreview,
  currentFinanceConfig,
} from '../../frontend/src/utils/purchaseCost.js';

test('采购折扣按直接税金乘数计算，四舍五入4位；采购成本2位且前后端预览一致', () => {
  const input = { channelExchangeRate: '7.2', currentExchangeRate: '7.3', taxMultiplier: '1.08' };
  const result = channelDiscount(input);
  assert.equal(result.purchaseDiscount, '1.0652');
  assert.equal(discountPreview(input), result.purchaseDiscount);
  assert.equal(purchaseCost(result.purchaseDiscount, '100'), '106.52');
  assert.equal(costPreview(result.purchaseDiscount, '100'), '106.52');
  assert.equal(
    channelDiscount({
      ...input,
      channelExchangeRate: '1',
      currentExchangeRate: '1',
      taxMultiplier: '8',
    }).purchaseDiscount,
    '8.0000',
  );
  assert.equal(purchaseCost('1', '1.005'), '1.01');
  assert.equal(purchaseCost('0', '55.09'), '0.00');
});

test('配置最多两位小数、分母不可为0、不允许半配置，结果超范围和无效金额阻止结算', () => {
  const valid = { channelExchangeRate: '1', currentExchangeRate: '1', taxMultiplier: '1' };
  for (const input of [
    { ...valid, currentExchangeRate: '0' },
    { ...valid, taxMultiplier: '1.001' },
    { ...valid, channelExchangeRate: '-1' },
    { ...valid, taxMultiplier: '8%' },
    { ...valid, taxMultiplier: null },
    { ...valid, currentExchangeRate: 'NaN' },
    { ...valid, channelExchangeRate: '1000000000000' },
    {
      channelExchangeRate: '999999999999.99',
      currentExchangeRate: '0.01',
      taxMultiplier: '999999999999.99',
    },
  ])
    assert.throws(() => channelDiscount(input));
  assert.equal(channelDiscount({}).purchaseDiscount, null);
  for (const amount of ['', '待定', '-1', 'NaN', '10000000000000000'])
    assert.throws(() => purchaseCost('1', amount));
});

test('未结算可查看佣金与对应模式折扣，采购金额为空也可参考，不写入快照', () => {
  const row = {
    storeCommissionRate: '12',
    purchaseChannel: ['XB'],
    shippingMode: 'FBM',
    settlement: null,
    purchaseAmount: null,
    commissionRate: null,
    purchaseDiscount: null,
  };
  const options = [{ value: 'XB', fbaPurchaseDiscount: '0.8000', fbmPurchaseDiscount: '0.7795' }];
  const before = structuredClone(row);
  const result = currentFinanceConfig(row, options);
  assert.equal(result.commissionRate, '12.00');
  assert.equal(result.purchaseDiscount, '0.7795');
  assert.match(result.discountMessage, /当前配置，结算时确定（XB · FBM）/);
  assert.equal(
    currentFinanceConfig({ ...row, shippingMode: 'FBA' }, options).purchaseDiscount,
    '0.8000',
  );
  assert.deepEqual(row, before);
});

test('多渠道明确选择，缺少渠道/模式/配置时不给猜测折扣，0为有效配置', () => {
  const options = [{ value: 'A', fbaPurchaseDiscount: '0', fbmPurchaseDiscount: '0.8' }];
  const row = { storeCommissionRate: '0', purchaseChannel: ['A', 'B'], shippingMode: 'FBA' };
  assert.equal(currentFinanceConfig(row, options).commissionRate, '0.00');
  assert.equal(currentFinanceConfig(row, options).purchaseDiscount, null);
  assert.match(currentFinanceConfig(row, options).discountMessage, /选择.*成本计算渠道/);
  assert.equal(
    currentFinanceConfig({ ...row, purchaseCostChannel: 'A' }, options).purchaseDiscount,
    '0.0000',
  );
  for (const changes of [
    { purchaseChannel: [] },
    { shippingMode: null },
    { shippingMode: 'WFS' },
    { purchaseCostChannel: '其他' },
    { purchaseCostChannel: 'B' },
  ]) {
    const result = currentFinanceConfig({ ...row, purchaseCostChannel: 'A', ...changes }, options);
    assert.equal(result.purchaseDiscount, null);
    assert.ok(result.discountMessage);
  }
  assert.equal(
    currentFinanceConfig({ ...row, purchaseCostChannel: 'A' }, [{ ...options[0], active: false }])
      .purchaseDiscount,
    null,
  );
  for (const value of [null, '', ' ', 'invalid', '-1', '101'])
    assert.equal(
      currentFinanceConfig({ ...row, storeCommissionRate: value }, options).commissionRate,
      null,
    );
});
