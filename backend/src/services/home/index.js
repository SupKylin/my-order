import { snapshotSource } from './snapshot-source.js';
import { sellerRefundLookup, SELLER_REFUND_VERSION } from './seller-refund.js';
import { Op, Transaction } from 'sequelize';
import {
  db,
  Store,
  Order,
  OrderItem,
  Purchase,
  PurchaseAfterSale,
  storeOwnerInclude,
} from '../../models.js';
import { StoreSnapshot } from './model.js';
import { pstDay, createStatistics } from './statistics.js';
import { fetchRemoteMetrics, REMOTE_METRICS } from './remote.js';
import { createDailyStatistics, dailyReport } from './daily.js';
import { RECON_VERSION, storeFinance } from './reconciliation.js';
import { RETURNS_VERSION, monthlyReturnsMetric } from './returns.js';
import { homeFilters } from './filters.js';
import { createProfitStatistics, profitReport } from './profit.js';

export { snapshotSource } from './snapshot-source.js';
export function snapshotDue(snapshot, store, now = Date.now()) {
  if (
    !snapshot ||
    snapshot.sourceKey !== snapshotSource(store) ||
    snapshot.snapshotDate !== pstDay(now) ||
    snapshot.remote?.financeFormat !== 2 ||
    snapshot.remote?.returnsVersion !== RETURNS_VERSION
  )
    return true;
  return (
    snapshot.attempts < 3 &&
    Number(now) - new Date(snapshot.attemptedAt).getTime() >= 15 * 60000 &&
    (Object.keys(REMOTE_METRICS).some((key) => snapshot.remote?.[key]?.status !== 'ok') ||
      snapshot.remote?.monthlyReturns?.status !== 'ok' ||
      snapshot.remote?.reconciliation?.version !== RECON_VERSION ||
      snapshot.remote?.reconciliation?.status !== 'ok' ||
      Object.values(snapshot.remote?.reconciliation?.reports || {}).some(
        (r) => r.financeFormat !== 2 || r.sellerRefundVersion !== SELLER_REFUND_VERSION,
      ))
  );
}

/** 一次一致性读批量汇总有权限的店铺；分页控制内存，不逐店扫描订单。 */
async function collectStoresStatistics(
  stores,
  now,
  transaction,
  snapshots = new Map(),
  range = null,
) {
  const groups = new Map(
    stores.map((store) => [
      store.systemStoreName,
      {
        id: store.id,
        sellerRefund: sellerRefundLookup(
          snapshots.get(store.id)?.sourceKey === snapshotSource(store)
            ? snapshots.get(store.id).remote?.reconciliation
            : null,
        ),
        statistics: createStatistics(now, range),
        profit: createProfitStatistics(now, range),
        daily: createDailyStatistics(
          now,
          snapshots.get(store.id)?.sourceKey === snapshotSource(store)
            ? snapshots.get(store.id).remote?.reconciliation
            : null,
          range,
        ),
      },
    ]),
  );
  if (!groups.size) return new Map();
  let cursor = 0;
  for (;;) {
    const rows = await OrderItem.findAll({
      attributes: [
        'id',
        'shopName',
        'walmart',
        'returnInfo',
        'orderAmount',
        'fulfillmentParty',
        'orderStatus',
      ],
      where: { shopName: { [Op.in]: [...groups.keys()] }, id: { [Op.gt]: cursor } },
      include: [
        { model: Order, as: 'order', attributes: ['orderNumber'], required: true },
        {
          model: PurchaseAfterSale,
          as: 'purchaseAfterSale',
          attributes: ['id', 'purchaseRefundAmount'],
          required: false,
        },
        {
          model: Purchase,
          as: 'purchase',
          attributes: [
            'reviewStatus',
            'purchaseStatus',
            'allocatable',
            'settlement',
            'commissionRate',
            'purchaseCost',
            'disputeSuccessAmount',
          ],
        },
      ],
      order: [['id', 'ASC']],
      limit: 500,
      transaction,
    });
    for (const row of rows) {
      const item = row.toJSON();
      const group = groups.get(item.shopName);
      group.statistics.add(item);
      group.daily.add(item);
      item.sellerRefund = group.sellerRefund(item);
      group.profit.add(item);
    }
    if (rows.length < 500) break;
    cursor = rows.at(-1).id;
  }
  return new Map(
    [...groups.values()].map((group) => [
      group.id,
      { ...group.statistics.result(), daily: group.daily.result(), profit: group.profit.result() },
    ]),
  );
}

export async function collectStoreStatistics(store, now = Date.now()) {
  return db.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      const snapshot = await StoreSnapshot.findByPk(store.id, { transaction });
      return (
        await collectStoresStatistics([store], now, transaction, new Map([[store.id, snapshot]]))
      ).get(store.id);
    },
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
    attempts:
      retryOnly && previous.remote?.returnsVersion === RETURNS_VERSION ? previous.attempts + 1 : 1,
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
  remote.financeFormat = 2;
  remote.returnsVersion = RETURNS_VERSION;
  if (!remote.monthlyReturns)
    remote.monthlyReturns = {
      ...monthlyReturnsMetric(sameSource ? previous.remote?.monthlyReturns : null, now),
      version: RETURNS_VERSION,
      status: 'error',
      statusText: '退款采集失败',
      error: '请检查店铺密钥配置和退货退款接口权限',
    };
  if (!remote.reconciliation)
    remote.reconciliation = {
      ...(sameSource ? previous.remote?.reconciliation : {}),
      status: 'error',
      error: '官方财务对账数据采集失败，请检查店铺密钥和接口权限',
    };
  // 查询期间店铺可能被删除或更换密钥；不把旧店铺数据写回新配置。
  await db.transaction(async (transaction) => {
    const current = await Store.findByPk(store.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (current && snapshotSource(current) === sourceKey)
      await StoreSnapshot.upsert({ ...base, remote }, { transaction });
  });
  return true;
}

export async function readHome(user, now = Date.now(), query = {}) {
  const filters = homeFilters(query, now);
  return db.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      const permittedStores = await Store.findAll({
        where: user.role === 'operations' ? { ownerId: user.id } : {},
        include: [storeOwnerInclude],
        order: [['systemStoreName', 'ASC']],
        transaction,
      });
      const stores = permittedStores.filter(
        (store) =>
          !filters ||
          ((!filters.ownerId || store.ownerId === filters.ownerId) &&
            (!filters.storeIds.length || filters.storeIds.includes(store.id))),
      );
      const snapshots = stores.length
        ? await StoreSnapshot.findAll({
            where: { storeId: stores.map((store) => store.id) },
            transaction,
          })
        : [];
      const byId = new Map(snapshots.map((row) => [row.storeId, row]));
      const metrics = await collectStoresStatistics(stores, now, transaction, byId, filters);
      const measuredAt = new Date(now);
      const visibleStores = stores.map((store) => {
        const row = byId.get(store.id);
        const snapshot = row?.sourceKey === snapshotSource(store) ? row : null;
        return {
          id: store.id,
          name: store.systemStoreName,
          isThirdParty: Boolean(store.isThirdParty),
          walmartName: store.walmartStoreName,
          owner: store.owner?.displayName || '未绑定',
          ownerId: store.owner?.id ?? null,
          ownerUsername: store.owner?.username || '',
          snapshotDate: snapshot?.snapshotDate || null,
          remoteMeasuredAt: snapshot?.measuredAt || null,
          measuredAt,
          metrics: metrics.get(store.id),
          remote: {
            ...(snapshot
              ? {
                  previousPayment: storeFinance(snapshot.remote?.reconciliation, now)
                    .previousPayment,
                  monthlyRefund: monthlyReturnsMetric(snapshot.remote?.monthlyReturns, now),
                }
              : {}),
            ...Object.fromEntries(
              Object.keys(REMOTE_METRICS)
                .filter((key) => snapshot?.remote?.[key])
                .map((key) => [key, snapshot.remote[key]]),
            ),
          },
        };
      });
      return {
        today: pstDay(now),
        measuredAt,
        stores: visibleStores,
        ...(filters
          ? {
              storeOptions: permittedStores.map((store) => ({
                id: store.id,
                name: store.systemStoreName,
                isThirdParty: Boolean(store.isThirdParty),
                ownerId: store.ownerId,
                owner: store.owner?.displayName || '未绑定',
                ownerUsername: store.owner?.username || '',
              })),
            }
          : {}),
        ...dailyReport(visibleStores, now, filters),
        ...(filters ? { profit: profitReport(visibleStores) } : {}),
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
