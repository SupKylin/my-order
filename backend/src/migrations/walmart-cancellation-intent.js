import { Op, fn, col, literal, where } from 'sequelize';
import { db, OrderItem } from '../models.js';
import { WalmartReceipt } from '../services/walmart/models.js';
import { hasCancellationIntent } from '../lib/cancellation-intent.js';

/** 分批补齐旧快照；只读已保存的官方响应，不请求平台、不修改采购数据。 */
export async function backfillWalmartCancellationIntent() {
  let lastId = 0;
  let updated = 0;
  while (true) {
    const batch = await OrderItem.findAll({
      attributes: ['id'],
      where: {
        id: { [Op.gt]: lastId },
        walmart: { [Op.ne]: null },
        [Op.and]: where(
          fn('JSON_EXTRACT', col('walmart'), literal("'$.intentToCancel'")),
          Op.is,
          null,
        ),
      },
      order: [['id', 'ASC']],
      limit: 200,
    });
    for (const entry of batch) {
      await db.transaction(async (transaction) => {
        const item = await OrderItem.findByPk(entry.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!item?.walmart || Object.hasOwn(item.walmart, 'intentToCancel')) return;
        const { storeId, purchaseOrderId, lineNumber } = item.walmart;
        if (!storeId || !purchaseOrderId || !lineNumber) return;
        const receipt = await WalmartReceipt.findOne({
          where: { storeId, purchaseOrderId },
          transaction,
        });
        const line = receipt?.raw?.orderLines?.orderLine?.find(
          (row) => row.lineNumber === lineNumber && row.item?.sku === item.walmartSku,
        );
        if (!line) return;
        await item.update(
          {
            walmart: {
              ...item.walmart,
              intentToCancel: hasCancellationIntent(line.intentToCancel),
            },
          },
          { transaction, silent: true },
        );
        updated += 1;
      });
    }
    if (batch.length < 200) return updated;
    lastId = batch.at(-1).id;
  }
}
