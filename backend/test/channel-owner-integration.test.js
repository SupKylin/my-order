import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import { config } from '../src/config.js';
import { db, User, Store, Order, OrderItem, Purchase, DictionaryOption } from '../src/models.js';
import { saveStore, listStores } from '../src/services/stores.js';
import { listManagement } from '../src/services/management-list.js';
import { getItem, listOrders, assignItems } from '../src/services/orders.js';
import { exportOrders } from '../src/services/order-export.js';
import { migrateStores } from '../src/migrations.js';
import { channelKey } from '../src/lib/order-identity.js';
import '../src/services/walmart/models.js';

// 只在一次性数据库运行，测试结束删除测试库，不接触本地或线上业务数据。
const isolated = /^my_order_channel_test_\d+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  actor,
  owner,
  store,
  first,
  second;
const items = (rows) => rows.map(({ id, version }) => ({ id, version }));
const inputStore = (name, ownerId = null) => ({
  walmartStoreName: `W-${name}`,
  systemStoreName: name,
  ownerId,
  clientId: 'test-id',
  clientSecret: 'test-secret',
});
async function createItem(shopName, purchaseChannel, index) {
  const order = await Order.create({ orderNumber: `ORDER-${index}` });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName,
    walmartSku: `SKU-${index}`,
    purchaseChannelKey: channelKey(purchaseChannel),
    quantity: 1,
    orderDate: '2026-10-09',
    platformShipDate: '2026-10-10',
    platformOrderStatus: '已确认',
  });
  await Purchase.create({
    itemId: item.id,
    purchaseChannel,
    assignedTo: actor.id,
    purchaseNote: '保留采购备注',
  });
  return getItem(item.id);
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
  actor = await User.create({
    username: 'admin-test',
    displayName: '管理员',
    role: 'admin',
    passwordHash: 'test',
  });
  owner = await User.create({
    username: 'ops-test',
    displayName: '运营姓名',
    role: 'operations',
    passwordHash: 'test',
  });
  await DictionaryOption.bulkCreate([
    { kind: 'purchaseChannel', value: '渠道甲' },
    { kind: 'purchaseChannel', value: '渠道乙/专用' },
    { kind: 'purchaseChannel', value: '未分配' },
    { kind: 'purchaseChannel', value: '停用渠道', active: false },
  ]);
});
after(async () => {
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('增量迁移添加归属字段，重复运行保留店铺及密钥', async () => {
  const oldStore = await Store.create(inputStore('OLD'));
  const query = db.getQueryInterface();
  const constraints = await query.getForeignKeyReferencesForTable('stores');
  for (const constraint of constraints.filter((entry) => entry.columnName === 'ownerId'))
    await query.removeConstraint('stores', constraint.constraintName);
  await query.removeColumn('stores', 'ownerId');
  await migrateStores();
  await migrateStores();
  await oldStore.reload();
  assert.equal(oldStore.clientSecret, 'test-secret');
  assert.equal(oldStore.ownerId, null);
  await oldStore.destroy();
});

test('一家店铺绑定一个账号、一个账号绑定多店，列表返回姓名且不泄露账号密码', async () => {
  store = await saveStore(null, inputStore('SHOP-A', owner.id), actor);
  await saveStore(null, inputStore('SHOP-B', owner.id), actor);
  assert.equal(store.owner.displayName, '运营姓名');
  assert.equal(store.owner.passwordHash, undefined);
  assert.equal((await listStores()).filter((row) => row.ownerId === owner.id).length, 2);
  assert.equal((await listManagement('stores')).rows[0].owner.displayName, '运营姓名');
  first = await createItem('SHOP-A', ['未分配'], 1);
  second = await createItem('SHOP-B', null, 2);
  assert.equal(first.storeOwner.displayName, '运营姓名');
  assert.equal(first.store, undefined);
  const result = await listOrders({ storeOwnerId: owner.id });
  assert.equal(result.total, 2);
  assert.equal(
    result.shippingDates.reduce((sum, row) => sum + row.count, 0),
    2,
  );
  assert.equal((await listOrders({ storeOwnerId: actor.id })).total, 0);
});

test('单条和批量分配覆盖渠道，更新身份缓存且保留原采购记录', async () => {
  await assignItems({ items: items([first]), purchaseChannel: ['渠道甲'] }, actor);
  first = await getItem(first.id);
  assert.deepEqual(first.purchaseChannel, ['渠道甲']);
  await assignItems(
    { items: items([first, second]), purchaseChannel: ['渠道乙/专用', '渠道甲', '渠道甲'] },
    actor,
  );
  first = await getItem(first.id);
  second = await getItem(second.id);
  for (const row of [first, second]) {
    assert.deepEqual(row.purchaseChannel, ['渠道乙/专用', '渠道甲']);
    assert.equal(row.purchaseNote, '保留采购备注');
    assert.equal(row.assignedTo, actor.id);
    assert.equal(
      (await OrderItem.findByPk(row.id)).purchaseChannelKey,
      channelKey(row.purchaseChannel),
    );
  }
  assert.equal((await listOrders({ purchaseChannel: '渠道乙/专用' })).total, 2);
});

test('非法、停用渠道、旧版人员分配和版本冲突不会造成部分覆盖', async () => {
  for (const purchaseChannel of [[], ['不存在'], ['停用渠道'], [null]])
    await assert.rejects(assignItems({ items: items([first]), purchaseChannel }, actor));
  await assert.rejects(
    assignItems({ items: items([first]), assignedTo: owner.id }, actor),
    /采购渠道/,
  );
  await assert.rejects(
    assignItems(
      {
        items: items([first, { ...second, version: second.version - 1 }]),
        purchaseChannel: ['渠道甲'],
      },
      actor,
    ),
    /已更新/,
  );
  assert.deepEqual((await getItem(first.id)).purchaseChannel, first.purchaseChannel);
  assert.equal((await getItem(first.id)).version, first.version);
  await Purchase.update({ allocatable: '否' }, { where: { itemId: second.id } });
  await assert.rejects(
    assignItems({ items: items([first, second]), purchaseChannel: ['渠道甲'] }, actor),
    /不可分配/,
  );
  assert.equal((await getItem(first.id)).version, first.version);
});

test('未分配筛选兼容空值、空数组和历史空文本，并与姓名、导出条件一致', async () => {
  const empty = [];
  for (const [index, raw] of [null, '', '[]', '  '].entries()) {
    const row = await createItem('SHOP-A', null, index + 10);
    await db.query('UPDATE purchases SET purchaseChannel = ? WHERE itemId = ?', {
      replacements: [raw, row.id],
    });
    empty.push(row.id);
  }
  await createItem('SHOP-A', ['未分配'], 20);
  const result = await listOrders({
    purchaseChannelEmpty: 'true',
    storeOwnerId: owner.id,
    pageSize: 1,
  });
  assert.equal(result.total, 4);
  assert.equal(result.rows.length, 1);
  assert.equal(
    result.shippingDates.reduce((sum, row) => sum + row.count, 0),
    4,
  );
  assert.equal((await listOrders({ purchaseChannel: '未分配' })).total, 1);
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  stream.setHeader = () => {};
  await exportOrders(
    { filters: { purchaseChannelEmpty: true, storeOwnerId: owner.id, pageSize: 1 } },
    stream,
    true,
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  assert.equal(workbook.worksheets[0].rowCount - 1, 4);
  assert.equal((await listOrders({ purchaseChannelEmpty: true, storeOwnerId: actor.id })).total, 0);
});

test('改绑、账号改名即时显示；未绑定及无店铺配置的订单仍可见', async () => {
  await owner.update({ displayName: '运营新姓名' });
  assert.equal((await getItem(first.id)).storeOwner.displayName, '运营新姓名');
  store = await saveStore(
    store.id,
    { ...inputStore('SHOP-A', actor.id), version: store.version },
    actor,
  );
  assert.equal((await getItem(first.id)).storeOwner.displayName, '管理员');
  assert.equal((await listOrders({ storeOwnerId: owner.id })).total, 1);
  store = await saveStore(store.id, { ...inputStore('SHOP-A'), version: store.version }, actor);
  await createItem('UNMAINTAINED', null, 30);
  const result = await listOrders({ storeOwnerId: 'unbound' });
  assert.equal(result.total, 7);
  assert.ok(result.rows.every((row) => row.storeOwner === null));
  assert.equal((await listOrders({})).total, 8);
  await assert.rejects(listOrders({ storeOwnerId: 'bad' }), /无效/);
});

test('绑定拒绝不存在或停用账号；删除所属账号后订单与店铺仍保留', async () => {
  await assert.rejects(saveStore(null, inputStore('BAD', 99999), actor), /不存在/);
  await owner.update({ active: false });
  await assert.rejects(saveStore(null, inputStore('BAD', owner.id), actor), /已停用/);
  await owner.destroy();
  assert.equal((await Store.findOne({ where: { systemStoreName: 'SHOP-B' } })).ownerId, null);
  assert.equal((await getItem(second.id)).storeOwner, null);
  assert.equal(await OrderItem.count(), 8);
});
