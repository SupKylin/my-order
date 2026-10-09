import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { db, User, Store, OrderItem, Purchase, Order } from '../src/models.js';
import { WalmartSync, WalmartReceipt } from '../src/services/walmart/models.js';
import {
  configureSync,
  startSync,
  drainSyncTasks,
  previewOrders,
} from '../src/services/walmart/sync.js';
import { persistOrder } from '../src/services/walmart/persistence.js';
import { migrateWalmart } from '../src/migrations/walmart.js';
import { orderIdentityKey, channelKey } from '../src/lib/order-identity.js';
import { CATALOG_TTL_MS } from '../src/services/walmart/catalog-cache.js';
import { WALMART_ORDER_START_MS } from '../src/services/walmart/order-range.js';

// 必须显式指定一次性测试数据库，绝不在用户订单库执行清理。
const isolated = /^my_order_walmart_test_[0-9]+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let databaseCreated = false;
let adminConnection, actor, store, start, remote;
let postCount = 0;
const catalog = new Map([
  [
    'SKU-A',
    {
      item: {
        sku: 'SKU-A',
        variantGroupInfo: { groupingAttributes: [{ name: 'actual_color', value: 'Red' }] },
      },
    },
  ],
]);
function sample(status = 'Created', po = 'TEST-PO', customer = 'TEST-ORDER') {
  return {
    purchaseOrderId: po,
    customerOrderId: customer,
    orderDate: start + 1,
    shipNode: { type: 'SellerFulfilled' },
    shippingInfo: { estimatedShipDate: start + 86400000 },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'SKU-A', productName: '测试商品' },
          orderLineQuantity: { amount: '1' },
          orderLineStatuses: { orderLineStatus: [{ status }] },
        },
      ],
    },
  };
}
const client = {
  async *orders() {
    yield remote;
    yield { ...sample('Created', 'OLD-PO', 'OLD-ORDER'), orderDate: start - 86400000 };
  },
  async order(po) {
    assert.equal(po, remote.purchaseOrderId);
    return structuredClone(remote);
  },
  async item(sku) {
    return catalog.get(sku).item;
  },
  async acknowledge(po) {
    // 此连接之外能看到已保存数据，证明确认发生在事务提交之后。
    const [rows] = await adminConnection.query(
      `SELECT COUNT(*) AS count FROM ${mysql.escapeId(config.db.database)}.order_items WHERE walmartSourceKey IS NOT NULL`,
    );
    assert.ok(rows[0].count >= 1);
    postCount++;
    remote = sample('Acknowledged', po);
    return structuredClone(remote);
  },
};

before(async () => {
  if (!isolated) return;
  adminConnection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
  });
  await adminConnection.query(
    `CREATE DATABASE ${mysql.escapeId(config.db.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  databaseCreated = true;
  await db.sync();
  // 模拟旧版本同步表，迁移应新增列且允许幂等重跑。
  await db.getQueryInterface().removeColumn('walmart_sync_states', 'lastReconciledAt');
  await migrateWalmart();
  await migrateWalmart();
  actor = await User.create({
    username: 'test-actor',
    displayName: '测试',
    passwordHash: 'not-a-login-password',
    role: 'admin',
  });
  store = await Store.create({
    walmartStoreName: '测试平台',
    systemStoreName: '测试店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  const state = await configureSync(store.id, true, actor);
  start = new Date(state.startedAt).getTime();
  assert.equal(start, WALMART_ORDER_START_MS);
  remote = sample();
});
after(async () => {
  await drainSyncTasks();
  await db.close();
  if (adminConnection) {
    if (databaseCreated)
      await adminConnection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
    await adminConnection.end();
  }
});

test('旧店铺自动回溯 10 月 1 日，仅符合时间范围的订单可以落库', async () => {
  const rangeStore = await Store.create({
    walmartStoreName: '范围平台',
    systemStoreName: '范围店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(rangeStore.id, true, actor);
  await WalmartSync.update(
    { startedAt: new Date('2026-10-07T08:00:00Z'), cursorAt: new Date() },
    { where: { storeId: rangeStore.id } },
  );
  const queries = [];
  const allowed = {
    ...sample('Acknowledged', 'RANGE-PO', 'RANGE-ORDER'),
    orderDate: WALMART_ORDER_START_MS,
  };
  const rangeClient = {
    async *orders(from, to) {
      queries.push([from.getTime(), to.getTime()]);
      yield {
        ...allowed,
        purchaseOrderId: 'RANGE-OLD',
        customerOrderId: 'RANGE-OLD',
        orderDate: WALMART_ORDER_START_MS - 1,
      };
      yield allowed;
    },
    async order() {
      return structuredClone(allowed);
    },
    async item() {
      return catalog.get('SKU-A').item;
    },
    async acknowledge() {
      assert.fail('不应确认已确认订单');
    },
  };
  await startSync(rangeStore.id, { clientFactory: () => rangeClient });
  await drainSyncTasks();
  assert.equal(queries[0][0], WALMART_ORDER_START_MS);
  assert.ok(queries.at(-1)[1] <= Date.now());
  const state = await WalmartSync.findByPk(rangeStore.id);
  assert.equal(state.status, 'completed');
  assert.equal(state.startedAt.getTime(), WALMART_ORDER_START_MS);
  assert.equal(await OrderItem.count({ where: { shopName: rangeStore.systemStoreName } }), 1);
  assert.equal(await WalmartReceipt.count({ where: { purchaseOrderId: 'RANGE-OLD' } }), 0);
  // 清理该隔离用例的数据，后续既有测试使用整库数量断言。
  const items = await OrderItem.findAll({ where: { shopName: rangeStore.systemStoreName } });
  for (const item of items) {
    await Purchase.destroy({ where: { itemId: item.id } });
    await item.destroy();
  }
  await WalmartReceipt.destroy({ where: { storeId: rangeStore.id } });
});

test('只读预览完全不落库、不确认', async () => {
  const preview = await previewOrders(
    store.id,
    { start: new Date(start - 10).toISOString(), end: new Date(start + 100).toISOString() },
    { clientFactory: () => client },
  );
  assert.equal(preview.orders.length, 1);
  assert.equal(await OrderItem.count(), 0);
  assert.equal(await WalmartReceipt.count(), 0);
  assert.equal(postCount, 0);
});

test('正式任务只保存接收起点后订单、提交后确认；重跑不新增、不覆盖采购', async () => {
  await startSync(store.id, { clientFactory: () => client });
  await drainSyncTasks();
  let state = await WalmartSync.findByPk(store.id);
  assert.equal(state.status, 'completed', JSON.stringify(state.toJSON()));
  assert.equal(await OrderItem.count(), 1);
  assert.equal(postCount, 1);
  const item = await OrderItem.findOne();
  assert.deepEqual(item.walmart.attributes, [{ name: 'actual_color', value: 'Red' }]);
  assert.deepEqual(item.walmart.statuses, ['Acknowledged']);
  assert.equal(item.platformOrderStatus, '已确认');
  assert.equal(item.productSpecification, 'Red');
  const purchase = await Purchase.findOne({ where: { itemId: item.id } });
  await purchase.update({
    purchaseNote: '原采购备注',
    purchaseChannel: ['渠道A'],
    purchaseAmount: '10+2',
    assignedTo: actor.id,
  });
  await item.update({ orderStatus: '自定义内部状态' });
  await startSync(store.id, { clientFactory: () => client });
  await drainSyncTasks();
  assert.equal(await OrderItem.count(), 1);
  assert.equal(postCount, 1);
  await purchase.reload();
  await item.reload();
  assert.equal(purchase.purchaseNote, '原采购备注');
  assert.equal(purchase.purchaseAmount, '10+2');
  assert.deepEqual(purchase.purchaseChannel, ['渠道A']);
  assert.equal(item.orderStatus, '自定义内部状态');
});

test('历史明细参与三字段查重；不同商品行号但同 SKU 覆盖原行', async () => {
  const [parent] = await Order.findOrCreate({ where: { orderNumber: 'HISTORY-ORDER' } });
  const fields = { shopName: store.systemStoreName, walmartSku: 'SKU-A' };
  const existing = await OrderItem.create({
    orderId: parent.id,
    ...fields,
    orderIdentityKey: orderIdentityKey(fields),
    purchaseChannelKey: channelKey(null),
  });
  await Purchase.create({ itemId: existing.id, purchaseNote: '历史采购' });
  const raw = sample('Acknowledged', 'HISTORY-PO', 'HISTORY-ORDER');
  raw.orderLines.orderLine.push({
    ...structuredClone(raw.orderLines.orderLine[0]),
    lineNumber: '2',
    orderLineQuantity: { amount: '3' },
  });
  const result = await persistOrder(store, raw, catalog, actor);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(await OrderItem.count({ where: { orderId: parent.id } }), 1);
  await persistOrder(store, raw, catalog, actor);
  assert.equal(await OrderItem.count({ where: { orderId: parent.id } }), 1);
  await existing.reload();
  assert.equal(existing.quantity, 3);
  assert.equal(existing.platformOrderStatus, '已确认');
  assert.equal(
    (await Purchase.findOne({ where: { itemId: existing.id } })).purchaseNote,
    '历史采购',
  );
});

test('店铺、客户订单号、SKU 中任一不同新增；PO 变化时更新同一行', async () => {
  const raw = sample('Acknowledged', 'DEDUP-PO', 'DEDUP-ORDER');
  const first = await persistOrder(store, raw, catalog, actor);
  assert.equal(first.added, 1);
  const parent = await Order.findOne({ where: { orderNumber: 'DEDUP-ORDER' } });
  const original = await OrderItem.findOne({ where: { orderId: parent.id } });
  raw.purchaseOrderId = 'DEDUP-PO-NEW';
  raw.orderLines.orderLine[0].lineNumber = '7';
  raw.orderLines.orderLine[0].item.productName = '更新后的商品';
  raw.orderLines.orderLine[0].orderLineStatuses.orderLineStatus = [{ status: 'Shipped' }];
  const updated = await persistOrder(store, raw, catalog, actor);
  assert.equal(updated.added, 0);
  assert.equal(updated.updated, 1);
  await original.reload();
  assert.equal(original.productName, '更新后的商品');
  assert.equal(original.platformOrderStatus, '已发货');
  raw.orderLines.orderLine[0].item.sku = 'SKU-B';
  assert.equal((await persistOrder(store, raw, catalog, actor)).added, 1);
  const otherStore = await Store.create({
    walmartStoreName: '第二个平台',
    systemStoreName: '第二个店铺',
  });
  assert.equal((await persistOrder(otherStore, raw, catalog, actor)).added, 1);
  raw.customerOrderId = 'OTHER-CUSTOMER';
  raw.purchaseOrderId = 'OTHER-PO';
  assert.equal((await persistOrder(store, raw, catalog, actor)).added, 1);
});

test('规格按接口覆盖，查询失败保留原值，接口无属性时清空；长规格可保存', async () => {
  const raw = sample('Acknowledged', 'SPEC-PO', 'SPEC-ORDER');
  const values = [
    { name: 'actual_color', value: 'Brick red' },
    { name: 'pattern', value: 'Card Bag' },
  ];
  const data = new Map([['SKU-A', { item: { variantGroupInfo: { groupingAttributes: values } } }]]);
  await persistOrder(store, raw, data, actor);
  const parent = await Order.findOne({ where: { orderNumber: 'SPEC-ORDER' } });
  const row = await OrderItem.findOne({ where: { orderId: parent.id } });
  assert.equal(row.productSpecification, 'Brick red, Card Bag');
  await persistOrder(store, raw, new Map([['SKU-A', { error: 'timeout' }]]), actor);
  await row.reload();
  assert.equal(row.productSpecification, 'Brick red, Card Bag');
  assert.deepEqual(row.walmart.attributes, values);
  await persistOrder(store, raw, new Map([['SKU-A', { item: {} }]]), actor);
  await row.reload();
  assert.equal(row.productSpecification, null);
  const longValue = 'A'.repeat(300);
  await persistOrder(
    store,
    raw,
    new Map([
      [
        'SKU-A',
        {
          item: { variantGroupInfo: { groupingAttributes: [{ name: 'long', value: longValue }] } },
        },
      ],
    ]),
    actor,
  );
  await row.reload();
  assert.equal(row.productSpecification, longValue);
});

test('已存在重复历史明细不再新增，旧 sourceKey 不参与匹配', async () => {
  const [parent] = await Order.findOrCreate({ where: { orderNumber: 'EXISTING-DUP' } });
  const patch = { shopName: store.systemStoreName, walmartSku: 'SKU-A' };
  const rows = [];
  for (const source of ['legacy-line-one', 'legacy-line-two']) {
    const item = await OrderItem.create({
      orderId: parent.id,
      ...patch,
      orderIdentityKey: orderIdentityKey(patch),
      purchaseChannelKey: channelKey(null),
      walmartSourceKey: source,
    });
    await Purchase.create({ itemId: item.id, purchaseNote: source });
    rows.push(item);
  }
  const result = await persistOrder(
    store,
    sample('Acknowledged', 'EXISTING-PO', 'EXISTING-DUP'),
    catalog,
    actor,
  );
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(await OrderItem.count({ where: { orderId: parent.id } }), 2);
  await rows[0].reload();
  assert.equal(rows[0].platformOrderStatus, '已确认');
});

test('商品行校验失败整单回滚，不创建确认任务', async () => {
  const before = await OrderItem.count();
  const invalid = sample('Created', 'BAD-PO', 'BAD-ORDER');
  invalid.orderLines.orderLine.push({
    ...structuredClone(invalid.orderLines.orderLine[0]),
    lineNumber: '2',
    orderLineQuantity: { amount: '-1' },
  });
  await assert.rejects(persistOrder(store, invalid, catalog, actor));
  assert.equal(await OrderItem.count(), before);
  assert.equal(await WalmartReceipt.count({ where: { purchaseOrderId: 'BAD-PO' } }), 0);
});

test('暂停不发起任务，重新启用保留原起点', async () => {
  const old = await WalmartSync.findByPk(store.id);
  await configureSync(store.id, false, actor);
  await assert.rejects(startSync(store.id, { clientFactory: () => client }), /先启用/);
  const resumed = await configureSync(store.id, true, actor);
  assert.equal(new Date(resumed.startedAt).getTime(), old.startedAt.getTime());
});

test('多订单任务的 JSON 进度完整保存，不停留在第一条', async () => {
  const progressStore = await Store.create({
    walmartStoreName: '进度平台',
    systemStoreName: '进度店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(progressStore.id, true, actor);
  await WalmartSync.update(
    { startedAt: new Date(start) },
    { where: { storeId: progressStore.id } },
  );
  const orders = [
    sample('Acknowledged', 'PROGRESS-PO-1', 'PROGRESS-1'),
    sample('Acknowledged', 'PROGRESS-PO-2', 'PROGRESS-2'),
  ];
  const progressClient = {
    async *orders() {
      yield* orders;
    },
    async order(po) {
      return structuredClone(orders.find((order) => order.purchaseOrderId === po));
    },
    async item(sku) {
      return catalog.get(sku).item;
    },
    async acknowledge() {
      assert.fail('已确认订单不应调用确认接口');
    },
  };
  await startSync(progressStore.id, { clientFactory: () => progressClient });
  await drainSyncTasks();
  const state = await WalmartSync.findByPk(progressStore.id);
  assert.equal(state.status, 'completed');
  assert.equal(state.result.orders, 2);
  assert.equal(state.result.added, 2);
  assert.equal(state.result.skipped, 2);
});

test('跨轮复用落库规格，过期刷新；自动任务重查间隔，手动同步不受间隔限制', async () => {
  const cacheStore = await Store.create({
    walmartStoreName: '缓存平台',
    systemStoreName: '缓存店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(cacheStore.id, true, actor);
  await WalmartSync.update({ startedAt: new Date(start) }, { where: { storeId: cacheStore.id } });
  let itemCalls = 0,
    orderCalls = 0;
  const raw = sample('Acknowledged', 'CACHE-PO', 'CACHE-ORDER');
  const cacheClient = {
    async *orders() {
      orderCalls++;
      yield raw;
    },
    async order() {
      return structuredClone(raw);
    },
    async item() {
      itemCalls++;
      return catalog.get('SKU-A').item;
    },
    async acknowledge() {
      assert.fail('已确认不应确认');
    },
  };
  const options = { clientFactory: () => cacheClient };
  await startSync(cacheStore.id, options);
  await drainSyncTasks();
  assert.equal(itemCalls, 1);
  const firstOrderCalls = orderCalls;
  await startSync(cacheStore.id, options);
  await drainSyncTasks();
  assert.equal(itemCalls, 1);
  assert.equal(orderCalls, firstOrderCalls + 1);
  await startSync(cacheStore.id, { ...options, scheduled: true });
  await drainSyncTasks();
  assert.equal(orderCalls, firstOrderCalls + 1);
  const item = await OrderItem.findOne({ where: { shopName: cacheStore.systemStoreName } });
  await item.update({
    walmart: {
      ...item.walmart,
      variantFetchedAt: new Date(Date.now() - CATALOG_TTL_MS - 1).toISOString(),
    },
  });
  await startSync(cacheStore.id, options);
  await drainSyncTasks();
  assert.equal(itemCalls, 2);
  assert.equal((await WalmartSync.findByPk(cacheStore.id)).status, 'completed');
});

test('订单延迟两小时才返回仍被回查补入；重复回查不新增且保留采购信息', async () => {
  const delayedStore = await Store.create({
    walmartStoreName: '延迟平台',
    systemStoreName: '延迟店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(delayedStore.id, true, actor);
  await WalmartSync.update(
    { cursorAt: new Date(), lastReconciledAt: new Date() },
    { where: { storeId: delayedStore.id } },
  );
  const raw = {
    ...sample('Acknowledged', 'DELAY-PO', 'DELAY-ORDER'),
    orderDate: Date.now() - 2 * 3600000,
  };
  let visible = false;
  const queries = [];
  const delayedClient = {
    async *orders(from, to) {
      queries.push([from, to]);
      if (visible && raw.orderDate >= from.getTime() && raw.orderDate <= to.getTime())
        yield structuredClone(raw);
    },
    async order() {
      return structuredClone(raw);
    },
    async item() {
      return catalog.get('SKU-A').item;
    },
    async acknowledge() {
      assert.fail('已确认不能重复确认');
    },
  };
  const options = { clientFactory: () => delayedClient };
  await startSync(delayedStore.id, options);
  await drainSyncTasks();
  assert.equal(await OrderItem.count({ where: { shopName: delayedStore.systemStoreName } }), 0);
  const cursor = (await WalmartSync.findByPk(delayedStore.id)).cursorAt;
  assert.ok(raw.orderDate < cursor.getTime() - 5 * 60000, '旧逻辑会漏掉此订单');
  visible = true;
  await startSync(delayedStore.id, options);
  await drainSyncTasks();
  assert.ok(queries.at(-1)[0].getTime() <= raw.orderDate);
  const item = await OrderItem.findOne({ where: { shopName: delayedStore.systemStoreName } });
  assert.ok(item);
  const purchase = await Purchase.findOne({ where: { itemId: item.id } });
  await purchase.update({
    purchaseNote: '人工采购备注',
    purchaseAmount: '12+3',
    purchaseChannel: ['渠道A'],
  });
  await startSync(delayedStore.id, options);
  await drainSyncTasks();
  assert.equal(await OrderItem.count({ where: { shopName: delayedStore.systemStoreName } }), 1);
  await purchase.reload();
  assert.equal(purchase.purchaseNote, '人工采购备注');
  assert.equal(purchase.purchaseAmount, '12+3');
  assert.deepEqual(purchase.purchaseChannel, ['渠道A']);
});

test('每日核对补入五天前漏单；分页失败不推进游标和核对时间，重试恢复后推进', async () => {
  const dailyStore = await Store.create({
    walmartStoreName: '核对平台',
    systemStoreName: '核对店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(dailyStore.id, true, actor);
  const cursor = new Date(Date.now() - 1200000),
    lastReconciledAt = new Date(Date.now() - 25 * 3600000);
  await WalmartSync.update(
    { cursorAt: cursor, lastReconciledAt },
    { where: { storeId: dailyStore.id } },
  );
  const raw = {
    ...sample('Acknowledged', 'DAILY-PO', 'DAILY-ORDER'),
    orderDate: Date.now() - 5 * 86400000,
  };
  let fail = true;
  const dailyClient = {
    async *orders(from, to) {
      if (raw.orderDate >= from.getTime() && raw.orderDate <= to.getTime())
        yield structuredClone(raw);
      if (fail) throw new Error('模拟下一页失败');
    },
    async order() {
      return structuredClone(raw);
    },
    async item() {
      return catalog.get('SKU-A').item;
    },
    async acknowledge() {
      assert.fail('已确认不重复确认');
    },
  };
  const options = { clientFactory: () => dailyClient };
  await startSync(dailyStore.id, options);
  await drainSyncTasks();
  let state = await WalmartSync.findByPk(dailyStore.id);
  assert.equal(state.status, 'failed');
  assert.equal(state.result.range.mode, 'reconcile');
  assert.equal(state.cursorAt.getTime(), cursor.getTime());
  assert.equal(state.lastReconciledAt.getTime(), lastReconciledAt.getTime());
  assert.equal(await OrderItem.count({ where: { shopName: dailyStore.systemStoreName } }), 1);
  fail = false;
  await startSync(dailyStore.id, options);
  await drainSyncTasks();
  state = await WalmartSync.findByPk(dailyStore.id);
  assert.equal(state.status, 'completed');
  assert.ok(state.lastReconciledAt > lastReconciledAt);
  assert.equal(state.lastReconciledAt.getTime(), state.cursorAt.getTime());
  assert.equal(await OrderItem.count({ where: { shopName: dailyStore.systemStoreName } }), 1);
});

test('三个店铺实际并发查询，第四个等待；同店手动任务拒绝重入', async () => {
  const stores = [];
  for (let i = 0; i < 4; i++) {
    const value = await Store.create({
      walmartStoreName: `并发平台${i}`,
      systemStoreName: `并发店铺${i}`,
      clientId: 'test',
      clientSecret: 'test',
    });
    await configureSync(value.id, true, actor);
    stores.push(value);
  }
  let release, ready;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  let active = 0;
  const options = {
    clientFactory: () => ({
      async *orders() {
        active++;
        if (active === 3) ready();
        await gate;
      },
    }),
  };
  try {
    await Promise.all(stores.slice(0, 3).map((value) => startSync(value.id, options)));
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('三个店铺未并发进入接口')), 5000);
        timer.unref();
      }),
    ]);
    assert.equal(active, 3);
    await assert.rejects(startSync(stores[3].id, options), /已有 3 个店铺/);
    await assert.rejects(startSync(stores[0].id, options), /正在同步/);
  } finally {
    release();
    await drainSyncTasks();
  }
  await startSync(stores[3].id, { clientFactory: () => ({ async *orders() {} }) });
  await drainSyncTasks();
  for (const value of stores)
    assert.equal((await WalmartSync.findByPk(value.id)).status, 'completed');
});

test('密钥初始化失败也记录开始时间，自动下一轮不会立即重试坏店铺', async () => {
  const badStore = await Store.create({
    walmartStoreName: '无效平台',
    systemStoreName: '无效店铺',
  });
  await configureSync(badStore.id, true, actor);
  let calls = 0;
  const options = {
    scheduled: true,
    clientFactory: () => {
      calls++;
      throw new Error('模拟认证失败');
    },
  };
  await startSync(badStore.id, options);
  await drainSyncTasks();
  const state = await WalmartSync.findByPk(badStore.id);
  assert.equal(state.status, 'failed');
  assert.ok(state.lastRunAt);
  assert.equal(state.lastReconciledAt, null);
  await startSync(badStore.id, options);
  await drainSyncTasks();
  assert.equal(calls, 1);
});

test('首次补查中暂停不记录完成进度，恢复后仍从接收起点重试', async () => {
  const pausedStore = await Store.create({
    walmartStoreName: '暂停补查平台',
    systemStoreName: '暂停补查店铺',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(pausedStore.id, true, actor);
  const cursor = new Date(Date.now() - 1200000);
  await WalmartSync.update({ cursorAt: cursor }, { where: { storeId: pausedStore.id } });
  const pausedClient = {
    async *orders() {
      await configureSync(pausedStore.id, false, actor);
      yield sample('Acknowledged', 'PAUSED-PO', 'PAUSED-ORDER');
    },
    async item() {
      assert.fail('暂停后不继续查商品');
    },
  };
  await startSync(pausedStore.id, { clientFactory: () => pausedClient });
  await drainSyncTasks();
  const state = await WalmartSync.findByPk(pausedStore.id);
  assert.equal(state.cursorAt.getTime(), cursor.getTime());
  assert.equal(state.lastReconciledAt, null);
  assert.equal(await OrderItem.count({ where: { shopName: pausedStore.systemStoreName } }), 0);
  await configureSync(pausedStore.id, true, actor);
  let first;
  await startSync(pausedStore.id, {
    clientFactory: () => ({
      async *orders(from) {
        first ??= from;
      },
    }),
  });
  await drainSyncTasks();
  assert.equal(first.getTime(), WALMART_ORDER_START_MS);
  await state.reload();
  assert.ok(state.lastReconciledAt);
});
