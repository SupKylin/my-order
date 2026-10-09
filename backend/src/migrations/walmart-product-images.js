import { Op } from 'sequelize';
import { db, OrderItem } from '../models.js';
import { walmartImage } from '../lib/product-image.js';

/** 仅从官方快照补齐空图片；已有图片保留，不调用接口、不触发订单确认。 */
export async function backfillWalmartProductImages() {
  let lastId = 0;
  let updated = 0;
  while (true) {
    const batch = await OrderItem.findAll({
      where: { id: { [Op.gt]: lastId }, walmart: { [Op.ne]: null } },
      attributes: ['id'],
      order: [['id', 'ASC']],
      limit: 200,
    });
    for (const entry of batch) {
      await db.transaction(async (transaction) => {
        const item = await OrderItem.findByPk(entry.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!item?.walmart || item.productImage) return;
        const productImage = walmartImage(item.walmart.imageUrl);
        if (!productImage) return;
        await item.update({ productImage, version: item.version + 1 }, { transaction });
        updated += 1;
      });
    }
    if (batch.length < 200) break;
    lastId = batch.at(-1).id;
  }
  return updated;
}
