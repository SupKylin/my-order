import test from 'node:test';
import assert from 'node:assert/strict';
import { channelDiscount, purchaseCost } from '../src/lib/channel-discount.js';
import { discountPreview, costPreview } from '../../frontend/src/utils/purchaseCost.js';

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
