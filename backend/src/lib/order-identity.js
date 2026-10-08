import { createHash } from 'node:crypto';
import { storedChannels } from './channels.js';

export const IMPORT_MATCH_RULE = 'order-walmart-sku-shop-v5';
export const PURCHASE_MATCH_RULE = 'purchase-existing-shop-order-walmart-sku-v1';

/** 空值统一为空字符串，保留大小写和前导零；JSON 元组避免分隔符碰撞。 */
export function orderIdentityKey(patch) {
  const values = [
    patch.walmartSku !== undefined ? patch.walmartSku : patch.sku,
    patch.shopName,
  ].map((value) => String(value ?? '').trim());
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** 多选按完整集合生成索引，忽略顺序和重复项；未填写渠道使用统一空键。 */
export function channelKey(channels) {
  const names = [...new Set(storedChannels(channels) || [])].sort();
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

export function importRowKey(patch) {
  return JSON.stringify([patch.orderNumber, orderIdentityKey(patch)]);
}
