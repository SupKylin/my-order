import { OrderItem } from '../../models.js';

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** 复用已落库的平台规格快照；人工商品规格字段不作为接口缓存。 */
export async function readCatalogCache(store, sku, now = Date.now()) {
  const rows = await OrderItem.findAll({
    where: { shopName: store.systemStoreName, walmartSku: sku },
    attributes: ['walmart'],
  });
  const snapshots = rows
    .map((row) => row.walmart)
    .filter((snapshot) => {
      const fetchedAt = Date.parse(snapshot?.variantFetchedAt);
      return (
        snapshot?.storeId === store.id &&
        !snapshot.variantError &&
        Array.isArray(snapshot.attributes) &&
        fetchedAt <= now &&
        now - fetchedAt < CATALOG_TTL_MS
      );
    })
    .sort((a, b) => Date.parse(b.variantFetchedAt) - Date.parse(a.variantFetchedAt));
  const snapshot = snapshots[0];
  if (!snapshot) return null;
  return {
    item: {
      variantGroupId: snapshot.variantGroupId,
      variantGroupInfo: { groupingAttributes: snapshot.attributes },
    },
    fetchedAt: snapshot.variantFetchedAt,
  };
}
