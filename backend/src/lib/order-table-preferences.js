import { fields } from '../fields.js';
import { assert } from '../errors.js';

const columnKeys = new Set([
  ...fields
    .filter((field) => ['order', 'purchase'].includes(field.group))
    .map((field) => field.key),
  'purchaseConfirmedAt',
  'storeOwner',
]);
const fixedKeys = ['shopName', 'orderNumber'];

/** 只接受列键和隐藏列表，不能通过偏好接口修改账号或其他用户设置。 */
export function validateOrderTablePreferences(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '表头设置格式无效');
  for (const name of ['order', 'hidden']) {
    const keys = input[name];
    assert(
      Array.isArray(keys) &&
        keys.length <= columnKeys.size &&
        keys.every((key) => typeof key === 'string' && columnKeys.has(key)) &&
        new Set(keys).size === keys.length,
      '表头设置包含无效或重复字段',
    );
  }
  return {
    order: [...fixedKeys, ...input.order.filter((key) => !fixedKeys.includes(key))],
    hidden: [...input.hidden],
  };
}
