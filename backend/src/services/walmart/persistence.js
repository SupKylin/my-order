import { Op } from 'sequelize';
import { db, Order, OrderItem, AuditLog } from '../../models.js';
import { WalmartReceipt } from './models.js';
import { upsertImported } from '../orders.js';
import { validatePatch } from '../../validation.js';
import { assert } from '../../errors.js';
import { mapOrderLine, sourceKey, orderLines, isActiveOrder } from './mapping.js';

export async function persistOrder(store, order, catalog, actor) {
  const lines = orderLines(order);
  assert(lines.length > 0, 'Walmart 订单没有商品行');
  assert(
    new Set(lines.map((line) => line.lineNumber)).size === lines.length,
    'Walmart 商品行号重复',
  );
  const mapped = lines.map((line) => {
    const value = mapOrderLine(store, order, line, catalog.get(line.item?.sku));
    return { line, ...value, fields: validatePatch(value.fields, { requireKeys: true }) };
  });
  // 同一个平台订单多次返回同 SKU 时按出现顺序覆盖，最后一行生效，不再因行号新增。
  const uniqueEntries = [
    ...new Map(mapped.map((entry) => [entry.fields.walmartSku, entry])).values(),
  ];
  return db.transaction(async (transaction) => {
    const [parent] = await Order.findOrCreate({
      where: { orderNumber: mapped[0].fields.orderNumber },
      transaction,
    });
    await parent.reload({ transaction, lock: transaction.LOCK.UPDATE });
    let added = 0;
    let updated = 0;
    for (const entry of uniqueEntries) {
      const key = sourceKey(store.systemStoreName, order, entry.line);
      // 使用业务三字段匹配，Excel 手工录入、旧 PO/行号绑定记录同样参与查重。
      const candidates = await OrderItem.findAll({
        where: {
          orderId: parent.id,
          shopName: entry.fields.shopName,
          walmartSku: entry.fields.walmartSku,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
        order: [['id', 'ASC']],
      });
      // 原有重复行不删除，优先已绑定该三字段的记录，否则更新最早录入的一条。
      const target =
        candidates.find((item) => item.walmartSourceKey === key) ?? candidates[0] ?? null;
      // 人工编辑可能改变店铺/SKU，释放旧同步标识以免唯一索引阻止正确的业务匹配。
      await OrderItem.update(
        { walmartSourceKey: null },
        {
          where: { walmartSourceKey: key, ...(target ? { id: { [Op.ne]: target.id } } : {}) },
          transaction,
        },
      );
      const saved = await upsertImported(entry.fields, transaction, actor, target);
      const item = await OrderItem.findByPk(saved.id, { transaction });
      const snapshot = entry.walmart;
      // 商品接口临时失败不清空已验证的变体属性，保留抓取时间和失败提示。
      if (snapshot.variantError && item.walmart) {
        snapshot.attributes = item.walmart.attributes ?? [];
        snapshot.variantGroupId = item.walmart.variantGroupId;
        snapshot.variantFetchedAt = item.walmart.variantFetchedAt;
      }
      await item.update({ walmartSourceKey: key, walmart: snapshot }, { transaction });
      if (saved.created) added += 1;
      else updated += 1;
    }
    const [receipt] = await WalmartReceipt.findOrCreate({
      where: { storeId: store.id, purchaseOrderId: order.purchaseOrderId },
      defaults: { customerOrderId: order.customerOrderId, raw: order },
      transaction,
    });
    await receipt.update({ raw: order, active: isActiveOrder(order) }, { transaction });
    await AuditLog.create(
      {
        userId: actor.id,
        action: 'walmart_sync_order',
        entityId: String(receipt.id),
        details: { storeId: store.id, purchaseOrderId: order.purchaseOrderId, added, updated },
      },
      { transaction },
    );
    return { receipt, added, updated };
  });
}
