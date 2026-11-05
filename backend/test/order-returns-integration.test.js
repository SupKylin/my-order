import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import { config } from '../src/config.js';
import { db, User, Store, OrderItem, Purchase } from '../src/models.js';
import { WalmartReturn, WalmartSync } from '../src/services/walmart/models.js';
import { syncOrderReturns, compactReturn } from '../src/services/walmart/returns.js';
import { persistOrder } from '../src/services/walmart/persistence.js';
import { configureSync, startSync, drainSyncTasks } from '../src/services/walmart/sync.js';
import { migrateWalmart } from '../src/migrations/walmart.js';
import { listOrders, getItem, editItem } from '../src/services/orders.js';
import { exportOrders } from '../src/services/order-export.js';

const isolated = /^my_order_returns_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
let connection,
  created = false,
  actor,
  operator,
  store,
  state;
const end = new Date('2026-11-01T10:00:00Z');
const catalog = new Map();
function order(customer = 'C1', po = 'PO1', skus = ['SKU-A', 'SKU-B']) {
  return {
    customerOrderId: customer,
    purchaseOrderId: po,
    orderDate: Date.parse('2026-10-15T10:00:00Z'),
    shipNode: { type: 'SellerFulfilled' },
    orderLines: {
      orderLine: skus.map((sku, index) => ({
        lineNumber: String(index + 1),
        item: { sku, productName: '测试商品' },
        orderLineQuantity: { amount: '2' },
        orderLineStatuses: { orderLineStatus: [{ status: 'Delivered' }] },
      })),
    },
  };
}
function refund(
  id = 'R1',
  customer = 'C1',
  po = 'PO1',
  sku = 'SKU-A',
  status = 'REFUND_COMPLETED',
) {
  return compactReturn({
    returnOrderId: id,
    customerOrderId: customer,
    returnOrderDate: '2026-10-20T08:00:00Z',
    returnOrderLines: [
      {
        returnOrderLineNumber: 1,
        purchaseOrderId: po,
        item: { sku },
        quantity: { measurementValue: 1 },
        refundedQty: 1,
        status: 'COMPLETED',
        currentRefundStatus: status,
        chargeTotals: [
          { name: 'lineTotal', value: { currencyAmount: '12.34', currencyUnit: 'USD' } },
        ],
        currentTrackingStatuses: [
          { currentRefundStatus: 'REFUND_COMPLETED', statusTime: '2026-10-21T10:00:00Z' },
        ],
      },
    ],
  });
}
async function run(records, options = {}) {
  return syncOrderReturns({
    store,
    state,
    client: { order: async (po) => order('MISSING', po, ['MISSING-SKU']) },
    end,
    stillEnabled: async () => true,
    reader: async () => records,
    saveOrder: async (data) => persistOrder(store, data, catalog, actor),
    ...options,
  });
}
before(async () => {
  if (!isolated) return;
  connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
  });
  await connection.query(
    `CREATE DATABASE ${mysql.escapeId(config.db.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  created = true;
  await db.sync();
  await db.getQueryInterface().removeColumn('order_items', 'returnInfo');
  await db.getQueryInterface().removeColumn('walmart_sync_states', 'returnsCursorAt');
  await db.getQueryInterface().removeColumn('walmart_sync_states', 'returnsCredentialKey');
  await migrateWalmart();
  await migrateWalmart();
  actor = await User.create({
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    passwordHash: 'test',
  });
  operator = await User.create({
    username: 'op',
    displayName: '运营',
    role: 'operations',
    passwordHash: 'test',
  });
  store = await Store.create({
    systemStoreName: 'OWN',
    walmartStoreName: 'OWN',
    ownerId: operator.id,
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(store.id, true, actor);
  state = await WalmartSync.findByPk(store.id);
});
after(async () => {
  await drainSyncTasks();
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('部分商品退款、多退货单独立关联，重复同步不新增订单、不改采购和版本', async () => {
  await persistOrder(store, order(), catalog, actor);
  const a = await OrderItem.findOne({ where: { walmartSku: 'SKU-A' } });
  await Purchase.update(
    { purchaseNote: '人工备注', purchaseQuantity: 7 },
    { where: { itemId: a.id } },
  );
  const version = a.version;
  await run([refund(), refund('R2', 'C1', 'PO1', 'SKU-A', 'REFUND_INITIATED')]);
  await run([refund(), refund('R2', 'C1', 'PO1', 'SKU-A', 'REFUND_INITIATED')]);
  assert.equal(await OrderItem.count(), 2);
  assert.equal(await WalmartReturn.count(), 2);
  const data = await getItem(a.id, operator);
  assert.deepEqual(new Set(data.returnStatuses), new Set(['已退款', '退款处理中']));
  assert.equal(data.returnInfo.lines.length, 2);
  assert.equal(data.platformOrderStatus, '已送达');
  assert.equal(data.purchaseNote, '人工备注');
  assert.equal(data.purchaseQuantity, 7);
  assert.equal(data.version, version);
  const b = await OrderItem.findOne({ where: { walmartSku: 'SKU-B' } });
  assert.equal(b.returnInfo, null);
  await persistOrder(store, order(), catalog, actor);
  assert.equal((await getItem(a.id, operator)).returnInfo.lines.length, 2);
});
test('退款状态变更覆盖该退货单，不抹掉另一笔退款；空金额不伪装0', async () => {
  const update = refund('R2', 'C1', 'PO1', 'SKU-A', 'REFUND_CANCELLED');
  update.lines[0].amount = null;
  await run([update]);
  const a = await OrderItem.findOne({ where: { walmartSku: 'SKU-A' } });
  assert.deepEqual(new Set(a.returnInfo.statuses), new Set(['已退款', '已取消']));
  assert.equal(a.returnInfo.lines.find((l) => l.returnOrderId === 'R2').amount, null);
  assert.equal(a.returnInfo.lines.find((l) => l.returnOrderId === 'R2').completedAt, null);
});
test('缺失订单官方补拉一次，范围外订单跳过；未关联失败保留记录下轮重试', async () => {
  let calls = 0;
  const data = refund('RM', 'MISSING', 'PM', 'MISSING-SKU');
  const client = {
    order: async (po) => {
      calls++;
      return order('MISSING', po, ['MISSING-SKU']);
    },
  };
  await run([data], { client });
  await run([data], { client });
  assert.equal(calls, 1);
  assert.ok((await OrderItem.findOne({ where: { walmartSku: 'MISSING-SKU' } })).returnInfo);
  await run([refund('RO', 'OLD', 'POLD', 'OLD-SKU')], {
    client: {
      order: async () => ({
        ...order('OLD', 'POLD', ['OLD-SKU']),
        orderDate: Date.parse('2026-09-30T10:00:00Z'),
      }),
    },
  });
  assert.equal(await OrderItem.count({ where: { walmartSku: 'OLD-SKU' } }), 0);
  const bad = refund('RB', 'FAILED', 'PB', 'FAILED-SKU');
  const failed = await run([bad], {
    client: {
      order: async () => {
        throw new Error('模拟接口失败');
      },
    },
  });
  assert.ok(failed.pending);
  assert.equal((await WalmartReturn.findOne({ where: { returnOrderId: 'RB' } })).linked, false);
  await run([], { client: { order: async () => order('FAILED', 'PB', ['FAILED-SKU']) } });
  assert.equal((await WalmartReturn.findOne({ where: { returnOrderId: 'RB' } })).linked, true);
});
test('多选并集、其他条件交集、运营隔离；两类导出沿用筛选', async () => {
  const other = await Store.create({
    systemStoreName: 'OTHER',
    walmartStoreName: 'OTHER',
    ownerId: actor.id,
    clientId: 'x',
    clientSecret: 'x',
  });
  await persistOrder(other, order('C1', 'PO1'), catalog, actor);
  await configureSync(other.id, true, actor);
  const s = await WalmartSync.findByPk(other.id);
  await run([refund()], { store: other, state: s });
  const query = { returnStatuses: JSON.stringify(['已退款', '已取消']), q: 'C1', pageSize: 20 };
  assert.equal((await listOrders(query, actor)).total, 2);
  assert.equal((await listOrders(query, operator)).total, 1);
  assert.equal((await listOrders({ ...query, shopNames: ['OTHER'] }, operator)).total, 0);
  assert.equal((await listOrders({ ...query, returnStatuses: ['退款处理中'] }, actor)).total, 0);
  for (const purchaseTemplate of [false, true]) {
    const chunks = [];
    const res = new Writable({
      write(chunk, encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    res.setHeader = () => {};
    await exportOrders(
      { filters: { ...query, returnStatuses: ['已退款', '已取消'] } },
      res,
      purchaseTemplate,
      { user: operator },
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks));
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 2);
    assert.equal(sheet.getRow(2).getCell(1).value, 'OWN');
    if (!purchaseTemplate) {
      const col = sheet.getRow(1).values.indexOf('退货退款状态');
      assert.ok(col > 0);
      assert.match(sheet.getRow(2).getCell(col).value, /已退款/);
    }
  }
  const target = await OrderItem.findOne({ where: { shopName: 'OWN', walmartSku: 'SKU-A' } });
  await assert.rejects(
    editItem(target.id, { version: target.version, fields: { returnStatuses: ['已取消'] } }, actor),
  );
});
test('失败不推进退款游标、不抹掉快照；实际同步独立记录错误而订单继续成功', async () => {
  const original = +state.returnsCursorAt;
  await assert.rejects(
    run([], {
      reader: async () => {
        throw new Error('退款HTTP403');
      },
    }),
    /403/,
  );
  assert.equal(+(await state.reload()).returnsCursorAt, original);
  const newStore = await Store.create({
    systemStoreName: 'SYNC',
    walmartStoreName: 'SYNC',
    clientId: 'a',
    clientSecret: 'a',
  });
  await configureSync(newStore.id, true, actor);
  await startSync(newStore.id, {
    clientFactory: () => ({
      async *orders() {
        yield order('SYNC', 'PSYNC', ['SSYNC']);
      },
      item: async () => ({}),
      order: async () => order('SYNC', 'PSYNC', ['SSYNC']),
    }),
    returnsReader: async () => {
      throw new Error('退款HTTP403');
    },
  });
  await drainSyncTasks();
  const sync = await WalmartSync.findByPk(newStore.id);
  assert.equal(sync.status, 'partial');
  assert.match(sync.result.returnsError, /403/);
  assert.ok(sync.cursorAt);
  assert.equal(sync.returnsCursorAt, null);
});

test('WFS退款可展示但仍禁止编辑，重复业务键不误关联', async () => {
  await persistOrder(
    store,
    { ...order('WFS', 'PWFS', ['WFS-SKU']), shipNode: { type: 'WFSFulfilled' } },
    catalog,
    actor,
  );
  await run([refund('RWFS', 'WFS', 'PWFS', 'WFS-SKU')]);
  const wfs = await OrderItem.findOne({ where: { walmartSku: 'WFS-SKU' } });
  assert.deepEqual(wfs.returnInfo.statuses, ['已退款']);
  assert.equal((await getItem(wfs.id, actor)).manualEditable, false);
  await assert.rejects(
    editItem(wfs.id, { version: wfs.version, fields: { followupNote: '不允许' } }, actor),
    /WFS/,
  );
  const duplicate = await OrderItem.create({
    orderId: wfs.orderId,
    shopName: store.systemStoreName,
    walmartSku: 'WFS-SKU',
    purchaseChannelKey: 'duplicate',
  });
  const result = await run([refund('RDUP', 'WFS', 'PWFS', 'WFS-SKU')]);
  assert.ok(result.pending);
  assert.ok(result.errors.some((e) => e.message.includes('未唯一匹配')));
  assert.equal((await duplicate.reload()).returnInfo, null);
});

test('实际任务补拉退款订单不确认，增量游标重叠48小时并在密钥变化后全量重查', async () => {
  const local = await Store.create({
    systemStoreName: 'REFUND-SYNC',
    walmartStoreName: 'REFUND-SYNC',
    clientId: 'r',
    clientSecret: 'r',
  });
  await configureSync(local.id, true, actor);
  const received = [];
  let ack = 0;
  const client = {
    async *orders() {},
    order: async () => order('BACKFILL', 'PBACK', ['SBACK']),
    item: async () => ({}),
    acknowledge: async () => {
      ack++;
      throw new Error('不应确认');
    },
  };
  await startSync(local.id, {
    clientFactory: () => client,
    returnsReader: async (c, from) => {
      received.push(+from);
      return [refund('RBACK', 'BACKFILL', 'PBACK', 'SBACK')];
    },
  });
  await drainSyncTasks();
  const s = await WalmartSync.findByPk(local.id);
  assert.equal(s.result.returns.backfilled, 1);
  assert.equal(ack, 0);
  const cursor = +s.returnsCursorAt;
  await run([], {
    store: local,
    state: s,
    reader: async (c, from) => {
      assert.equal(+from, cursor - 2 * 86400000);
      return [];
    },
  });
  await local.update({ clientSecret: 'new-secret' });
  await run([], {
    store: local,
    state: s,
    reader: async (c, from) => {
      assert.equal(+from, Date.parse('2026-10-01T08:00:00Z'));
      return [];
    },
  });
  assert.equal((await OrderItem.findOne({ where: { walmartSku: 'SBACK' } })).returnInfo, null);
});
