import { Router } from 'express';
import { OrderItem, Purchase, DictionaryOption, Store, User } from '../models.js';
import { Op } from 'sequelize';
import { allowedStoreNames } from '../permissions.js';
import { ROLES } from '../fields.js';
import { getFieldDefinitions } from '../services/dictionaries.js';
import { config } from '../config.js';
import { readHome } from '../services/home/index.js';

export function createDashboardRouter() {
  const router = Router();
  router.get('/home', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await readHome(req.user));
  });
  router.get('/meta', async (req, res) =>
    res.json({
      fields: await getFieldDefinitions(),
      roles: ROLES,
      publicBase: config.publicBase,
      currentRole: req.user.role,
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
  router.get('/order-owners', async (req, res) => {
    res.json(
      await User.findAll({
        attributes: ['id', 'username', 'displayName'],
        ...(req.user.role === 'operations' ? { where: { id: req.user.id } } : {}),
        order: [['id', 'ASC']],
      }),
    );
  });
  router.get('/dashboard', async (req, res) => {
    const names = await allowedStoreNames(req.user);
    const where = names ? { shopName: [...names] } : {};
    const include = [{ model: Purchase, as: 'purchase', attributes: [], required: true }];
    // 按商品明细统计数量；订单金额可能在多个 SKU 中重复，因此不在此累加。
    const total = await OrderItem.count({ where });
    const count = (condition) =>
      OrderItem.count({ where: { [Op.and]: [where, condition] }, include });
    const unassigned = await count({ '$purchase.assignedTo$': null });
    const inProgress = await count({ '$purchase.purchaseStatus$': '采购中' });
    const afterSales = await count({ '$purchase.afterSales$': '是' });
    // 筛选选项以店铺管理为准，使用系统店铺名与订单字段匹配。
    const shops = (
      await Store.findAll({
        ...(names ? { where: { ownerId: req.user.id } } : {}),
        attributes: ['systemStoreName'],
        order: [['systemStoreName', 'ASC']],
      })
    ).map((store) => store.systemStoreName);
    res.json({ total, unassigned, inProgress, afterSales, shops });
  });
  return router;
}
