import { importRowKey } from './order-identity.js';

/**
 * rows 按 Excel 行顺序、existing 按明细 ID 升序传入，返回与 rows 对齐的旧明细。
 * 订单匹配店铺、订单号、WalmartSku；采购 SKU 为空时总是新增。
 * 只消耗导入前的快照，每条旧明细最多使用一次，本批新增行不参与匹配。
 */
export function matchImportRows(rows, existing, kind = 'order') {
  const groups = new Map();
  for (const item of existing) {
    const key = importRowKey(item);
    if (!groups.has(key)) groups.set(key, { items: [], next: 0 });
    groups.get(key).items.push(item);
  }
  function take(key, purchaseSku) {
    const group = groups.get(key);
    if (!group) return null;
    if (kind === 'purchase') {
      const matching = group.items.findIndex(
        (item, index) =>
          !group.used?.has(index) && String(item.purchaseSku ?? '').trim() === purchaseSku,
      );
      const index = matching >= 0 ? matching : group.items.findIndex((_, i) => !group.used?.has(i));
      if (index < 0) return null;
      group.used ||= new Set();
      group.used.add(index);
      return group.items[index];
    }
    return group.next < group.items.length ? group.items[group.next++] : null;
  }
  return rows.map((row) => {
    const purchaseSku = String(row.patch.purchaseSku ?? '').trim();
    if (kind === 'purchase' && !purchaseSku) return null;
    return take(importRowKey(row.patch), purchaseSku);
  });
}
