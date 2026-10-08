import { importRowKey } from './order-identity.js';

/**
 * rows 按 Excel 行顺序、existing 按明细 ID 升序传入，返回与 rows 对齐的旧明细。
 * 订单导入保留按出现顺序匹配；采购导入仅匹配三项唯一的已有明细。
 */
export function matchImportRows(rows, existing, kind = 'order') {
  if (kind === 'purchase') return matchPurchaseRows(rows, existing).map((match) => match.target);
  const groups = new Map();
  for (const item of existing) {
    const key = importRowKey(item);
    if (!groups.has(key)) groups.set(key, { items: [], next: 0 });
    groups.get(key).items.push(item);
  }
  function take(key) {
    const group = groups.get(key);
    if (!group) return null;
    return group.next < group.items.length ? group.items[group.next++] : null;
  }
  return rows.map((row) => {
    return take(importRowKey(row.patch));
  });
}

/** 采购 SKU、渠道都不参与定位；重复导入行可更新同一唯一目标。 */
export function matchPurchaseRows(rows, existing) {
  const groups = new Map();
  for (const item of existing) {
    const key = importRowKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return rows.map(({ patch }) => {
    if (['shopName', 'orderNumber', 'walmartSku'].some((key) => !String(patch[key] ?? '').trim()))
      return { target: null, reason: '店铺名、订单号、Walmart SKU 不能为空，无法进行三项匹配' };
    const matches = groups.get(importRowKey(patch)) || [];
    if (!matches.length) return { target: null, reason: '系统内不存在三项完全一致的订单商品明细' };
    if (matches.length > 1)
      return {
        target: null,
        reason: `系统内匹配到 ${matches.length} 条重复明细，无法唯一定位，请先核对`,
      };
    return { target: matches[0], reason: '' };
  });
}
