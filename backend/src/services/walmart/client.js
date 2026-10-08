import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, assert } from '../../errors.js';

const origin = 'https://marketplace.walmartapis.com';

/** 密钥和 access token 只在服务端使用，不进入任务结果或错误日志。 */
export class WalmartClient {
  constructor(store, { fetchImpl = fetch, sleep = delay } = {}) {
    assert(
      store.clientId?.trim() && store.clientSecret?.trim(),
      '请先配置 Client ID 和 Client Secret',
    );
    this.basic = Buffer.from(`${store.clientId.trim()}:${store.clientSecret.trim()}`).toString(
      'base64',
    );
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.token = null;
    this.expiresAt = 0;
  }

  async transport(path, { method = 'GET', token, body, authorization } = {}) {
    const url = new URL(path, origin);
    assert(url.origin === origin && url.pathname.startsWith('/v3/'), 'Walmart 接口地址无效');
    const correlationId = randomUUID();
    let response;
    try {
      response = await this.fetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(45000),
        headers: {
          Accept: 'application/json',
          'WM_SVC.NAME': 'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID': correlationId,
          ...(token ? { 'WM_SEC.ACCESS_TOKEN': token } : {}),
          ...(authorization
            ? { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        body,
      });
    } catch {
      throw new AppError(502, `Walmart 网络超时或连接失败（请求 ${correlationId}）`);
    }
    if (!response.ok) {
      const error = new AppError(
        502,
        `Walmart 接口 HTTP ${response.status}（请求 ${correlationId}）`,
      );
      error.apiStatus = response.status;
      const seconds = Number(response.headers.get('retry-after'));
      error.retryMs = Number.isFinite(seconds)
        ? Math.min(30000, Math.max(1000, seconds * 1000))
        : 1000;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(502, `Walmart 返回格式无效（请求 ${correlationId}）`);
    }
  }

  async getToken() {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    const data = await this.transport('/v3/token', {
      method: 'POST',
      authorization: `Basic ${this.basic}`,
      body: 'grant_type=client_credentials',
    });
    assert(
      typeof data.access_token === 'string' && data.access_token,
      'Walmart 未返回 access token',
      502,
    );
    this.token = data.access_token;
    this.expiresAt = Date.now() + Math.max(1, Number(data.expires_in || 900) - 60) * 1000;
    return this.token;
  }

  async request(path, method = 'GET') {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.getToken();
      try {
        return await this.transport(path, { method, token });
      } catch (error) {
        // 写接口结果不明时绝不直接重发；下次任务先 GET 检查远端状态。
        if (method !== 'GET' || attempt >= 2) throw error;
        if (error.apiStatus === 401) {
          this.token = null;
          continue;
        }
        if (!error.apiStatus || error.apiStatus === 429 || error.apiStatus >= 500) {
          await this.sleep(error.retryMs || (attempt + 1) * 1000);
          continue;
        }
        throw error;
      }
    }
  }

  async *orders(start, end) {
    for (const shipNodeType of ['SellerFulfilled', 'WFSFulfilled', '3PLFulfilled']) {
      const params = new URLSearchParams({
        createdStartDate: new Date(start).toISOString(),
        createdEndDate: new Date(end).toISOString(),
        limit: '200',
        productInfo: 'true',
        shipNodeType,
      });
      let path = `/v3/orders?${params}`;
      const visited = new Set();
      while (path) {
        assert(!visited.has(path) && visited.size < 1000, 'Walmart 分页异常，已停止同步', 502);
        visited.add(path);
        const body = await this.request(path);
        assert(Array.isArray(body.list?.elements?.order), 'Walmart 订单响应格式无效', 502);
        for (const order of body.list.elements.order) yield order;
        const cursor = body.list.meta?.nextCursor;
        assert(
          cursor || ![true, 'true'].includes(body.list.meta?.hasMoreElements),
          'Walmart 分页缺少游标',
          502,
        );
        if (!cursor) {
          path = null;
          continue;
        }
        const next = new URL(
          cursor.startsWith('?') ? `/v3/orders${cursor}` : cursor,
          `${origin}/v3/orders`,
        );
        assert(
          next.origin === origin && next.pathname === '/v3/orders',
          'Walmart 分页地址无效',
          502,
        );
        // 后续页继续约束日期和履约类型，避免游标遗漏参数引起跨范围读取。
        for (const [key, value] of params) next.searchParams.set(key, value);
        path = next.pathname + next.search;
      }
    }
  }

  async order(purchaseOrderId) {
    const body = await this.request(
      `/v3/orders/${encodeURIComponent(purchaseOrderId)}?productInfo=true`,
    );
    assert(body.order?.purchaseOrderId === purchaseOrderId, 'Walmart 订单号响应不一致', 502);
    return body.order;
  }

  async item(sku) {
    const body = await this.request(`/v3/items/${encodeURIComponent(sku)}?productIdType=SKU`);
    const item = body.ItemResponse?.find((entry) => entry.sku === sku);
    assert(item, 'Walmart 商品接口未返回匹配 SKU', 502);
    return item;
  }

  async acknowledge(purchaseOrderId) {
    const body = await this.request(
      `/v3/orders/${encodeURIComponent(purchaseOrderId)}/acknowledge`,
      'POST',
    );
    assert(
      body.order?.purchaseOrderId === purchaseOrderId,
      'Walmart 确认结果不完整，需要重新查询状态',
      502,
    );
    return body.order;
  }
}
