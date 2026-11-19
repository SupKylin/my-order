import { Op } from 'sequelize';
import { Store } from '../models.js';
import { StoreSnapshot } from './home/model.js';
import { snapshotSource } from './home/snapshot-source.js';
import { sellerRefundLookup } from './home/seller-refund.js';

/** 每批仅加载相关店铺的已缓存报表，查询/导出不调用 Walmart、不逐行查数据库。 */
export async function enrichSellerRefunds(rows) {
  const names = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.returnInfo?.statuses?.includes('已退款') ||
            row.returnInfo?.lines?.some((line) => line.status === '已退款'),
        )
        .map((row) => row.shopName),
    ),
  ];
  if (!names.length) return rows;
  const stores = await Store.findAll({
    where: { systemStoreName: { [Op.in]: names } },
    attributes: ['id', 'systemStoreName', 'clientId', 'clientSecret'],
  });
  const snapshots = await StoreSnapshot.findAll({
    where: { storeId: { [Op.in]: stores.map((s) => s.id) } },
  });
  const byId = new Map(snapshots.map((snapshot) => [snapshot.storeId, snapshot]));
  const lookups = new Map(
    stores.map((store) => {
      const snapshot = byId.get(store.id);
      return [
        store.systemStoreName,
        sellerRefundLookup(
          snapshot?.sourceKey === snapshotSource(store) ? snapshot.remote?.reconciliation : null,
        ),
      ];
    }),
  );
  for (const row of rows) {
    const value = row.toJSON ? row.toJSON() : row;
    const refund = lookups.get(value.shopName)?.(value) || null;
    if (row.setDataValue) row.setDataValue('sellerRefund', refund);
    else row.sellerRefund = refund;
  }
  return rows;
}
