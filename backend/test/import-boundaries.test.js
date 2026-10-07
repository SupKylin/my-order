import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateImportMappings } from '../src/services/imports.js';

const mapping = (field) => ({ field });
const template = (fields, purchaseChannelId = null) => ({
  mappings: fields.map(mapping),
  purchaseChannelId,
});

test('订单入口拒绝采购字段和采购渠道绑定', () => {
  assert.doesNotThrow(() => validateImportMappings(template(['orderNumber', 'sku']), 'order'));
  assert.throws(
    () => validateImportMappings(template(['orderNumber', 'purchaseNote']), 'order'),
    /不属于订单导入字段/,
  );
  assert.throws(
    () => validateImportMappings(template(['orderNumber'], 1), 'order'),
    /订单导入不能绑定采购渠道/,
  );
});

test('采购入口需要采购字段且拒绝订单业务字段', () => {
  assert.doesNotThrow(() =>
    validateImportMappings(
      template(['orderNumber', 'sku', 'shopName', 'purchaseNote']),
      'purchase',
    ),
  );
  assert.throws(
    () => validateImportMappings(template(['orderNumber', 'sku']), 'purchase'),
    /至少需要映射一个采购字段/,
  );
  assert.throws(
    () =>
      validateImportMappings(template(['orderNumber', 'productName', 'purchaseNote']), 'purchase'),
    /不属于采购导入字段/,
  );
});
