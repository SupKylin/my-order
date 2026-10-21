import { WalmartClient } from '../walmart/client.js';

export const REMOTE_METRICS = {
  publishedSku: '/v3/items/count?status=PUBLISHED',
  settlement: '/v3/report/payment/statement',
  otd: '/v3/insights/performance/otd/summary?reportDuration=30&shippingMethod=ALL_METHODS',
  vtr: '/v3/insights/performance/vtr/summary?reportDuration=30&shippingMethod=ALL_METHODS',
  cancellations: '/v3/insights/performance/cancellations/summary?reportDuration=30',
  srr: '/v3/insights/performance/srr/summary?reportDuration=30',
  negativeFeedback: '/v3/insights/performance/negativeFeedback/summary?reportDuration=60',
  returns: '/v3/insights/performance/returns/summary?reportDuration=60&conditionType=ALL',
  itemNotReceived: '/v3/insights/performance/itemNotReceived/summary?reportDuration=60',
  lateShipment:
    '/v3/insights/performance/lateShipment/summary?reportDuration=30&shippingMethod=ALL_METHODS',
};

function sellerAccountableRate(payload) {
  if (payload?.sellerAccountableRate != null) return payload.sellerAccountableRate;
  if (payload?.cumulativeRate != null && payload?.overallRate == null)
    return payload.cumulativeRate;
  return null;
}

function percentage(key, value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
  const number = Number(value);
  // lateShipment 文档以 0.0215 表示 2.15%；不能按数值大小猜单位，0.8% 仍是 0.8%。
  const percent = key === 'lateShipment' ? number * 100 : number;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Number(percent.toFixed(6));
}

/** 严格校验响应，空值及权限错误不能当作零；只保存白名单指标，不保存完整付款响应。 */
export function parseRemoteMetric(key, body) {
  if (!body || typeof body !== 'object') throw new Error('Walmart 暂无该项报表数据');
  if (body.status && body.status !== 'OK') throw new Error('Walmart 报表尚不可用');
  if (key === 'publishedSku') {
    const count = body.PUBLISHED;
    if (count == null || count === '' || !Number.isSafeInteger(Number(count)) || Number(count) < 0)
      throw new Error('Walmart 未返回有效的已发布 SKU 数量');
    return { value: Number(count) };
  }
  if (key === 'settlement') {
    const summary = body.payload?.accountSummary;
    if (summary?.closingBalance == null || !/^-?\d+(\.\d+)?$/.test(String(summary.closingBalance)))
      throw new Error('Walmart 未返回待结算金额');
    return {
      value: String(summary.closingBalance),
      reportUpdatedAt: summary.lastUpdatedDate || null,
      scheduledSettlementDate: summary.scheduledSettlementDate || null,
    };
  }
  const payload = body.payload;
  const rate = percentage(key, sellerAccountableRate(payload));
  if (rate == null) throw new Error('Walmart 暂无可区分的卖家责任口径数据');
  return {
    value: rate,
    sellerAccountableRate: rate,
    reportUpdatedAt: payload.updatedTimestamp || null,
    standard: payload.performanceStandard || payload.standard || null,
    risk: payload.performanceRiskLevel || payload.riskLevel || null,
  };
}

export async function fetchRemoteMetrics(
  store,
  previous = {},
  { client = new WalmartClient(store), now = new Date(), retryOnly = false } = {},
) {
  const result = {};
  // 同一店铺串行复用 token；外层限制同时更新的店铺数量，避免突发请求。
  for (const [key, path] of Object.entries(REMOTE_METRICS)) {
    if (retryOnly && previous[key]?.status === 'ok') {
      result[key] = previous[key];
      continue;
    }
    try {
      result[key] = {
        ...parseRemoteMetric(key, await client.request(path)),
        status: 'ok',
        fetchedAt: now.toISOString(),
      };
    } catch (error) {
      result[key] = {
        ...previous[key],
        status: 'error',
        attemptedAt: now.toISOString(),
        error:
          error.apiStatus === 401 || error.apiStatus === 403
            ? '接口未授权，请检查店铺 API 权限'
            : String(error.message).slice(0, 300),
      };
    }
  }
  return result;
}
