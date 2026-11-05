import { Op } from 'sequelize';
import { createHash } from 'node:crypto';
import { db, Order, OrderItem, Store } from '../../models.js';
import { assert } from '../../errors.js';
import { auditContext } from '../../lib/audit-context.js';
import { WalmartReturn } from './models.js';
import { WALMART_ORDER_START_MS, isOrderInRange } from './order-range.js';
import { amountUnits, amountText } from '../home/statistics.js';

export const RETURN_STATUSES = ['申请中', '退款处理中', '已退款', '已取消', '状态待核实'];
const origin = 'https://marketplace.walmartapis.com';
const DAY = 86400000;
const text = (value) => (value == null ? null : String(value).trim() || null);
const date = (value) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const identity = (value, label) => {
  const result = text(value);
  assert(result && result.length <= 191, `退货退款${label}缺失或无效`);
  return result;
};
export function returnStatus(line) {
  // 退款完成优先于退货状态，不能把退货完成当作已退款。
  if (line.currentRefundStatus === 'REFUND_COMPLETED') return '已退款';
  if (
    ['CANCELLED', 'CANCELED', 'REFUND_CANCELLED', 'REFUND_CANCELED'].includes(
      line.currentRefundStatus,
    ) ||
    ['CANCELLED', 'CANCELED'].includes(line.status)
  )
    return '已取消';
  if (['REFUND_INITIATED', 'REFUND_PENDING'].includes(line.currentRefundStatus))
    return '退款处理中';
  if (
    line.currentRefundStatus === 'NOT_REFUNDED' ||
    (!line.currentRefundStatus && ['INITIATED', 'DELIVERED', 'COMPLETED'].includes(line.status))
  )
    return '申请中';
  return '状态待核实';
}

/** 只保存关联与展示所需信息；不保留客户姓名、地址、邮件等原始响应。 */
export function compactReturn(record) {
  const returnOrderId = identity(record.returnOrderId, '单号');
  const customerOrderId = identity(record.customerOrderId, '客户订单号');
  assert(
    Array.isArray(record.returnOrderLines) && record.returnOrderLines.length,
    '退货退款缺少商品明细',
  );
  const seen = new Set();
  const lines = record.returnOrderLines.map((line) => {
    const lineNumber = identity(line.returnOrderLineNumber, '商品行号');
    assert(!seen.has(lineNumber), '退货退款商品行号重复');
    seen.add(lineNumber);
    const status = returnStatus(line);
    const totals = (line.chargeTotals || []).filter((entry) => entry.name === 'lineTotal');
    let amount = null,
      currency = totals[0]?.value?.currencyUnit || null;
    try {
      if (totals.length === 1 && currency === 'USD' && totals[0].value.currencyAmount != null)
        amount = amountText(amountUnits(totals[0].value.currencyAmount));
    } catch {
      /* 缺失或异常金额不阻止展示真实状态，不伪装为零。 */
    }
    const completed = (line.currentTrackingStatuses || [])
      .filter((entry) => entry.currentRefundStatus === 'REFUND_COMPLETED')
      .map((entry) => date(entry.statusTime))
      .filter(Boolean)
      .sort();
    return {
      lineNumber,
      sku: identity(line.item?.sku, 'SKU'),
      purchaseOrderId: identity(line.purchaseOrderId, 'PO'),
      status,
      refundStatus: text(line.currentRefundStatus),
      returnStatus: text(line.status),
      quantity: line.quantity?.measurementValue ?? null,
      refundedQuantity: line.refundedQty ?? null,
      amount,
      currency,
      completedAt: status === '已退款' ? completed.at(-1) || null : null,
      reason: text(line.returnReason),
    };
  });
  return { returnOrderId, customerOrderId, requestedAt: date(record.returnOrderDate), lines };
}

/** 修改时间增量查询，包含WFS；完整分页后才交给持久化，失败不推进游标。 */
export async function fetchReturnOrders(client, from, until, stillEnabled = async () => true) {
  const records = new Map();
  let pages = 0;
  for (let start = Number(from); start <= Number(until); start += 7 * DAY) {
    const params = new URLSearchParams({
      returnLastModifiedStartDate: new Date(start).toISOString(),
      returnLastModifiedEndDate: new Date(Math.min(start + 7 * DAY, Number(until))).toISOString(),
      limit: '50',
    });
    let path = `/v3/returns?${params}`,
      expected = null;
    const visited = new Set(),
      ids = new Set();
    while (path) {
      assert(await stillEnabled(), '退货退款同步已暂停');
      assert(!visited.has(path) && ++pages <= 100, '退货退款分页重复或超过100页，未推进同步进度');
      visited.add(path);
      const body = await client.request(path);
      assert(Array.isArray(body?.returnOrders), '退货退款接口响应格式无效');
      const count = body.meta?.totalCount;
      assert(
        count != null && /^\d+$/.test(String(count)) && Number.isSafeInteger(Number(count)),
        '退货退款接口缺少总条数',
      );
      expected ??= Number(count);
      assert(expected === Number(count), '退货退款分页期间数据变化，请重试');
      for (const raw of body.returnOrders) {
        const record = compactReturn(raw);
        assert(
          !records.has(record.returnOrderId) ||
            JSON.stringify(records.get(record.returnOrderId)) === JSON.stringify(record),
          '退货退款跨页记录发生变化，请重试',
        );
        records.set(record.returnOrderId, record);
        ids.add(record.returnOrderId);
      }
      const cursor = body.meta?.nextCursor;
      if (!cursor) {
        assert(ids.size === expected, '退货退款分页未完整获取');
        break;
      }
      const next = new URL(cursor.startsWith('?') ? `/v3/returns${cursor}` : cursor, origin);
      assert(next.origin === origin && next.pathname === '/v3/returns', '退货退款分页地址无效');
      for (const [key, value] of params) next.searchParams.set(key, value);
      path = next.pathname + next.search;
    }
    if (start + 7 * DAY >= Number(until)) break;
  }
  return [...records.values()];
}

/** 在现有店铺同步锁内执行；仅读取平台，不确认补拉订单或发起退款。 */
export async function syncOrderReturns({
  store,
  state,
  client,
  end,
  stillEnabled,
  saveOrder,
  reader = fetchReturnOrders,
}) {
  const credentialKey = createHash('sha256')
    .update(JSON.stringify([store.clientId, store.clientSecret]))
    .digest('hex');
  const sameCredentials = state.returnsCredentialKey === credentialKey;
  const from =
    sameCredentials && state.returnsCursorAt
      ? Math.max(WALMART_ORDER_START_MS, +state.returnsCursorAt - 2 * DAY)
      : WALMART_ORDER_START_MS;
  const records = await reader(client, new Date(from), end, stillEnabled);
  const result = {
    fetched: records.length,
    linked: 0,
    backfilled: 0,
    outsideRange: 0,
    pending: 0,
    errors: [],
  };
  const currentStore = await Store.findByPk(store.id);
  assert(
    currentStore &&
      currentStore.clientId === store.clientId &&
      currentStore.clientSecret === store.clientSecret &&
      currentStore.systemStoreName === store.systemStoreName,
    '店铺配置已变化，退货退款下轮重试',
  );
  assert(await stillEnabled(), '退货退款同步已暂停');
  if (!sameCredentials && state.returnsCredentialKey) {
    // 密钥改绑后旧店铺的退款快照不能继续当作当前接口数据。
    await OrderItem.update(
      { returnInfo: null },
      { where: { shopName: store.systemStoreName, returnInfo: { [Op.ne]: null } }, silent: true },
    );
  }
  for (const data of records) {
    await WalmartReturn.upsert({
      storeId: store.id,
      returnOrderId: data.returnOrderId,
      customerOrderId: data.customerOrderId,
      credentialKey,
      data,
      linked: false,
    });
  }
  const pending = await WalmartReturn.findAll({
    where: { storeId: store.id, credentialKey, linked: false },
    order: [['updatedAt', 'ASC']],
    limit: 100,
  });
  const customers = new Set([
    ...records.map((r) => r.customerOrderId),
    ...pending.map((r) => r.customerOrderId),
  ]);
  let backfillCount = 0;
  const fetchedOrders = new Map();
  const outsideRange = new Set();
  for (const customerOrderId of customers) {
    assert(await stillEnabled(), '退货退款同步已暂停');
    try {
      const returns = await WalmartReturn.findAll({
        where: { storeId: store.id, customerOrderId, credentialKey },
      });
      const findItems = async (transaction) => {
        const order = await Order.findOne({ where: { orderNumber: customerOrderId }, transaction });
        return order
          ? OrderItem.findAll({
              where: { orderId: order.id, shopName: store.systemStoreName },
              transaction,
              ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
              order: [['id', 'ASC']],
            })
          : [];
      };
      let items = await findItems();
      for (const entry of returns.flatMap((r) => r.data.lines)) {
        if (items.some((item) => item.walmartSku === entry.sku)) continue;
        if (!fetchedOrders.has(entry.purchaseOrderId)) {
          assert(++backfillCount <= 50, '本轮补拉已达50单，未关联记录下轮继续');
          const order = await client.order(entry.purchaseOrderId);
          assert(
            order.customerOrderId === customerOrderId &&
              order.purchaseOrderId === entry.purchaseOrderId,
            '退货退款与原订单号不一致，已跳过',
          );
          fetchedOrders.set(entry.purchaseOrderId, order);
          if (!isOrderInRange(order, +end)) outsideRange.add(entry.purchaseOrderId);
          else {
            await saveOrder(order);
            result.backfilled++;
          }
        }
      }
      await auditContext.run(undefined, () =>
        db.transaction(async (transaction) => {
          items = await findItems(transaction);
          const bySku = new Map();
          for (const item of items)
            bySku.set(item.walmartSku, [...(bySku.get(item.walmartSku) || []), item]);
          const details = new Map();
          for (const record of returns) {
            let linked = true;
            for (const line of record.data.lines) {
              if (outsideRange.has(line.purchaseOrderId)) {
                result.outsideRange++;
                continue;
              }
              const candidates = bySku.get(line.sku) || [];
              const target = candidates.length === 1 ? candidates[0] : null;
              if (
                !target ||
                (target.walmart?.purchaseOrderId &&
                  target.walmart.purchaseOrderId !== line.purchaseOrderId)
              ) {
                linked = false;
                if (result.errors.length < 20)
                  result.errors.push({
                    customerOrderId,
                    message: `SKU ${line.sku} 未唯一匹配原订单或PO不一致，已保留记录等待重试`,
                  });
                continue;
              }
              details.set(target.id, [
                ...(details.get(target.id) || []),
                {
                  ...line,
                  returnOrderId: record.returnOrderId,
                  requestedAt: record.data.requestedAt,
                },
              ]);
            }
            await record.update({ linked }, { transaction });
            if (!linked) result.pending++;
          }
          for (const item of items) {
            const lines = details.get(item.id) || [];
            if (!lines.length && !item.returnInfo) continue;
            lines.sort(
              (a, b) =>
                (b.requestedAt || '').localeCompare(a.requestedAt || '') ||
                a.returnOrderId.localeCompare(b.returnOrderId) ||
                a.lineNumber.localeCompare(b.lineNumber),
            );
            // 单独JSON字段，不被普通订单同步覆盖，不改变人工采购版本或字段。
            await item.update(
              {
                returnInfo: lines.length
                  ? {
                      statuses: [...new Set(lines.map((line) => line.status))],
                      lines,
                      fetchedAt: end.toISOString(),
                    }
                  : null,
              },
              { transaction, silent: true },
            );
            if (lines.length) result.linked++;
          }
        }),
      );
    } catch (error) {
      result.pending++;
      if (result.errors.length < 20)
        result.errors.push({ customerOrderId, message: String(error.message).slice(0, 300) });
    }
  }
  // 未关联记录已持久化，后续轮次重试；接口失败则不会到这里。
  await state.update({ returnsCursorAt: end, returnsCredentialKey: credentialKey });
  return result;
}
