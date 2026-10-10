import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  Order,
  OrderItem,
  Purchase,
  AuditLog,
  ImportJob,
  ImportTemplate,
  Upload,
  DictionaryOption,
} from '../src/models.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { migratePermissionsAudit } from '../src/migrations/permissions-audit.js';
import { auditCutoff, auditContext } from '../src/lib/audit-context.js';
import { cleanupAudit, drainAudit } from '../src/services/audit.js';
import { ensureStorage, uploadPath } from '../src/services/storage.js';
import { prepareImport } from '../src/services/imports.js';
import { persistOrder } from '../src/services/walmart/persistence.js';

// 必须显式使用一次性数据库，测试绝不清理本地业务库。
const isolated = /^my_order_permissions_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
let connection,
  created = false,
  server,
  base;
const users = {},
  sessions = {},
  items = {},
  stores = {},
  files = [];
const keys = ['shopName', 'orderNumber', 'walmartSku', 'purchaseNote', 'allocatable'];
const template = {
  name: '权限测试',
  headerRow: 1,
  mappings: keys.map((field, i) => ({ column: i + 1, header: field, field })),
};
async function request(role, path, method = 'GET', body, binary = false) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
      ...(sessions[role] || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json(),
    headers: response.headers,
  };
}
async function preview(rows, user = users.operations) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('采购');
  sheet.addRow(keys);
  rows.forEach((row) => sheet.addRow(row));
  const id = randomUUID();
  const upload = await Upload.create({
    id,
    filename: id + '.xlsx',
    originalName: '权限验证.xlsx',
    kind: 'excel',
    uploadedBy: user.id,
  });
  const path = uploadPath(upload);
  files.push(path);
  await workbook.xlsx.writeFile(path);
  return prepareImport(
    { sources: [{ uploadId: id, template, sheetName: '采购' }] },
    user,
    'purchase',
  );
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
  await migratePermissionsAudit();
  await migratePermissionsAudit();
  await ensureStorage();
  const passwordHash = await hashPassword('Permissions-test-123');
  for (const role of ['admin', 'operations', 'purchasing'])
    users[role] = await User.create({ username: role, displayName: role, role, passwordHash });
  users.empty = await User.create({
    username: 'empty',
    displayName: '无店铺',
    role: 'operations',
    passwordHash,
  });
  for (const name of ['A', 'B', 'NONE'])
    stores[name] = await Store.create({
      walmartStoreName: name,
      systemStoreName: name,
      ownerId: name === 'A' ? users.operations.id : name === 'B' ? users.admin.id : null,
      clientId: 'private-client-id',
      clientSecret: 'private-secret',
    });
  for (const name of ['A', 'B', 'NONE', 'ORPHAN']) {
    const order = await Order.create({ orderNumber: 'ORDER-' + name });
    items[name] = await OrderItem.create({
      orderId: order.id,
      shopName: name,
      walmartSku: 'SKU',
      purchaseChannelKey: 'test',
      orderDate: '2026-10-10',
      platformShipDate: '2026-10-10',
      platformOrderStatus: '已确认',
      fulfillmentParty: 'SellerFulfilled',
    });
    await Purchase.create({ itemId: items[name].id, purchaseNote: 'before' });
  }
  await DictionaryOption.create({ kind: 'purchaseChannel', value: '渠道A' });
  await DictionaryOption.create({ kind: 'orderStatus', value: '砍单' });
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const role of ['admin', 'operations', 'purchasing', 'empty']) {
    const login = await request(role, '/auth/login', 'POST', {
      username: role,
      password: 'Permissions-test-123',
    });
    assert.equal(login.status, 200);
    sessions[role] = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      'X-CSRF-Token': login.data.csrfToken,
    };
  }
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await drainAudit();
  await db.close();
  for (const file of files) await fs.rm(file, { force: true });
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('菜单接口矩阵、旧维护接口和直接请求不能绕过权限', async () => {
  for (const path of [
    '/users',
    '/stores',
    '/management/users',
    '/management/stores',
    '/stores/1/walmart',
  ]) {
    for (const role of ['operations', 'purchasing'])
      assert.equal((await request(role, path)).status, 403, path);
  }
  for (const [role, allowed, denied] of [
    ['operations', ['orderStatus'], ['purchaseChannel', 'purchasePlatform', 'purchaseStatus']],
    ['purchasing', ['purchaseChannel', 'purchasePlatform', 'purchaseStatus'], ['orderStatus']],
  ]) {
    for (const kind of allowed)
      assert.equal((await request(role, '/dictionaries/' + kind)).status, 200);
    for (const kind of denied)
      for (const [path, method, body] of [
        ['/dictionaries/' + kind, 'POST', {}],
        ['/management/dictionaries?kind=' + kind, 'GET', undefined],
        ['/management/dictionaries/batch-delete', 'POST', { kind, rows: [] }],
      ])
        assert.equal((await request(role, path, method, body)).status, 403);
  }
  assert.equal((await request('purchasing', '/risk-addresses')).status, 403);
  assert.equal((await request('operations', '/risk-addresses')).status, 200);
  assert.equal((await request('admin', '/stores')).status, 200);
  assert.equal((await request('operations', '/templates')).status, 200);
  assert.equal(
    (
      await request(
        'operations',
        '/management/dictionaries/batch-delete?kind=orderStatus',
        'POST',
        { kind: 'purchaseChannel', rows: [] },
      )
    ).status,
    403,
  );
});
test('订单列表、详情、预警、店铺及导出使用强制归属范围，无店铺账号返回空集', async () => {
  assert.equal((await request('operations', '/orders')).data.total, 1);
  assert.equal((await request('operations', '/orders?shopName=B')).data.total, 0);
  assert.equal(
    (await request('operations', `/orders?storeOwnerId=${users.admin.id}`)).data.total,
    0,
  );
  assert.equal((await request('empty', '/orders')).data.total, 0);
  assert.equal((await request('purchasing', '/orders')).data.total, 4);
  assert.equal((await request('admin', '/orders')).data.total, 4);
  assert.equal((await request('operations', `/orders/${items.B.id}`)).status, 403);
  const dash = (await request('operations', '/dashboard')).data;
  assert.equal(dash.total, 1);
  assert.deepEqual(dash.shops, ['A']);
  assert.equal((await request('operations', '/order-owners')).data.length, 1);
  const exportResult = await request(
    'operations',
    '/orders/export-purchases',
    'POST',
    { filters: {} },
    true,
  );
  assert.equal(exportResult.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(exportResult.data);
  assert.equal(book.worksheets[0].rowCount, 2);
  assert.equal(book.worksheets[0].getCell('A2').value, 'A');
});
test('跨店铺编辑和混合批量分配拒绝，事务回滚且不会留下成功变更日志', async () => {
  const before = await Purchase.findOne({ where: { itemId: items.A.id } });
  assert.equal(
    (
      await request('operations', `/orders/${items.B.id}`, 'PUT', {
        version: 1,
        fields: { orderNumber: 'ORDER-B', purchaseNote: 'unauthorized' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('operations', '/assignments', 'POST', {
        items: [
          { id: items.A.id, version: 1 },
          { id: items.B.id, version: 1 },
        ],
        purchaseChannel: ['渠道A'],
      })
    ).status,
    403,
  );
  assert.equal((await Purchase.findByPk(before.id)).purchaseChannel, null);
  assert.equal(await AuditLog.count({ where: { action: 'update_record' } }), 0);
  assert.equal(
    (
      await request('operations', '/orders/batch-status', 'POST', {
        items: [{ id: items.B.id, version: 1 }],
        orderStatus: '砍单',
      })
    ).status,
    403,
  );
});
test('共享模板允许维护，操作日志记录前后值、账号和删除快照', async () => {
  const made = await request('operations', '/templates', 'POST', template);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const changed = await request('purchasing', '/templates/' + made.data.id, 'PUT', {
    ...template,
    name: '共享已修改',
  });
  assert.equal(changed.status, 200);
  const audit = await AuditLog.findOne({
    where: { action: 'update_record', userId: users.purchasing.id },
    order: [['id', 'DESC']],
  });
  assert.deepEqual(audit.details.changes.name, { before: '权限测试', after: '共享已修改' });
  assert.equal(audit.details.actor.username, 'purchasing');
  assert.equal((await request('operations', '/templates/' + made.data.id, 'DELETE')).status, 200);
  assert.ok(
    await AuditLog.findOne({ where: { action: 'delete_record', entityId: String(made.data.id) } }),
  );
});
test('混合采购导入仅更新本人店铺，外店非法采购字段跳过，提交前重新校验归属', async () => {
  const p = await preview([
    ['A', 'ORDER-A', 'SKU', 'own', '是'],
    ['B', 'ORDER-B', 'SKU', 'foreign', '非法选项'],
  ]);
  assert.equal(p.updated, 1);
  assert.equal(p.skipped, 1);
  assert.equal(p.errorCount, 0);
  assert.match(p.skippedRows[0].reason, /权限/);
  assert.equal((await request('purchasing', '/imports/' + p.id)).status, 403);
  const done = await request('operations', `/imports/purchases/${p.id}/commit`, 'POST', {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.updated, 1);
  assert.equal((await Purchase.findOne({ where: { itemId: items.A.id } })).purchaseNote, 'own');
  assert.equal((await Purchase.findOne({ where: { itemId: items.B.id } })).purchaseNote, 'before');
  const next = await preview([['A', 'ORDER-A', 'SKU', 'must skip', '是']]);
  await stores.A.update({ ownerId: users.admin.id });
  const skipped = await request('operations', `/imports/purchases/${next.id}/commit`, 'POST', {});
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.updated, 0);
  assert.equal(skipped.data.skipped, 1);
  await stores.A.update({ ownerId: users.operations.id });
  assert.equal((await request('operations', '/management/imports')).data.total, 2);
  assert.equal((await request('purchasing', '/management/imports')).data.total, 0);
  assert.equal(await OrderItem.count(), 4);
});
test('日志普通账号仅看自己，管理员全部可读，所有写入口拒绝且凭据脱敏', async () => {
  await request('operations', '/orders?q=SKU');
  await drainAudit();
  const logs = await request('operations', '/audit-logs');
  assert.equal(logs.status, 200);
  assert.ok(logs.data.rows.every((row) => row.userId === users.operations.id));
  const foreign = await AuditLog.findOne({ where: { userId: users.purchasing.id } });
  assert.equal((await request('operations', `/audit-logs/${foreign.id}`)).status, 404);
  assert.equal((await request('operations', `/audit-logs?userId=${users.admin.id}`)).status, 403);
  assert.equal((await request('admin', `/audit-logs/${foreign.id}`)).status, 200);
  for (const role of ['admin', 'operations', 'purchasing'])
    for (const [path, method] of [
      ['/audit-logs', 'POST'],
      ['/audit-logs/1', 'PUT'],
      ['/audit-logs/1', 'DELETE'],
      ['/management/imports/batch-delete', 'POST'],
    ])
      assert.equal((await request(role, path, method, {})).status, 403);
  await auditContext.run(
    { actor: { id: users.admin.id, username: 'admin' }, method: 'PUT', path: '/test' },
    () =>
      db.transaction(async (transaction) => {
        await stores.B.update({ clientSecret: 'new-secret', clientId: 'new-id' }, { transaction });
      }),
  );
  const secret = await AuditLog.findOne({
    where: { action: 'update_record', userId: users.admin.id },
    order: [['id', 'DESC']],
  });
  assert.ok(!JSON.stringify(secret.details).includes('new-secret'));
  assert.ok(!JSON.stringify(secret.details).includes('private-secret'));
  const count = await AuditLog.count();
  await request('operations', '/meta');
  await request('operations', '/auth/me');
  await drainAudit();
  assert.equal(await AuditLog.count(), count);
});
test('两个月保留边界、月底和分批清理，业务数据保持不变', async () => {
  assert.equal(
    auditCutoff(new Date('2026-04-30T08:00:00Z')).toISOString(),
    '2026-02-28T08:00:00.000Z',
  );
  const cutoff = auditCutoff();
  cutoff.setMilliseconds(0);
  await AuditLog.bulkCreate([
    { action: 'expired', createdAt: new Date(cutoff.getTime() - 1000) },
    { action: 'boundary', createdAt: new Date(cutoff.getTime() + 1000) },
  ]);
  const before = await OrderItem.count();
  assert.ok((await cleanupAudit()) >= 1);
  assert.equal(await AuditLog.count({ where: { action: 'expired' } }), 0);
  assert.equal(await AuditLog.count({ where: { action: 'boundary' } }), 1);
  assert.equal(await OrderItem.count(), before);
  const indexes = await db.getQueryInterface().showIndex('audit_logs');
  assert.ok(indexes.some((index) => index.name === 'audit_logs_user_time_id'));
});
test('查看成功或失败均不记日志，Walmart 同步和预览请求也不记录', async () => {
  await drainAudit();
  const count = await AuditLog.count();
  for (const path of [
    '/orders?q=SKU',
    `/orders/${items.A.id}`,
    `/orders/${items.B.id}`,
    '/audit-logs',
    '/audit-logs?userId=invalid',
    '/dashboard',
    '/management/imports',
    '/stores',
  ])
    await request('operations', path);
  // 不存在的店铺会在本地校验失败，不调用 Walmart 网络接口。
  for (const path of ['/stores/999999/walmart/sync', '/stores/999999/walmart/preview']) {
    assert.ok((await request('admin', path, 'POST', {})).status >= 400);
  }
  await drainAudit();
  assert.equal(await AuditLog.count(), count);
});
test('角色更改对现有会话立即生效，订单删除和新增仍然禁止', async () => {
  await users.purchasing.update({ role: 'operations' });
  assert.equal((await request('purchasing', '/orders')).data.total, 0);
  assert.equal((await request('purchasing', '/dictionaries/purchaseStatus')).status, 403);
  for (const role of ['admin', 'operations']) {
    assert.equal((await request(role, '/orders', 'POST', {})).status, 403);
    assert.equal((await request(role, `/orders/${items.A.id}`, 'DELETE', {})).status, 403);
  }
});
test('Walmart 新增及更新订单不记日志，也不泄漏或破坏账号审计上下文', async () => {
  await drainAudit();
  const count = await AuditLog.count();
  const remote = {
    purchaseOrderId: 'AUDIT-PO',
    customerOrderId: 'AUDIT-CUSTOMER',
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'AUDIT-SKU', productName: '官方商品' },
          orderLineQuantity: { amount: '1' },
          orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged' }] },
        },
      ],
    },
  };
  const context = { actor: { id: users.admin.id }, method: 'POST', path: '/test-sync' };
  await auditContext.run(context, async () => {
    assert.equal((await persistOrder(stores.A, remote, new Map(), users.admin)).added, 1);
    remote.orderLines.orderLine[0].item.productName = '官方更新';
    assert.equal((await persistOrder(stores.A, remote, new Map(), users.admin)).updated, 1);
    assert.equal(auditContext.getStore(), context);
    assert.equal(await AuditLog.count(), count);
    await stores.A.update({ walmartStoreName: '账号修改仍记录' });
  });
  assert.equal(await AuditLog.count(), count + 1);
  const item = await OrderItem.findOne({ where: { walmartSku: 'AUDIT-SKU' } });
  assert.equal(item.productName, '官方更新');
});
