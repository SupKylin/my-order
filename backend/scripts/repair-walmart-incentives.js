import { parseArgs } from 'node:util';
import { Op } from 'sequelize';
import { db, Store } from '../src/models.js';
import { WalmartReceipt } from '../src/services/walmart/models.js';
import { WalmartClient } from '../src/services/walmart/client.js';
import { acquireLock } from '../src/services/walmart/sync.js';
import { repairOrderIncentives } from '../src/services/walmart/incentive-repair.js';

// 默认预览。只读取正式接口，不调用确认/取消接口；--apply 才写入当前配置的数据库。
try {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      store: { type: 'string' },
      order: { type: 'string' },
    },
  });
  const stores = await Store.findAll({
    ...(values.store ? { where: { systemStoreName: values.store } } : {}),
    order: [['id', 'ASC']],
  });
  if (!stores.length) throw new Error('没有匹配店铺');
  const counts = { fetched: 0, updated: 0, would_update: 0, unchanged: 0, skipped: 0, failed: 0 };
  console.log(
    JSON.stringify({ mode: values.apply ? 'apply' : 'preview', database: db.getDatabaseName() }),
  );
  for (const store of stores) {
    const release = await acquireLock(store.id);
    if (!release) {
      counts.skipped++;
      console.log(
        JSON.stringify({
          shop: store.systemStoreName,
          status: 'skipped',
          reason: '店铺正在同步，请稍后重试',
        }),
      );
      continue;
    }
    try {
      const client = new WalmartClient(store);
      let lastId = 0;
      while (true) {
        const receipts = await WalmartReceipt.findAll({
          where: {
            storeId: store.id,
            id: { [Op.gt]: lastId },
            ...(values.order ? { customerOrderId: values.order } : {}),
          },
          attributes: ['id', 'purchaseOrderId', 'customerOrderId'],
          order: [['id', 'ASC']],
          limit: 100,
        });
        for (const receipt of receipts) {
          try {
            const remote = await client.order(receipt.purchaseOrderId);
            if (remote.customerOrderId !== receipt.customerOrderId)
              throw new Error('客户订单号不匹配');
            counts.fetched++;
            for (const result of await repairOrderIncentives(store, remote, {
              apply: values.apply,
            })) {
              counts[result.status]++;
              console.log(JSON.stringify(result));
            }
          } catch (error) {
            counts.failed++;
            console.log(
              JSON.stringify({
                shop: store.systemStoreName,
                order: receipt.customerOrderId,
                status: 'failed',
                reason: error.name?.startsWith('Sequelize') ? '数据库修复失败' : error.message,
              }),
            );
          }
        }
        if (receipts.length < 100) break;
        lastId = receipts.at(-1).id;
      }
    } catch (error) {
      counts.failed++;
      console.log(
        JSON.stringify({ shop: store.systemStoreName, status: 'failed', reason: error.message }),
      );
    } finally {
      await release();
    }
  }
  console.log(JSON.stringify({ summary: counts }));
  if (counts.failed || counts.skipped || !counts.fetched) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
