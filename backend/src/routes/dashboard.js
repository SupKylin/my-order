import { Router } from 'express';
import { OrderItem, Purchase, DictionaryOption, Store } from '../models.js';
import { ROLES } from '../fields.js';
import { getFieldDefinitions } from '../services/dictionaries.js';
import { config } from '../config.js';

export function createDashboardRouter() {
  const router = Router();
  router.get('/meta', async (req, res) =>
    res.json({
      fields: await getFieldDefinitions(),
      roles: ROLES,
      publicBase: config.publicBase,
      purchaseChannels: await DictionaryOption.findAll({
        where: { kind: 'purchaseChannel', active: true },
        attributes: ['id', 'value'],
        order: [
          ['sortOrder', 'ASC'],
          ['id', 'ASC'],
        ],
      }),
    }),
  );
  router.get('/dashboard', async (req, res) => {
    // 按商品明细统计数量；订单金额可能在多个 SKU 中重复，因此不在此累加。
    const total = await OrderItem.count();
    const unassigned = await Purchase.count({ where: { assignedTo: null } });
    const inProgress = await Purchase.count({ where: { purchaseStatus: '采购中' } });
    const afterSales = await Purchase.count({ where: { afterSales: '是' } });
    // 筛选选项以店铺管理为准，使用系统店铺名与订单字段匹配。
    const shops = (
      await Store.findAll({
        attributes: ['systemStoreName'],
        order: [['systemStoreName', 'ASC']],
      })
    ).map((store) => store.systemStoreName);
    res.json({ total, unassigned, inProgress, afterSales, shops });
  });
  return router;
}
