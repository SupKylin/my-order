import { assert } from '../errors.js';

/** Walmart 的 WFS 履约原值为 WFSFulfilled，兼容历史展示值及大小写空格。 */
export const isWfsOrder = (item) =>
  ['WFS', 'WFSFULFILLED'].includes(
    String(item?.fulfillmentParty ?? '')
      .trim()
      .toUpperCase(),
  );

export const WFS_READ_ONLY_REASON = 'WFS 订单只允许由 Walmart 同步更新，不能人工修改或导入采购信息';

export function assertOrderEditable(item) {
  assert(!isWfsOrder(item), WFS_READ_ONLY_REASON, 403);
}

export function assertPurchaseImport(kind) {
  assert(kind === 'purchase', '订单导入已关闭，订单只能从 Walmart 官方接口拉取', 403);
}
