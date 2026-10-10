import { db, AuditLog } from '../models.js';
import { WalmartSync } from './walmart/models.js';
import { resourceConfig } from './management-list.js';
import { assert } from '../errors.js';

/** 与同步任务使用相同的跨进程锁；一条连接持有全部店铺锁，避免批量删除耗尽连接池。 */
async function lockStores(ids) {
  const connection = await db.connectionManager.getConnection();
  const held = [];
  const release = async () => {
    try {
      for (const key of held) await connection.promise().query('SELECT RELEASE_LOCK(?)', [key]);
    } finally {
      await db.connectionManager.releaseConnection(connection);
    }
  };
  try {
    for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
      const key = `walmart-sync:${id}`;
      const [rows] = await connection.promise().query('SELECT GET_LOCK(?, 0) AS acquired', [key]);
      assert(Number(rows[0].acquired) === 1, '选中的店铺正在同步，请待同步结束后再删除', 409);
      held.push(key);
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

export async function deleteManagement(resource, input, actor) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '删除参数无效');
  const { model } = resourceConfig(resource, input.kind);
  assert(
    Array.isArray(input.rows) && input.rows.length > 0 && input.rows.length <= 100,
    '请勾选 1 至 100 条记录',
  );
  const selected = new Map();
  for (const row of input.rows) {
    const id = resource === 'imports' ? row?.id : Number(row?.id);
    assert(
      resource === 'imports'
        ? typeof id === 'string' && /^[a-f\d-]{36}$/i.test(id)
        : Number.isSafeInteger(id) && id > 0,
      '记录 ID 无效',
    );
    assert(
      row.updatedAt && Number.isFinite(new Date(row.updatedAt).getTime()),
      '缺少记录版本，请刷新后重试',
    );
    selected.set(id, row);
  }
  const ids = [...selected.keys()];
  if (resource === 'users') assert(!selected.has(actor.id), '不能删除当前登录账号');
  const release = resource === 'stores' ? await lockStores(ids) : null;
  try {
    return await db.transaction(async (transaction) => {
      const where = { id: ids, ...(resource === 'dictionaries' ? { kind: input.kind } : {}) };
      // 与账号编辑使用相同加锁顺序，防止并发删除/停用最后一个启用的总账号。
      const all = await model.findAll({
        where: resource === 'users' ? {} : where,
        order: [['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const rows = all.filter((row) => selected.has(row.id));
      assert(rows.length === ids.length, '部分记录已删除，请刷新后重新勾选', 409);
      for (const row of rows) {
        const expected = selected.get(row.id);
        assert(
          row.updatedAt.getTime() === new Date(expected.updatedAt).getTime() &&
            (expected.version == null || row.version === expected.version),
          '记录已被修改，请刷新后重新勾选',
          409,
        );
      }
      if (resource === 'users')
        assert(
          all.some((row) => !selected.has(row.id) && row.active && row.role === 'admin'),
          '必须保留至少一个启用的总账号',
        );
      if (resource === 'stores') {
        // 持有店铺锁期间先关闭调度再移除配置；订单、采购和同步回执全部保留。
        await WalmartSync.update({ enabled: false }, { where: { storeId: ids }, transaction });
        await WalmartSync.destroy({ where: { storeId: ids }, transaction });
      }
      await model.destroy({ where, transaction });
      await AuditLog.create(
        {
          userId: actor.id,
          action: 'management_batch_delete',
          details: { resource, kind: input.kind, ids },
        },
        { transaction },
      );
      return { deleted: rows.length };
    });
  } finally {
    if (release) await release();
  }
}
