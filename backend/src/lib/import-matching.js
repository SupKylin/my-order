import { channelKey, importRowKey } from './order-identity.js';

/**
 * rows 按 Excel 行顺序、existing 按明细 ID 升序传入，返回与 rows 对齐的旧明细。
 * 先为整批保留同渠道匹配，再使用同订单下剩余的空渠道明细，避免抢占后续行。
 * 只消耗导入前的快照，每条旧明细最多使用一次，本批新增行不参与匹配。
 */
export function matchImportRows(rows, existing) {
  const groups = new Map();
  for (const item of existing) {
    const key = JSON.stringify([item.orderNumber, item.purchaseChannelKey]);
    if (!groups.has(key)) groups.set(key, { items: [], next: 0 });
    groups.get(key).items.push(item);
  }
  function take(key) {
    const group = groups.get(key);
    return group && group.next < group.items.length ? group.items[group.next++] : null;
  }
  const targets = rows.map((row) => take(importRowKey(row.patch)));
  const emptyChannelKey = channelKey(null);
  return targets.map(
    (item, index) => item || take(JSON.stringify([rows[index].patch.orderNumber, emptyChannelKey])),
  );
}
