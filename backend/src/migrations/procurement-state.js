import { DataTypes, Op } from 'sequelize';
import { db, Purchase } from '../models.js';
import { procurementState } from '../lib/procurement-state.js';

/** 添加只读派生状态并分批校准历史记录，不清空渠道或改写人工采购值。 */
export async function migrateProcurementState() {
  const query = db.getQueryInterface();
  const columns = await query.describeTable('purchases');
  for (const key of ['reviewStatus', 'supplierAssignmentStatus'])
    if (!columns[key])
      await query.addColumn('purchases', key, { type: DataTypes.STRING(32), allowNull: true });
  let lastId = 0;
  while (true) {
    const rows = await Purchase.findAll({
      attributes: [
        'id',
        'allocatable',
        'purchaseChannel',
        'reviewStatus',
        'supplierAssignmentStatus',
      ],
      where: { id: { [Op.gt]: lastId } },
      order: [['id', 'ASC']],
      limit: 500,
    });
    for (const row of rows) {
      const state = procurementState(row);
      if (Object.entries(state).some(([key, value]) => row[key] !== value))
        await row.update(state, { silent: true });
    }
    if (rows.length < 500) break;
    lastId = rows.at(-1).id;
  }
}
