import { Op } from 'sequelize';
import { db, Store, User, AuditLog } from '../../models.js';
import { assert, AppError } from '../../errors.js';
import { WalmartClient } from './client.js';
import { WalmartSync, WalmartReceipt } from './models.js';
import { persistOrder } from './persistence.js';
import { acknowledgePersistedOrder } from './acknowledgement.js';
import { orderLines, mapOrderLine } from './mapping.js';
import { readCatalogCache } from './catalog-cache.js';
import { nextScheduledStore, syncDueAt, storeSpacing } from './scheduling.js';
import { WALMART_ORDER_START_MS, orderRangePatch, isOrderInRange } from './order-range.js';

const running = new Map();
const safeError = (error) =>
  error.name?.startsWith('Sequelize')
    ? '本地订单保存失败，请检查后端日志并重试'
    : String(error.message).slice(0, 500);

async function getStore(id) {
  const store = await Store.findByPk(id);
  assert(store, '店铺不存在', 404);
  return store;
}

/** 专用 MySQL 连接持有命名锁，覆盖多进程与手动/定时任务竞争。 */
async function acquireLock(storeId) {
  const connection = await db.connectionManager.getConnection();
  const key = `walmart-sync:${storeId}`;
  try {
    const [rows] = await connection.promise().query('SELECT GET_LOCK(?, 0) AS acquired', [key]);
    if (Number(rows[0].acquired) !== 1) {
      await db.connectionManager.releaseConnection(connection);
      return null;
    }
  } catch (error) {
    await db.connectionManager.releaseConnection(connection);
    throw error;
  }
  return async () => {
    try {
      await connection.promise().query('SELECT RELEASE_LOCK(?)', [key]);
    } finally {
      await db.connectionManager.releaseConnection(connection);
    }
  };
}

export async function configureSync(id, enabled, actor) {
  assert(typeof enabled === 'boolean', '同步开关参数无效');
  await getStore(id);
  return db.transaction(async (transaction) => {
    const [state] = await WalmartSync.findOrCreate({
      where: { storeId: id },
      defaults: { enabled, startedAt: new Date(WALMART_ORDER_START_MS), actorId: actor.id },
      transaction,
    });
    await state.update({ enabled, actorId: actor.id }, { transaction });
    await AuditLog.create(
      {
        userId: actor.id,
        action: 'walmart_sync_config',
        entityId: String(id),
        details: { enabled, startedAt: state.startedAt, environment: 'production' },
      },
      { transaction },
    );
    return state.toJSON();
  });
}

export async function syncStatus(id) {
  const state = await WalmartSync.findByPk(id);
  const problems = await WalmartReceipt.findAll({
    where: { storeId: id, ackStatus: { [Op.in]: ['failed', 'review', 'sending'] } },
    attributes: [
      'purchaseOrderId',
      'customerOrderId',
      'ackStatus',
      'ackAttempts',
      'lastError',
      'updatedAt',
    ],
    order: [['updatedAt', 'DESC']],
    limit: 100,
  });
  return { state: state?.toJSON() ?? null, problems };
}

async function getCatalog(client, order, cache, store) {
  for (const line of orderLines(order)) {
    const sku = line.item?.sku;
    if (!sku || cache.has(sku)) continue;
    try {
      // 预览始终实时读取；正式同步跨轮复用成功快照，失败不会延长缓存寿命。
      const cached = store ? await readCatalogCache(store, sku) : null;
      cache.set(
        sku,
        cached ?? { item: await client.item(sku), fetchedAt: new Date().toISOString() },
      );
    } catch (error) {
      cache.set(sku, { error: safeError(error) });
    }
  }
  return cache;
}

/** 预览只调用 GET 和 token 接口；不建任务、不落库、不确认。 */
export async function previewOrders(
  id,
  input,
  { clientFactory = (store) => new WalmartClient(store) } = {},
) {
  const store = await getStore(id);
  const requestedStart = new Date(input.start);
  const start = new Date(Math.max(requestedStart.getTime(), WALMART_ORDER_START_MS));
  const end = new Date(input.end);
  assert(
    Number.isFinite(start.getTime()) &&
      Number.isFinite(end.getTime()) &&
      start <= end &&
      end - start <= 31 * 86400000 &&
      end.getTime() <= Date.now() + 60000,
    '预览时间范围无效，只接收 2026-10-01（美西标准时间）起的订单，最多查询 31 天',
  );
  const client = clientFactory(store);
  const catalog = new Map();
  const orders = [];
  const seen = new Set();
  for await (const order of client.orders(start, end)) {
    if (
      seen.has(order.purchaseOrderId) ||
      order.orderDate < start.getTime() ||
      order.orderDate > end.getTime()
    )
      continue;
    seen.add(order.purchaseOrderId);
    assert(orders.length < 200, '预览最多 200 个订单，请缩小日期范围');
    await getCatalog(client, order, catalog);
    orders.push({
      customerOrderId: order.customerOrderId,
      purchaseOrderId: order.purchaseOrderId,
      lines: orderLines(order).map((line) =>
        mapOrderLine(store, order, line, catalog.get(line.item?.sku)),
      ),
    });
  }
  return { orders, start, end, readOnly: true };
}

async function executeSync(
  id,
  { clientFactory = (store) => new WalmartClient(store), scheduled = false } = {},
) {
  const release = await acquireLock(id);
  if (!release) return;
  let state;
  const result = {
    orders: 0,
    added: 0,
    updated: 0,
    acknowledged: 0,
    skipped: 0,
    failed: 0,
    review: 0,
    variantErrors: 0,
    errors: [],
  };
  try {
    state = await WalmartSync.findByPk(id);
    if (!state?.enabled) return;
    // 在跨进程命名锁内再次检查，避免不同服务实例重复执行同一轮自动任务。
    if (scheduled && syncDueAt(state) > Date.now()) return;
    // 持有店铺命名锁后调整旧起点，避免与另一轮同步的游标更新冲突。
    const rangePatch = orderRangePatch(state);
    if (Object.keys(rangePatch).length) await state.update(rangePatch);
    const store = await getStore(id);
    const actor = await User.findByPk(state.actorId);
    assert(actor?.active, '启用同步的账号已停用，请由有效账号重新启用');
    const client = clientFactory(store);
    const end = new Date();
    await state.update({ status: 'running', lastRunAt: end, finishedAt: null, error: null });
    const catalog = new Map();
    const seen = new Set();
    let importFailed = false;
    const stillEnabled = async () => (await WalmartSync.findByPk(id))?.enabled === true;

    const processOrder = async (order) => {
      // 接口异常返回范围外数据、或旧回执刷新时同样不落库、不确认。
      if (!isOrderInRange(order, end.getTime())) return;
      if (seen.has(order.purchaseOrderId)) return;
      seen.add(order.purchaseOrderId);
      result.orders += 1;
      try {
        assert(
          Number.isFinite(Number(order.orderDate)) &&
            Number(order.orderDate) >= state.startedAt.getTime(),
          '订单早于接收起点，已跳过',
        );
        await getCatalog(client, order, catalog, store);
        const saved = await persistOrder(store, order, catalog, actor);
        result.added += saved.added;
        result.updated += saved.updated;
        // 未提交成功绝不会到达确认逻辑；暂停时已保存的订单留待下次恢复。
        if (!(await stillEnabled())) return;
        const outcome = await acknowledgePersistedOrder({
          purchaseOrderId: order.purchaseOrderId,
          client,
          save: async (latest) => {
            assert(isOrderInRange(latest, end.getTime()), '订单下单时间超出接收范围，已停止确认');
            assert(
              latest.customerOrderId === order.customerOrderId,
              'Walmart 客户订单号发生变化，需要核对',
            );
            await getCatalog(client, latest, catalog, store);
            await persistOrder(store, latest, catalog, actor);
          },
          mark: async (status, error, attempt = false) => {
            if (status === 'sending') assert(await stillEnabled(), '同步已暂停');
            await saved.receipt.update({
              ackStatus: status,
              lastError: error?.slice(0, 500) ?? null,
              ...(attempt ? { ackAttempts: saved.receipt.ackAttempts + 1 } : {}),
              ...(status === 'acknowledged' ? { acknowledgedAt: new Date() } : {}),
            });
          },
        });
        if (outcome === 'skip') result.skipped += 1;
        else if (Object.hasOwn(result, outcome)) result[outcome] += 1;
      } catch (error) {
        importFailed = true;
        result.failed += 1;
        if (result.errors.length < 100)
          result.errors.push({ purchaseOrderId: order.purchaseOrderId, message: safeError(error) });
      }
      // JSON 字段必须写入新对象；复用并原地修改对象会被 Sequelize 当作未变化。
      await state.update({ result: structuredClone(result) });
    };

    // createdStartDate 不会返回旧单的新状态；主动刷新已接入的非终态和失败记录。
    const receipts = await WalmartReceipt.findAll({
      where: {
        storeId: id,
        [Op.or]: [{ active: true }, { ackStatus: { [Op.in]: ['pending', 'failed', 'sending'] } }],
      },
    });
    for (const receipt of receipts) {
      if (!(await stillEnabled())) break;
      try {
        await processOrder(await client.order(receipt.purchaseOrderId));
      } catch (error) {
        result.failed += 1;
        await receipt.update({ lastError: safeError(error) });
        if (result.errors.length < 100)
          result.errors.push({
            purchaseOrderId: receipt.purchaseOrderId,
            message: safeError(error),
          });
      }
    }
    // 重叠 5 分钟防止接口可见性延迟；稳定商品行键保证重复拉取不会新增。
    let start = Math.max(
      state.startedAt.getTime(),
      (state.cursorAt?.getTime() ?? state.startedAt.getTime()) - 5 * 60000,
    );
    let complete = true;
    while (start <= end.getTime()) {
      if (!(await stillEnabled())) {
        complete = false;
        break;
      }
      const segmentEnd = Math.min(start + 7 * 86400000, end.getTime());
      for await (const order of client.orders(new Date(start), new Date(segmentEnd))) {
        if (!(await stillEnabled())) {
          complete = false;
          break;
        }
        if (
          Number(order.orderDate) < state.startedAt.getTime() ||
          Number(order.orderDate) > end.getTime()
        )
          continue;
        await processOrder(order);
      }
      if (!complete || segmentEnd === end.getTime()) break;
      start = segmentEnd;
    }
    result.variantErrors = [...catalog.values()].filter((entry) => entry.error).length;
    await state.update({
      status: result.failed || result.review || result.variantErrors ? 'partial' : 'completed',
      result: structuredClone(result),
      finishedAt: new Date(),
      ...(!importFailed && complete ? { cursorAt: end } : {}),
    });
  } catch (error) {
    if (state)
      await state.update({
        status: 'failed',
        error: safeError(error),
        result: structuredClone(result),
        finishedAt: new Date(),
      });
  } finally {
    await release();
  }
}

export async function startSync(id, options) {
  const state = await WalmartSync.findByPk(id);
  assert(state?.enabled, '请先启用该店铺同步');
  if (running.has(Number(id))) throw new AppError(409, '该店铺正在同步，请稍后查看结果');
  assert(running.size < 2, '已有两个店铺正在同步，请稍后重试', 409);
  const task = executeSync(Number(id), options).catch(() =>
    console.error('Walmart 同步任务未完成，请检查同步记录'),
  );
  running.set(Number(id), task);
  void task.finally(() => running.delete(Number(id)));
  return { accepted: true };
}

/** 测试和优雅停机等待已启动任务，不会主动拉单。 */
export async function drainSyncTasks() {
  await Promise.allSettled([...running.values()]);
}

export function startWalmartScheduler() {
  let stopped = false;
  let ticking = false;
  let nextLaunchAt = 0;
  const tick = async () => {
    if (stopped || ticking || Date.now() < nextLaunchAt || running.size >= 2) return;
    ticking = true;
    try {
      const states = await WalmartSync.findAll({ where: { enabled: true } });
      const state = nextScheduledStore(states, Date.now(), (id) => running.has(id));
      if (!stopped && state) {
        // 20 店铺约每分钟启动一家；自动任务保持串行，手动同步仍可立即执行。
        await startSync(state.storeId, { scheduled: true });
        nextLaunchAt = Date.now() + storeSpacing(states.length);
        await running.get(state.storeId);
      }
    } catch {
      console.error('Walmart 定时同步检查失败，请检查数据库与同步迁移');
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), 30 * 1000);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await drainSyncTasks();
  };
}
