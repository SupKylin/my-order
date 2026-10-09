import { Op } from 'sequelize';
import { db, OrderItem } from '../models.js';
import { WalmartReceipt } from '../services/walmart/models.js';
import { mapOrderLine, orderLines } from '../services/walmart/mapping.js';

/** 使用已保存的官方响应回填金额及履约方，不调用远端接口，也不触发确认订单。 */
export async function backfillWalmartCommercialFields() {
  let lastId = 0;
  while (true) {
    const items = await OrderItem.findAll({
      where: { id: { [Op.gt]: lastId }, walmart: { [Op.ne]: null } },
      attributes: ['id'],
      order: [['id', 'ASC']],
      limit: 200,
    });
    for (const entry of items) {
      await db.transaction(async (transaction) => {
        const item = await OrderItem.findByPk(entry.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!item?.walmart || item.walmart.commercialMappingVersion === 1) return;
        const receipt = await WalmartReceipt.findOne({
          where: {
            storeId: item.walmart.storeId,
            purchaseOrderId: item.walmart.purchaseOrderId,
          },
          transaction,
        });
        if (!receipt) return;
        const line = orderLines(receipt.raw)
          .filter((row) => row.item?.sku === item.walmartSku)
          .at(-1);
        if (!line) return;
        const { fields } = mapOrderLine(
          { id: receipt.storeId, systemStoreName: item.shopName },
          receipt.raw,
          line,
        );
        await item.update(
          {
            ...(fields.orderAmount !== undefined ? { orderAmount: fields.orderAmount } : {}),
            ...(fields.fulfillmentParty !== undefined
              ? { fulfillmentParty: fields.fulfillmentParty }
              : {}),
            walmart: { ...item.walmart, commercialMappingVersion: 1 },
            version: item.version + 1,
          },
          { transaction },
        );
      });
    }
    if (items.length < 200) break;
    lastId = items.at(-1).id;
  }
}
