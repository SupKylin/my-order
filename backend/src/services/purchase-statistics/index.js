import { Op, fn, col, where, Transaction, UniqueConstraintError } from 'sequelize';
import { db, OrderItem, Purchase } from '../../models.js';
import { allowedStoreNames, requirePermission } from '../../permissions.js';
import { PurchaseStatisticsSnapshot, PurchaseStatisticsGroup } from './model.js';
import {
  DAY,
  beijingDay,
  midnight,
  nextMidnight,
  groupStatistics,
  statisticsFilters,
  buildReport,
} from './statistics.js';

/** 整个聚合使用一次一致性读取；同一统计日只提交一次，不覆盖历史。 */
export async function capturePurchaseStatistics({ scheduledAt, now = Date.now() }) {
  const boundary = Number(scheduledAt);
  if (!Number.isFinite(boundary) || boundary !== midnight(boundary) || boundary > now)
    throw new Error('采购统计采集时刻无效');
  // 停机或严重延迟不能用今天状态伪造多日前的快照。
  if (now >= boundary + DAY) return { skipped: true };
  const date = beijingDay(boundary - 1);
  if (await PurchaseStatisticsSnapshot.findByPk(date)) return { existing: true };
  try {
    return await db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        await PurchaseStatisticsSnapshot.create(
          { date, scheduledAt: new Date(boundary), capturedAt: new Date(now) },
          { transaction },
        );
        const grouped = await OrderItem.findAll({
          attributes: [
            'shopName',
            [col('purchase.purchaseChannel'), 'channels'],
            [col('purchase.purchaseStatus'), 'status'],
            [fn('COUNT', col('OrderItem.id')), 'count'],
          ],
          include: [{ model: Purchase, as: 'purchase', attributes: [], required: false }],
          where: {
            [Op.and]: [
              where(
                fn('UPPER', fn('TRIM', fn('COALESCE', col('OrderItem.fulfillmentParty'), ''))),
                { [Op.notIn]: ['WFS', 'WFSFULFILLED'] },
              ),
              where(
                fn('UPPER', fn('TRIM', fn('COALESCE', col('OrderItem.platformOrderStatus'), ''))),
                { [Op.notIn]: ['已取消', 'CANCELLED', 'CANCELED'] },
              ),
            ],
          },
          group: [
            col('OrderItem.shopName'),
            col('purchase.purchaseChannel'),
            col('purchase.purchaseStatus'),
          ],
          transaction,
          raw: true,
        });
        const groups = groupStatistics(grouped).map((group) => ({ ...group, date }));
        if (groups.length) await PurchaseStatisticsGroup.bulkCreate(groups, { transaction });
        return { date, groups: groups.length };
      },
    );
  } catch (error) {
    if (error instanceof UniqueConstraintError) return { existing: true };
    throw error;
  }
}

export async function readPurchaseStatistics(query, user, now = Date.now()) {
  requirePermission(user, 'purchase-statistics');
  const filters = statisticsFilters(query, now);
  const snapshots = await PurchaseStatisticsSnapshot.findAll({
    where: { date: { [Op.between]: [filters.startDate, filters.endDate] } },
    order: [['date', 'DESC']],
    raw: true,
  });
  const allowed = await allowedStoreNames(user);
  const groups =
    snapshots.length && (!allowed || allowed.size)
      ? await PurchaseStatisticsGroup.findAll({
          where: {
            date: { [Op.in]: snapshots.map((row) => row.date) },
            ...(allowed ? { shopName: { [Op.in]: [...allowed] } } : {}),
          },
          raw: true,
        })
      : [];
  return buildReport(snapshots, groups, filters);
}

/** 精确安排北京时间下一次零点。失败延迟重试记录真实采集时刻，不补造停机历史。 */
export function startPurchaseStatisticsScheduler({
  clock = Date.now,
  capture = capturePurchaseStatistics,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stopped = false,
    timer,
    pending = null;
  // 启动恰逢零点的第一分钟可完成本期，否则等下一次零点。
  let target = clock() - midnight(clock()) < 60000 ? midnight(clock()) : nextMidnight(clock());
  const schedule = (delay) => {
    timer = setTimer(tick, Math.max(0, delay));
    timer.unref?.();
  };
  const tick = () => {
    if (stopped || pending) return;
    if (clock() < target) return schedule(target - clock());
    if (clock() >= target + DAY) target = midnight(clock());
    let retry = false;
    pending = capture({ scheduledAt: target, now: clock() })
      .catch(() => {
        retry = true;
        console.error('采购统计快照失败，一分钟后重试，请检查数据库迁移');
      })
      .finally(() => {
        pending = null;
        if (!retry) target = nextMidnight(clock());
        if (!stopped) schedule(retry ? 60000 : target - clock());
      });
  };
  schedule(target - clock());
  return async () => {
    stopped = true;
    clearTimer(timer);
    await pending;
  };
}
