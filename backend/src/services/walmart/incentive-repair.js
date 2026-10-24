import { db, Order, OrderItem, Purchase } from '../../models.js';
import { WalmartReceipt } from './models.js';
import { isWalmartFunded, orderLineAmount, orderLines } from './mapping.js';
import { derivePurchaseFields } from '../../lib/purchase-derived.js';
import { sameFieldValue } from '../../lib/order-concurrency.js';
import { auditContext } from '../../lib/audit-context.js';
import { assert } from '../../errors.js';

/** 调用方持有店铺同步锁。仅修正已有明细的资助金额，不新增订单、不确认平台订单。 */
export async function repairOrderIncentives(store, remote, { apply = false } = {}) {
  return auditContext.run(undefined, () =>
    db.transaction(async (transaction) => {
      const order = await Order.findOne({
        where: { orderNumber: remote.customerOrderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      assert(order, '历史订单不存在，跳过修复');
      const results = [];
      // 与正式同步相同：同一订单同 SKU 取最后一个商品行，不累加或新增。
      const lines = [...new Map(orderLines(remote).map((line) => [line.item?.sku, line])).values()];
      for (const line of lines.filter(isWalmartFunded)) {
        const identity = {
          shop: store.systemStoreName,
          order: remote.customerOrderId,
          sku: line.item?.sku,
        };
        const items = await OrderItem.findAll({
          where: { orderId: order.id, shopName: store.systemStoreName, walmartSku: line.item?.sku },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const item = items[0];
        if (
          items.length !== 1 ||
          Number(item.walmart?.storeId) !== Number(store.id) ||
          item.walmart?.purchaseOrderId !== remote.purchaseOrderId ||
          item.walmart?.lineNumber !== line.lineNumber
        ) {
          results.push({
            ...identity,
            status: 'skipped',
            reason: '商品明细不唯一或平台绑定不一致',
          });
          continue;
        }
        const amount = orderLineAmount(line);
        const purchase = await Purchase.findOne({
          where: { itemId: item.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const { priceFactor } = derivePurchaseFields({
          orderAmount: amount,
          tax: item.tax,
          purchaseLinkAmount: purchase?.purchaseLinkAmount,
        });
        const changed = !sameFieldValue('orderAmount', item.orderAmount, amount);
        const factorChanged =
          purchase && !sameFieldValue('priceFactor', purchase.priceFactor, priceFactor);
        const result = {
          ...identity,
          itemId: item.id,
          before: item.orderAmount,
          after: amount,
          priceFactorBefore: purchase?.priceFactor ?? null,
          priceFactorAfter: priceFactor,
          status: changed || factorChanged ? (apply ? 'updated' : 'would_update') : 'unchanged',
        };
        if (apply) {
          await item.update(
            {
              orderAmount: amount,
              walmart: { ...item.walmart, incentive: line.incentive },
              ...(changed || factorChanged ? { version: item.version + 1 } : {}),
            },
            { transaction },
          );
          if (factorChanged) await purchase.update({ priceFactor }, { transaction });
        }
        results.push(result);
      }
      if (apply && results.some((result) => result.status !== 'skipped')) {
        const receipt = await WalmartReceipt.findOne({
          where: { storeId: store.id, purchaseOrderId: remote.purchaseOrderId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        assert(receipt?.customerOrderId === remote.customerOrderId, '订单回执不匹配，修复回滚');
        const raw = structuredClone(receipt.raw);
        for (const line of orderLines(raw)) {
          if (
            !results.some((result) => result.status !== 'skipped' && result.sku === line.item?.sku)
          )
            continue;
          const current = orderLines(remote).find(
            (entry) => entry.lineNumber === line.lineNumber && entry.item?.sku === line.item?.sku,
          );
          if (current && Object.hasOwn(current, 'incentive')) line.incentive = current.incentive;
        }
        await receipt.update({ raw }, { transaction });
      }
      return results;
    }),
  );
}
