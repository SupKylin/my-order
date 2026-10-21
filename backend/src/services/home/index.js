import { createHash } from 'node:crypto';
import { Op, Transaction } from 'sequelize';
import { db, Store, Order, OrderItem, Purchase, storeOwnerInclude } from '../../models.js';
import { StoreSnapshot } from './model.js';
import { pstDay, createStatistics } from './statistics.js';
import { fetchRemoteMetrics, REMOTE_METRICS } from './remote.js';
import { createDailyStatistics, dailyReport, dailyDates } from './daily.js';
import { WalmartReceipt } from '../walmart/models.js';

export function snapshotSource(store) {
  return (
    createHash('sha256')
      // 区分只存平台指标的新快照，回退旧版时可自动重建其所需的订单快照。
      .update(
        JSON.stringify([
          'seller-performance-realtime-pst-v5',
          store.systemStoreName,
          store.clientId,
          store.clientSecret,
        ]),
      )
      .digest('hex')
  );
}
export function snapshotDue(snapshot, store, now = Date.now()) {
  if (
    !snapshot ||
    snapshot.sourceKey !== snapshotSource(store) ||
    snapshot.snapshotDate !== pstDay(now)
  )
    return true;
  return (
    snapshot.attempts < 3 &&
    Number(now) - new Date(snapshot.attemptedAt).getTime() >= 15 * 60000 &&
    Object.keys(REMOTE_METRICS).some((key) => snapshot.remote?.[key]?.status !== 'ok')
  );
}

/** 一次一致性读批量汇总有权限的店铺；分页控制内存，不逐店扫描订单。 */
async function collectStoresStatistics(stores, now, transaction) {
  const groups = new Map(
    stores.map((store) => [
      store.systemStoreName,
      {
        id: store.id,
        statistics: createStatistics(now),
        daily: createDailyStatistics(now),
      },
    ]),
  );
  if (!groups.size) return new Map();
  const firstDay = Date.parse(`${dailyDates(now).at(-1)}T00:00:00-08:00`);
  let cursor = 0;
  for (;;) {
    const rows = await OrderItem.findAll({
      attributes: ['id', 'shopName', 'walmart', 'orderAmount', 'fulfillmentParty', 'orderStatus'],
      where: { shopName: { [Op.in]: [...groups.keys()] }, id: { [Op.gt]: cursor } },
      include: [
        { model: Order, as: 'order', attributes: ['orderNumber'], required: true },
        {
          model: Purchase,
          as: 'purchase',
          attributes: ['reviewStatus', 'purchaseStatus', 'allocatable'],
        },
      ],
      order: [['id', 'ASC']],
      limit: 500,
      transaction,
    });
    // 仅最近 30 天需要读取退款；按店铺和 PO 成对关联，防止跨店铺串单。
    const receiptIds = new Map();
    for (const row of rows) {
      const time = Number(row.walmart?.orderDate);
      if (
        !Number.isFinite(time) ||
        time < firstDay ||
        time > Number(now) ||
        !row.walmart?.purchaseOrderId
      )
        continue;
      const storeId = groups.get(row.shopName).id;
      if (!receiptIds.has(storeId)) receiptIds.set(storeId, new Set());
      receiptIds.get(storeId).add(row.walmart.purchaseOrderId);
    }
    const receipts = receiptIds.size
      ? await WalmartReceipt.findAll({
          attributes: ['storeId', 'purchaseOrderId', 'raw'],
          where: {
            [Op.or]: [...receiptIds].map(([storeId, ids]) => ({
              storeId,
              purchaseOrderId: { [Op.in]: [...ids] },
            })),
          },
          transaction,
        })
      : [];
    const rawLines = new Map();
    for (const receipt of receipts) {
      for (const line of receipt.raw?.orderLines?.orderLine || []) {
        rawLines.set(
          JSON.stringify([receipt.storeId, receipt.purchaseOrderId, String(line.lineNumber)]),
          line,
        );
      }
    }
    for (const row of rows) {
      const item = row.toJSON();
      const group = groups.get(item.shopName);
      group.statistics.add(item);
      group.daily.add(
        item,
        rawLines.get(
          JSON.stringify([
            group.id,
            item.walmart?.purchaseOrderId,
            String(item.walmart?.lineNumber),
          ]),
        ),
      );
    }
    if (rows.length < 500) break;
    cursor = rows.at(-1).id;
  }
  return new Map(
    [...groups.values()].map((group) => [
      group.id,
      { ...group.statistics.result(), daily: group.daily.result() },
    ]),
  );
}

export async function collectStoreStatistics(store, now = Date.now()) {
  return db.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => (await collectStoresStatistics([store], now, transaction)).get(store.id),
  );
}

export async function updateStoreSnapshot(
  store,
  { now = Date.now(), remoteLoader = fetchRemoteMetrics } = {},
) {
  const previous = await StoreSnapshot.findByPk(store.id);
  if (!snapshotDue(previous, store, now)) return false;
  const sourceKey = snapshotSource(store);
  const sameSource = previous?.sourceKey === sourceKey;
  const retryOnly = sameSource && previous.snapshotDate === pstDay(now);
  const attemptedAt = new Date(now);
  const base = {
    storeId: store.id,
    sourceKey,
    snapshotDate: pstDay(now),
    measuredAt: retryOnly ? previous.measuredAt : attemptedAt,
    // 保留原表结构；订单统计由 readHome 实时计算，不再写入每日快照。
    metrics: {},
    attempts: retryOnly ? previous.attempts + 1 : 1,
    attemptedAt,
  };
  let remote;
  try {
    remote = await remoteLoader(store, sameSource ? previous.remote : {}, {
      retryOnly,
      now: attemptedAt,
    });
  } catch {
    remote = Object.fromEntries(
      Object.keys(REMOTE_METRICS).map((key) => [
        key,
        {
          ...(sameSource ? previous.remote?.[key] : {}),
          status: 'error',
          error: '请检查店铺密钥配置',
        },
      ]),
    );
  }
  // 查询期间店铺可能被删除或更换密钥；不把旧店铺数据写回新配置。
  await db.transaction(async (transaction) => {
    const current = await Store.findByPk(store.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (current && snapshotSource(current) === sourceKey)
      await StoreSnapshot.upsert({ ...base, remote }, { transaction });
  });
  return true;
}

export async function readHome(user, now = Date.now()) {
  return db.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      const stores = await Store.findAll({
        where: user.role === 'operations' ? { ownerId: user.id } : {},
        include: [storeOwnerInclude],
        order: [['systemStoreName', 'ASC']],
        transaction,
      });
      const snapshots = stores.length
        ? await StoreSnapshot.findAll({
            where: { storeId: stores.map((store) => store.id) },
            transaction,
          })
        : [];
      const byId = new Map(snapshots.map((row) => [row.storeId, row]));
      const metrics = await collectStoresStatistics(stores, now, transaction);
      const measuredAt = new Date(now);
      const visibleStores = stores.map((store) => {
        const row = byId.get(store.id);
        const snapshot = row?.sourceKey === snapshotSource(store) ? row : null;
        return {
          id: store.id,
          name: store.systemStoreName,
          walmartName: store.walmartStoreName,
          owner: store.owner?.displayName || '未绑定',
          ownerId: store.owner?.id ?? null,
          ownerUsername: store.owner?.username || '',
          snapshotDate: snapshot?.snapshotDate || null,
          remoteMeasuredAt: snapshot?.measuredAt || null,
          measuredAt,
          metrics: metrics.get(store.id),
          remote: snapshot?.remote || {},
        };
      });
      return {
        today: pstDay(now),
        measuredAt,
        stores: visibleStores,
        ...dailyReport(visibleStores, now),
      };
    },
  );
}

/** 美西标准时间 PST 跨日触发，重启自动补做；数据库命名锁防止多个应用实例重复执行。 */
export async function refreshHomeSnapshots({
  shouldStop = () => false,
  update = updateStoreSnapshot,
} = {}) {
  const connection = await db.connectionManager.getConnection();
  const key = `home:${db.getDatabaseName()}`.slice(0, 64);
  let acquired = false;
  try {
    const [rows] = await connection.promise().query('SELECT GET_LOCK(?, 0) AS acquired', [key]);
    acquired = Number(rows[0].acquired) === 1;
    if (!acquired) return;
    const stores = await Store.findAll({ order: [['id', 'ASC']] });
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, stores.length) }, async () => {
        while (index < stores.length && !shouldStop()) {
          const store = stores[index++];
          try {
            await update(store);
          } catch {
            console.error(`首页店铺 ${store.id} 快照更新失败，将稍后重试`);
          }
        }
      }),
    );
  } finally {
    try {
      if (acquired) await connection.promise().query('SELECT RELEASE_LOCK(?)', [key]);
    } finally {
      await db.connectionManager.releaseConnection(connection);
    }
  }
}

export function startHomeScheduler() {
  let pending = null,
    stopped = false;
  const tick = () => {
    if (pending || stopped) return;
    pending = refreshHomeSnapshots({ shouldStop: () => stopped })
      .catch(() => console.error('首页快照任务失败，请检查数据库迁移是否完成'))
      .finally(() => {
        pending = null;
      });
  };
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
