import { createHash } from 'node:crypto';
import { storedChannels } from './channels.js';

export const IMPORT_MATCH_RULE = 'order-channel-empty-fallback-v3';

/** 多选按完整集合生成索引，忽略顺序和重复项；未填写渠道使用统一空键。 */
export function channelKey(channels) {
  const names = [...new Set(storedChannels(channels) || [])].sort();
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

export function importRowKey(patch) {
  return JSON.stringify([patch.orderNumber, channelKey(patch.purchaseChannel)]);
}
