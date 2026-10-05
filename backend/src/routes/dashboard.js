import { Router } from 'express';
import { Op } from 'sequelize';
import { OrderItem, Purchase, DictionaryOption } from '../models.js';
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
    const shops = (
      await OrderItem.findAll({
        attributes: ['shopName'],
        group: ['shopName'],
        where: { shopName: { [Op.ne]: null } },
      })
    )
      .map((item) => item.shopName)
      .filter(Boolean);
    res.json({ total, unassigned, inProgress, afterSales, shops });
  });
  return router;
}
