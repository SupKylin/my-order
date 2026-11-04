import { amountText, amountUnits, pstDay } from './statistics.js';

export const RETURNS_VERSION = 2;
const DAY = 86400000;
const origin = 'https://marketplace.walmartapis.com';
function requireData(condition, message) {
  if (!condition) throw new Error(message);
}
function money(value) {
  requireData(value?.currencyUnit === 'USD', '退款金额缺失或币种不是 USD');
  requireData(value.currencyAmount != null, '退款金额缺失');
  return amountUnits(value.currencyAmount);
}
function timestamp(value) {
  requireData(
    typeof value === 'string' &&
      /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    '退款完成时间缺失或格式无效',
  );
  return Date.parse(value);
}
export function refundMonth(now = Date.now()) {
  const periodStart = pstDay(now).slice(0, 7) + '-01';
  return {
    periodStart,
    periodEnd: pstDay(now),
    start: Date.parse(`${periodStart}T00:00:00-08:00`),
  };
}

/** 不按客户订单号合并：一个订单可以有多个退货单，金额只在对应完成明细上累计。 */
export function calculateReturns(records, now = Date.now()) {
  const { start } = refundMonth(now);
  let total = 0n,
    completedLines = 0,
    unverifiedLines = 0;
  const reasons = new Set();
  for (const record of records) {
    const lines = record.returnOrderLines;
    if (!Array.isArray(lines) || !lines.length) {
      unverifiedLines++;
      reasons.add('退货单缺少明细');
      continue;
    }
    const seen = new Set();
    for (const line of lines) {
      try {
        requireData(
          line.returnOrderLineNumber != null && !seen.has(String(line.returnOrderLineNumber)),
          '退货明细编号缺失或重复',
        );
        seen.add(String(line.returnOrderLineNumber));
        if (line.currentRefundStatus !== 'REFUND_COMPLETED') {
          // refundedQty/退货COMPLETED不能证明退款完成：实际响应可在发起/取消时仍大于0。
          requireData(
            [
              'NOT_REFUNDED',
              'REFUND_INITIATED',
              'REFUND_PENDING',
              'CANCELLED',
              'REFUND_CANCELLED',
              'REFUND_CANCELED',
            ].includes(line.currentRefundStatus),
            '退款状态未知，不能确认为未退款',
          );
          continue;
        }
        const statuses = line.currentTrackingStatuses || [];
        requireData(Array.isArray(statuses), '退款状态历史格式无效');
        const events = new Map();
        for (const state of statuses.filter((s) => s.currentRefundStatus === 'REFUND_COMPLETED')) {
          const time = timestamp(state.statusTime);
          const qty = Number(state.quantity?.measurementValue);
          const key = `${time}:${qty}`;
          events.set(key, { time, qty });
        }
        requireData(events.size > 0, '缺少退款完成事件，不能用退货创建日期替代');
        requireData(
          [...events.values()].every((e) => e.time <= Number(now)),
          '退款完成时间超出本次采集截止时间，请重试',
        );
        const inMonth = [...events.values()].filter(
          (e) => e.time >= start && e.time <= Number(now),
        );
        if (!inMonth.length) continue;
        // 接口行金额只累计一次；跨月分次完成缺少本月独立金额，跳过并说明。
        requireData(inMonth.length === events.size, '跨月分次退款缺少本月独立金额');
        const totals = (line.chargeTotals || []).filter((t) => t.name === 'lineTotal');
        requireData(totals.length === 1, '退款明细缺少唯一含税总额');
        total += money(totals[0].value);
        completedLines++;
      } catch (error) {
        unverifiedLines++;
        reasons.add(error.message);
      }
    }
  }
  return {
    ...(completedLines || !unverifiedLines ? { value: amountText(total) } : {}),
    status: unverifiedLines ? 'partial' : 'ok',
    statusText: unverifiedLines ? `已跳过 ${unverifiedLines} 条退款记录` : undefined,
    error: unverifiedLines
      ? `${unverifiedLines} 条记录未计入，其余有效退款正常汇总：${[...reasons].join('；')}`
      : undefined,
    completedLines,
    unverifiedLines,
  };
}

/** 每日批量查询本月修改过的退货单，分7天窗口，包含旧订单/旧退货本月退款。 */
export async function fetchMonthlyReturns(client, previous, now = new Date()) {
  const range = refundMonth(now);
  const base = {
    version: RETURNS_VERSION,
    source: 'returns',
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    attemptedAt: now.toISOString(),
  };
  try {
    const records = new Map();
    let pages = 0;
    for (let start = range.start; start <= Number(now); start += 7 * DAY) {
      const params = new URLSearchParams({
        returnLastModifiedStartDate: new Date(start).toISOString(),
        returnLastModifiedEndDate: new Date(Math.min(start + 7 * DAY, Number(now))).toISOString(),
        limit: '50',
      });
      let path = `/v3/returns?${params}`,
        expected = null;
      const visited = new Set(),
        windowIds = new Set();
      while (path) {
        requireData(!visited.has(path) && ++pages <= 100, '退款分页重复或超出安全上限');
        visited.add(path);
        const body = await client.request(path);
        requireData(Array.isArray(body?.returnOrders), '退款列表响应格式无效');
        const count = body.meta?.totalCount;
        requireData(
          count != null && /^\d+$/.test(String(count)) && Number.isSafeInteger(Number(count)),
          '退款列表缺少有效总条数',
        );
        if (expected == null) expected = Number(count);
        requireData(expected === Number(count), '退款列表在分页期间发生变化，请重试');
        for (const row of body.returnOrders) {
          requireData(
            row.returnOrderId != null && String(row.returnOrderId).trim(),
            '退款记录缺少退货单号',
          );
          const id = String(row.returnOrderId);
          // 仅保留计算所需字段，不缓存姓名、地址或整个响应。
          const compact = {
            returnOrderId: id,
            totalRefundAmount: row.totalRefundAmount,
            returnOrderLines: row.returnOrderLines?.map((l) => ({
              returnOrderLineNumber: l.returnOrderLineNumber,
              quantity: l.quantity,
              refundedQty: l.refundedQty,
              currentRefundStatus: l.currentRefundStatus,
              currentTrackingStatuses: l.currentTrackingStatuses,
              chargeTotals: l.chargeTotals,
            })),
          };
          requireData(
            !records.has(id) || JSON.stringify(records.get(id)) === JSON.stringify(compact),
            '同一退款记录在查询期间发生变化，请重试',
          );
          records.set(id, compact);
          windowIds.add(id);
        }
        const cursor = body.meta?.nextCursor;
        if (!cursor) {
          requireData(windowIds.size === expected, '退款分页未完整获取');
          break;
        }
        const next = new URL(cursor.startsWith('?') ? `/v3/returns${cursor}` : cursor, origin);
        requireData(next.origin === origin && next.pathname === '/v3/returns', '退款分页地址无效');
        for (const [key, value] of params) next.searchParams.set(key, value);
        path = next.pathname + next.search;
      }
    }
    return {
      ...base,
      ...calculateReturns([...records.values()], now),
      fetchedAt: now.toISOString(),
      asOf: now.toISOString(),
      recordCount: records.size,
    };
  } catch (error) {
    const historical =
      previous?.version === RETURNS_VERSION &&
      previous?.periodStart === range.periodStart &&
      previous?.value != null;
    return {
      ...base,
      ...(historical
        ? { value: previous.value, fetchedAt: previous.fetchedAt, asOf: previous.asOf }
        : {}),
      status: 'error',
      statusText: historical ? '历史金额 · 更新失败' : '接口请求失败',
      error:
        error.apiStatus === 401 || error.apiStatus === 403
          ? '退货退款接口未授权，请检查店铺 API 权限'
          : String(error.message).slice(0, 300),
    };
  }
}

export function monthlyReturnsMetric(cache, now = Date.now()) {
  const range = refundMonth(now);
  if (cache?.version !== RETURNS_VERSION || cache.periodStart !== range.periodStart)
    return {
      source: 'returns',
      periodStart: range.periodStart,
      periodEnd: range.periodEnd,
      status: 'pending',
      statusText: '等待同步当月退款',
      error: '以退货退款接口的完成记录为准，尚未取得本月数据',
    };
  const { value, status, statusText, error, fetchedAt, asOf } = cache;
  return {
    source: 'returns',
    periodStart: range.periodStart,
    periodEnd: range.periodEnd,
    value,
    status,
    statusText,
    error,
    fetchedAt,
    asOf,
  };
}
