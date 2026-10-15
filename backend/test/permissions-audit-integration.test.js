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
import { migrateOrderTablePreferences } from '../src/migrations/order-table-preferences.js';
import { migrateProcurementState } from '../src/migrations/procurement-state.js';
import { migratePurchaseAssignment } from '../src/migrations/purchase-assignment.js';
import { auditCutoff, auditContext } from '../src/lib/audit-context.js';
import { cleanupAudit, drainAudit } from '../src/services/audit.js';
import { ensureStorage, uploadPath } from '../src/services/storage.js';
import { prepareImport } from '../src/services/imports.js';
import { persistOrder } from '../src/services/walmart/persistence.js';
import { purchaseFingerprint } from '../src/lib/order-concurrency.js';
import { purchaseAssignmentSummary } from '../src/services/purchase-assignment-summary.js';

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
  // 模拟旧账号表，验证增量迁移和重复执行。
  await db.getQueryInterface().removeColumn('users', 'orderTablePreferences');
  await migrateOrderTablePreferences();
  await migrateOrderTablePreferences();
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
  // 本人订单先满足分配条件，才能验证后续跨店铺拒绝及整批回滚。
  await Purchase.update(
    { allocatable: '是', reviewStatus: '已审核' },
    { where: { itemId: items.A.id } },
  );
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
test('共享模板复制生成独立副本并自动避重命名，保留未映射列并记录创建日志', async () => {
  const source = await request('operations', '/templates', 'POST', {
    ...template,
    name: '复制测试',
    headerRow: 3,
    mappings: [...template.mappings, { column: 9, header: '保留源列', field: '' }],
  });
  assert.equal(source.status, 201);
  const copies = await Promise.all(
    ['operations', 'purchasing'].map((role) =>
      request(role, `/templates/${source.data.id}/copy`, 'POST', {}),
    ),
  );
  assert.ok(
    copies.every((copy) => copy.status === 201),
    JSON.stringify(copies),
  );
  assert.deepEqual(copies.map((copy) => copy.data.name).sort(), [
    '复制测试 - 副本',
    '复制测试 - 副本 (2)',
  ]);
  for (const copy of copies) {
    assert.notEqual(copy.data.id, source.data.id);
    assert.equal(copy.data.headerRow, 3);
    assert.deepEqual(copy.data.mappings, source.data.mappings);
    assert.equal(copy.data.sheetName, '');
    assert.equal(copy.data.purchaseChannelId, null);
    assert.ok(
      await AuditLog.findOne({
        where: { action: 'create_record', entityId: String(copy.data.id) },
      }),
    );
  }
  await request('operations', `/templates/${copies[0].data.id}`, 'PUT', {
    ...template,
    name: copies[0].data.name,
  });
  assert.equal((await ImportTemplate.findByPk(source.data.id)).headerRow, 3);
  assert.equal((await request('operations', '/templates/999999/copy', 'POST', {})).status, 404);
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

test('表头设置按当前账号隔离，重新登录恢复，非法设置不会覆盖已有值', async () => {
  const path = '/auth/order-table-preferences';
  assert.equal((await request('anonymous', path)).status, 401);
  assert.deepEqual((await request('operations', path)).data, { preferences: null });
  const saved = await request('operations', path, 'PUT', {
    order: ['tax', 'orderDate'],
    hidden: ['orderAmount'],
    userId: users.admin.id,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.preferences, {
    order: ['shopName', 'orderNumber', 'tax', 'orderDate'],
    hidden: ['orderAmount'],
  });
  assert.deepEqual((await request('admin', path)).data, { preferences: null });
  assert.deepEqual((await request('operations', path)).data, saved.data);
  assert.equal(
    (await request('operations', path, 'PUT', { order: ['passwordHash'], hidden: [] })).status,
    400,
  );
  assert.deepEqual((await request('operations', path)).data, saved.data);
  await request('operations', '/auth/logout', 'POST');
  const login = await request('operations', '/auth/login', 'POST', {
    username: 'operations',
    password: 'Permissions-test-123',
  });
  assert.equal(login.status, 200);
  sessions.operations = {
    Cookie: login.headers.get('set-cookie').split(';')[0],
    'X-CSRF-Token': login.data.csrfToken,
  };
  assert.deepEqual((await request('operations', path)).data, saved.data);
});

test('发货模式筛选限制列表及两种导出范围，保留店铺权限并支持清空条件', async () => {
  for (const [name, shippingMode] of [
    ['A', 'FBA'],
    ['B', 'FBA'],
    ['NONE', 'FBM'],
    ['ORPHAN', null],
  ])
    await Purchase.update({ shippingMode }, { where: { itemId: items[name].id } });

  const filtered = await request('admin', '/orders?shippingMode=FBA');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.total, 2);
  assert.deepEqual(filtered.data.rows.map((row) => row.id).sort(), [items.A.id, items.B.id].sort());
  const own = await request('operations', '/orders?shippingMode=FBA');
  assert.deepEqual(
    own.data.rows.map((row) => row.id),
    [items.A.id],
  );
  assert.equal((await request('operations', '/orders?shippingMode=FBA&shopName=B')).data.total, 0);
  const fbm = await request('admin', '/orders?shippingMode=FBM');
  assert.deepEqual(
    fbm.data.rows.map((row) => row.id),
    [items.NONE.id],
  );
  const unfiltered = await request('admin', '/orders');
  assert.equal((await request('admin', '/orders?shippingMode=')).data.total, unfiltered.data.total);
  assert.ok(unfiltered.data.rows.some((row) => row.id === items.ORPHAN.id));

  for (const route of ['/orders/export', '/orders/export-purchases']) {
    const exported = await request(
      'operations',
      route,
      'POST',
      { filters: { shippingMode: 'FBA' } },
      true,
    );
    assert.equal(exported.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.data);
    assert.equal(workbook.worksheets[0].rowCount, 2);
    assert.equal(workbook.worksheets[0].getCell('A2').value, 'A');
  }
});

test('主管确认停用后不显示或写入，兼容旧模板并保留数据库历史值', async () => {
  // 仅在隔离测试库模拟升级前列；生产升级不删除历史列。
  await db.query('ALTER TABLE purchases ADD COLUMN supervisorConfirmed VARCHAR(255) NULL');
  await db.query('UPDATE purchases SET supervisorConfirmed = :value WHERE itemId = :id', {
    replacements: { value: '已确认', id: items.A.id },
  });
  const metadata = await request('operations', '/meta');
  assert.ok(!metadata.data.fields.some((field) => field.key === 'supervisorConfirmed'));
  const item = await request('operations', `/orders/${items.A.id}`);
  assert.ok(!Object.hasOwn(item.data, 'supervisorConfirmed'));
  const rejected = await request('operations', `/orders/${items.A.id}`, 'PUT', {
    version: item.data.version,
    fields: { orderNumber: 'ORDER-A', supervisorConfirmed: '否' },
  });
  assert.equal(rejected.status, 400);

  const source = await ImportTemplate.create({
    ...template,
    sheetName: '',
    mappings: [...template.mappings, { header: '主管确认', field: 'supervisorConfirmed' }],
  });
  const copied = await request('operations', `/templates/${source.id}/copy`, 'POST', {});
  assert.equal(copied.status, 201);
  assert.deepEqual(copied.data.mappings.at(-1), { header: '主管确认', field: '' });

  const pending = await preview([['A', 'ORDER-A', 'SKU', 'retirement check', '是']]);
  const job = await ImportJob.findByPk(pending.id);
  const upload = await Upload.findByPk(job.uploadId);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(uploadPath(upload));
  book.worksheets[0].getCell('F1').value = '主管确认';
  book.worksheets[0].getCell('F2').value = '否';
  await book.xlsx.writeFile(uploadPath(upload));
  const newPreview = await prepareImport(
    { sources: [{ uploadId: upload.id, templateId: source.id, sheetName: '采购' }] },
    users.operations,
    'purchase',
  );
  assert.equal(newPreview.errorCount, 0);
  assert.ok(!Object.hasOwn(newPreview.rows[0].patch, 'supervisorConfirmed'));
  // 旧预览必须重新生成，不能静默写入或使用过时的确认内容。
  job.rows[0].patch.supervisorConfirmed = '否';
  job.changed('rows', true);
  await job.save();
  const stale = await request('operations', `/imports/purchases/${job.id}/commit`, 'POST', {});
  assert.equal(stale.status, 409);
  const committed = await request(
    'operations',
    `/imports/purchases/${newPreview.id}/commit`,
    'POST',
    {},
  );
  assert.equal(committed.status, 200);
  assert.equal(committed.data.updated, 1);
  const [legacy] = await db.query('SELECT supervisorConfirmed FROM purchases WHERE itemId = :id', {
    replacements: { id: items.A.id },
  });
  assert.equal(legacy[0].supervisorConfirmed, '已确认');
  for (const route of ['/orders/export', '/orders/export-purchases']) {
    const exported = await request(
      'operations',
      route,
      'POST',
      { filters: { q: 'ORDER-A' } },
      true,
    );
    assert.equal(exported.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.data);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 2);
    assert.equal(sheet.getCell('A2').value, 'A');
    assert.ok(!sheet.getRow(1).values.includes('主管确认'));
  }
});

test('审核及供应商状态增量回填，编辑、分配、导入与官方同步保持一致', async () => {
  // 模拟升级前不存在状态列，包含历史单选、空渠道及未审核但已有渠道的数据。
  await db.getQueryInterface().removeColumn('purchases', 'reviewStatus');
  await db.getQueryInterface().removeColumn('purchases', 'supplierAssignmentStatus');
  for (const [name, allocatable, channel] of [
    ['A', '是', '渠道A'],
    ['B', '否', '["渠道A"]'],
    ['NONE', null, '["渠道A"]'],
    ['ORPHAN', '是', '[]'],
  ])
    await db.query(
      'UPDATE purchases SET allocatable = :allocatable, purchaseChannel = :channel WHERE itemId = :id',
      {
        replacements: { allocatable, channel, id: items[name].id },
      },
    );
  await migrateProcurementState();
  await migrateProcurementState();
  const read = async (name = 'A') => (await request('admin', `/orders/${items[name].id}`)).data;
  const state = (item) => [item.reviewStatus, item.supplierAssignmentStatus];
  assert.deepEqual(state(await read()), ['已审核', '已分配']);
  assert.deepEqual(state(await read('B')), ['不可分配', '不可分配']);
  assert.deepEqual(state(await read('NONE')), [null, null]);
  assert.deepEqual(state(await read('ORPHAN')), ['已审核', null]);
  assert.deepEqual((await read('NONE')).purchaseChannel, ['渠道A']);

  const edit = async (fields) => {
    const current = await read();
    return request('operations', `/orders/${items.A.id}`, 'PUT', {
      version: current.version,
      fields: { orderNumber: 'ORDER-A', ...fields },
    });
  };
  assert.equal((await edit({ reviewStatus: '已审核' })).status, 400);
  assert.equal((await edit({ supplierAssignmentStatus: '已分配' })).status, 400);
  assert.equal((await edit({ allocatable: null })).status, 200);
  assert.deepEqual(state(await read()), [null, null]);
  assert.equal((await edit({ purchaseChannel: null })).status, 200);
  assert.equal((await edit({ purchaseChannel: ['渠道A'] })).status, 400);
  const unreviewed = await read();
  const blocked = await request('operations', '/assignments', 'POST', {
    items: [{ id: unreviewed.id, version: unreviewed.version }],
    purchaseChannel: ['渠道A'],
  });
  assert.equal(blocked.status, 400);
  // 批量包含未审核订单必须整批回滚，不能先给其他订单分配。
  const ready = await read('ORPHAN');
  assert.equal(
    (
      await request('admin', '/assignments', 'POST', {
        items: [
          { id: ready.id, version: ready.version },
          { id: unreviewed.id, version: unreviewed.version },
        ],
        purchaseChannel: ['渠道A'],
      })
    ).status,
    400,
  );
  assert.deepEqual(state(await read('ORPHAN')), ['已审核', null]);
  assert.equal((await edit({ allocatable: '是' })).status, 200);
  assert.deepEqual(state(await read()), ['已审核', null]);
  const approved = await read();
  assert.equal(
    (
      await request('operations', '/assignments', 'POST', {
        items: [{ id: approved.id, version: approved.version }],
        purchaseChannel: ['渠道A'],
      })
    ).status,
    200,
  );
  assert.deepEqual(state(await read()), ['已审核', '已分配']);
  const imported = await preview([['A', 'ORDER-A', 'SKU', 'state import', '否']]);
  assert.equal(
    (await request('operations', `/imports/purchases/${imported.id}/commit`, 'POST', {})).status,
    200,
  );
  assert.deepEqual(state(await read()), ['不可分配', '不可分配']);
  const blank = await preview([['A', 'ORDER-A', 'SKU', 'blank preserves', '']]);
  assert.equal(
    (await request('operations', `/imports/purchases/${blank.id}/commit`, 'POST', {})).status,
    200,
  );
  assert.deepEqual(state(await read()), ['不可分配', '不可分配']);
  assert.equal((await edit({ allocatable: '是', purchaseChannel: ['渠道A'] })).status, 200);

  const remote = {
    purchaseOrderId: 'STATE-PO',
    customerOrderId: 'STATE-ORDER',
    shipNode: { type: 'SellerFulfilled' },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'STATE-SKU', productName: '状态测试' },
          orderLineQuantity: { amount: '1' },
          orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged' }] },
        },
      ],
    },
  };
  await persistOrder(stores.A, remote, new Map(), users.admin);
  const fresh = await OrderItem.findOne({ where: { walmartSku: 'STATE-SKU' } });
  const created = (await request('admin', `/orders/${fresh.id}`)).data;
  assert.equal(created.purchaseAssignedAt, null);
  assert.deepEqual(
    [created.allocatable, created.purchaseChannel, ...state(created)],
    [null, null, null, null],
  );
  remote.customerOrderId = 'ORDER-A';
  remote.orderLines.orderLine[0].item.sku = 'SKU';
  const allocationTime = (await read()).purchaseAssignedAt;
  await persistOrder(stores.A, remote, new Map(), users.admin);
  assert.equal((await read()).purchaseAssignedAt, allocationTime);
  assert.deepEqual(state(await read()), ['已审核', '已分配']);
  assert.deepEqual((await read()).purchaseChannel, ['渠道A']);

  for (const [key, filter, expected] of [
    ['reviewStatus', '已审核', ['A', 'ORPHAN']],
    ['supplierAssignmentStatus', '已分配', ['A']],
    ['reviewStatus', '不可分配', ['B']],
    ['supplierAssignmentStatus', '不可分配', ['B']],
  ]) {
    const result = await request('admin', '/orders?' + new URLSearchParams({ [key]: filter }));
    assert.deepEqual(
      result.data.rows.map((row) => row.id).sort(),
      expected.map((name) => items[name].id).sort(),
    );
  }
  const empty = await request('admin', '/orders?reviewStatus=empty&supplierAssignmentStatus=empty');
  assert.ok(empty.data.rows.some((row) => row.id === fresh.id));
  assert.ok(empty.data.rows.every((row) => !row.reviewStatus && !row.supplierAssignmentStatus));
  assert.equal(
    (await request('operations', '/orders?reviewStatus=' + encodeURIComponent('不可分配'))).data
      .total,
    0,
  );
  for (const route of ['/orders/export', '/orders/export-purchases']) {
    const result = await request(
      'operations',
      route,
      'POST',
      { filters: { supplierAssignmentStatus: '已分配' } },
      true,
    );
    assert.equal(result.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.data);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 2);
    if (route === '/orders/export') {
      const headers = sheet.getRow(1).values;
      assert.equal(sheet.getRow(2).getCell(headers.indexOf('审核状态')).value, '已审核');
      assert.equal(sheet.getRow(2).getCell(headers.indexOf('分配供应商状态')).value, '已分配');
    }
  }
});

test('后台同步不再干扰编辑和采购导入，同字段冲突、旧客户端及权限保护仍生效', async () => {
  const remote = {
    purchaseOrderId: 'CONCURRENCY-PO',
    customerOrderId: 'CONCURRENCY-ORDER',
    orderDate: Date.UTC(2026, 9, 14, 16),
    shipNode: { type: 'SellerFulfilled' },
    shippingInfo: { estimatedShipDate: Date.UTC(2026, 9, 16, 16) },
    orderLines: {
      orderLine: [
        {
          lineNumber: '1',
          item: { sku: 'CONCURRENCY-SKU', productName: '并发验证商品' },
          orderLineQuantity: { amount: '1' },
          charges: {
            charge: [{ chargeType: 'PRODUCT', chargeAmount: { amount: 45.99, currency: 'USD' } }],
          },
          orderLineStatuses: { orderLineStatus: [{ status: 'Acknowledged' }] },
        },
      ],
    },
  };
  const sync = () => persistOrder(stores.A, remote, new Map(), users.admin);
  await sync();
  const item = await OrderItem.findOne({ where: { walmartSku: 'CONCURRENCY-SKU' } });
  const read = async () => (await request('operations', `/orders/${item.id}`)).data;
  const edit = (snapshot, fields, role = 'operations') =>
    request(role, `/orders/${item.id}`, 'PUT', {
      version: snapshot.version,
      fields,
      baseFields: Object.fromEntries(
        Object.keys(fields).map((key) => [key, snapshot[key] ?? null]),
      ),
    });
  const original = await read();
  const originalPurchase = await Purchase.findOne({ where: { itemId: item.id } });
  await sync();
  await sync();
  assert.equal((await read()).version, original.version, '相同金额补零表示不能触发同步版本变化');
  remote.orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0].status = 'Shipped';
  remote.orderLines.orderLine[0].charges.charge[0].chargeAmount.amount = 46.99;
  await sync();
  const synchronized = await read();
  assert.ok(synchronized.version > original.version);
  assert.equal(synchronized.platformOrderStatus, '已发货');
  assert.equal(
    purchaseFingerprint(await Purchase.findOne({ where: { itemId: item.id } })),
    purchaseFingerprint(originalPurchase),
  );
  assert.equal((await edit(original, { purchaseNote: '采购草稿', allocatable: '是' })).status, 200);
  assert.equal((await read()).orderAmount, '46.99', '保存采购不能覆盖同步后的金额');
  assert.equal((await read()).platformOrderStatus, '已发货');

  const overlap = await edit(original, { orderAmount: '47.99' });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.data.details[0].field, 'orderAmount');
  assert.equal((await read()).orderAmount, '46.99');
  const missingBase = await request('operations', `/orders/${item.id}`, 'PUT', {
    version: original.version,
    fields: { purchaseNote: '绕过' },
    baseFields: {},
  });
  assert.equal(missingBase.status, 400);
  assert.equal(
    (
      await request('operations', `/orders/${item.id}`, 'PUT', {
        version: original.version,
        fields: { orderNumber: remote.customerOrderId, purchaseNote: '旧客户端覆盖' },
      })
    ).status,
    409,
  );

  const shared = await read();
  assert.equal((await edit(shared, { purchaseNote: '同事修改' })).status, 200);
  assert.equal((await edit(shared, { merchantName: '另一个字段' })).status, 200);
  const conflict = await edit(shared, { purchaseNote: '覆盖同事' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.details[0].label, '采购备注');
  assert.equal((await read()).purchaseNote, '同事修改');
  assert.equal((await edit(await read(), { purchaseNote: null })).status, 200);
  assert.equal((await read()).purchaseNote, null);
  assert.equal((await edit(await read(), { purchaseNote: '越权' }, 'empty')).status, 403);

  const pending = await preview([
    ['A', remote.customerOrderId, 'CONCURRENCY-SKU', '同步后导入', '是'],
  ]);
  remote.shippingInfo.estimatedShipDate += 86400000;
  await sync();
  const imported = await request(
    'operations',
    `/imports/purchases/${pending.id}/commit`,
    'POST',
    {},
  );
  assert.equal(imported.status, 200);
  assert.equal((await read()).purchaseNote, '同步后导入');
  const collision = await preview([
    ['A', remote.customerOrderId, 'CONCURRENCY-SKU', '不应覆盖', '是'],
  ]);
  assert.equal((await edit(await read(), { purchaseNote: '预览后人工编辑' })).status, 200);
  assert.equal(
    (await request('operations', `/imports/purchases/${collision.id}/commit`, 'POST', {})).status,
    409,
  );
  assert.equal((await read()).purchaseNote, '预览后人工编辑');

  const legacy = await preview([['A', remote.customerOrderId, 'CONCURRENCY-SKU', '旧预览', '是']]);
  const job = await ImportJob.findByPk(legacy.id);
  await job.update({ rows: job.rows.map(({ expectedPurchaseFingerprint, ...row }) => row) });
  remote.shippingInfo.estimatedShipDate += 86400000;
  await sync();
  assert.equal(
    (await request('operations', `/imports/purchases/${legacy.id}/commit`, 'POST', {})).status,
    409,
  );

  const wfsPreview = await preview([
    ['A', remote.customerOrderId, 'CONCURRENCY-SKU', 'WFS不写入', '是'],
  ]);
  const beforeWfs = await read();
  remote.shipNode.type = 'WFS';
  await sync();
  assert.equal((await edit(beforeWfs, { merchantName: 'WFS禁止修改' })).status, 403);
  const skipped = await request(
    'operations',
    `/imports/purchases/${wfsPreview.id}/commit`,
    'POST',
    {},
  );
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.skipped, 1);
  assert.equal((await read()).purchaseNote, '预览后人工编辑');
});

test('采购分配时间仅跟随渠道真实变化，迁移保留空历史，筛选导出遵守时间边界及权限', async () => {
  const query = db.getQueryInterface();
  await query.removeColumn('purchases', 'purchaseAssignedAt');
  await migratePurchaseAssignment();
  await migratePurchaseAssignment();
  assert.equal(
    await Purchase.count({ where: { purchaseAssignedAt: null } }),
    await Purchase.count(),
  );
  await DictionaryOption.create({ kind: 'purchaseChannel', value: '渠道B' });
  await Purchase.update(
    { allocatable: '是', purchaseChannel: null },
    {
      where: { itemId: [items.A.id, items.B.id] },
    },
  );
  const read = async (name = 'A') => (await request('admin', `/orders/${items[name].id}`)).data;
  const edit = async (fields) =>
    request('operations', `/orders/${items.A.id}`, 'PUT', {
      version: (await read()).version,
      fields: { orderNumber: 'ORDER-A', ...fields },
    });
  const assign = async (names, channels) =>
    request('admin', '/assignments', 'POST', {
      items: await Promise.all(
        names.map(async (name) => {
          const row = await read(name);
          return { id: row.id, version: row.version };
        }),
      ),
      purchaseChannel: channels,
    });
  const before = Date.now();
  assert.equal((await assign(['A'], ['渠道A', '渠道B'])).status, 200);
  const first = (await read()).purchaseAssignedAt;
  assert.ok(Date.parse(first) >= before && Date.parse(first) <= Date.now());
  assert.equal((await assign(['A'], ['渠道B', '渠道A'])).status, 200);
  assert.equal((await read()).purchaseAssignedAt, first);
  assert.equal((await edit({ purchaseNote: '只改备注' })).status, 200);
  assert.equal((await read()).purchaseAssignedAt, first);
  assert.equal((await edit({ purchaseAssignedAt: '2000-01-01 00:00:00' })).status, 400);
  assert.equal((await edit({ purchaseChannel: null })).status, 200);
  const cleared = (await read()).purchaseAssignedAt;
  assert.ok(Date.parse(cleared) > Date.parse(first));
  assert.equal((await edit({ purchaseChannel: null })).status, 200);
  assert.equal((await read()).purchaseAssignedAt, cleared);
  assert.equal((await assign(['A', 'B'], ['渠道B'])).status, 200);
  assert.ok(Date.parse((await read()).purchaseAssignedAt) > Date.parse(cleared));
  assert.ok((await read('B')).purchaseAssignedAt);
  const assigned = (await read()).purchaseAssignedAt;
  const pending = await preview([['A', 'ORDER-A', 'SKU', '采购导入不改变渠道计时', '是']]);
  assert.equal(
    (await request('operations', `/imports/purchases/${pending.id}/commit`, 'POST', {})).status,
    200,
  );
  assert.equal((await read()).purchaseAssignedAt, assigned);
  // 第二个目标未审核，整批失败；第一个目标的渠道和时间一并回滚。
  await Purchase.update({ allocatable: null }, { where: { itemId: items.B.id } });
  assert.equal((await assign(['A', 'B'], ['渠道A'])).status, 400);
  assert.equal((await read()).purchaseAssignedAt, assigned);
  assert.deepEqual((await read()).purchaseChannel, ['渠道B']);
  await Purchase.update({ purchaseAssignedAt: null }, { where: {} });
  for (const [name, time] of [
    ['A', '2026-10-15T00:00:00.000+08:00'],
    ['B', '2026-10-15T23:59:59.999+08:00'],
    ['NONE', '2026-10-16T00:00:00.000+08:00'],
  ])
    await Purchase.update(
      { purchaseAssignedAt: new Date(time) },
      { where: { itemId: items[name].id } },
    );
  await migratePurchaseAssignment();
  const filters = {
    purchaseAssignedStartTime: '2026-10-15 00:00:00',
    purchaseAssignedEndTime: '2026-10-15 23:59:59',
  };
  const list = (role, filter) => request(role, '/orders?' + new URLSearchParams(filter));
  assert.deepEqual(
    (await list('admin', filters)).data.rows.map((row) => row.id).sort(),
    [items.A.id, items.B.id].sort(),
  );
  assert.deepEqual(
    (await list('operations', filters)).data.rows.map((row) => row.id),
    [items.A.id],
  );
  assert.equal(
    (await list('admin', { purchaseAssignedEndTime: filters.purchaseAssignedStartTime })).data
      .total,
    1,
  );
  assert.equal(
    (await list('admin', { purchaseAssignedStartTime: '2026-10-16 00:00:00' })).data.total,
    1,
  );
  for (const invalid of [
    { purchaseAssignedStartTime: '2026-02-30 00:00:00' },
    { purchaseAssignedStartTime: '2026-10-15 25:00:00' },
    { purchaseAssignedStartTime: 'bad' },
    {
      purchaseAssignedStartTime: '2026-10-16 00:00:00',
      purchaseAssignedEndTime: filters.purchaseAssignedStartTime,
    },
  ])
    assert.equal((await list('admin', invalid)).status, 400);
  for (const route of ['/orders/export', '/orders/export-purchases']) {
    const exported = await request('admin', route, 'POST', { filters }, true);
    assert.equal(exported.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.data);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 3);
    const column = sheet.getRow(1).values.indexOf('采购分配时间');
    if (route === '/orders/export') {
      assert.ok(column > 0);
      assert.deepEqual([sheet.getCell(2, column).value, sheet.getCell(3, column).value].sort(), [
        '2026-10-15',
        '2026-10-15',
      ]);
    } else assert.equal(column, -1);
  }
});

test('当天渠道汇总按明细多选计数、独立筛选且限制权限，跨日及改分清空正确', async () => {
  const now = Date.parse('2026-10-15T12:00:00+08:00');
  await Purchase.update({ purchaseAssignedAt: null }, { where: {} });
  for (const [name, channel, time] of [
    ['A', ['渠道A', '渠道B', '渠道A'], '2026-10-15T00:00:00+08:00'],
    ['B', ['渠道B'], '2026-10-15T23:59:59.999+08:00'],
    ['NONE', ['渠道A'], '2026-10-14T23:59:59.999+08:00'],
    ['ORPHAN', ['渠道A'], '2026-10-16T00:00:00+08:00'],
  ])
    await Purchase.update(
      { purchaseChannel: channel, purchaseAssignedAt: new Date(time) },
      { where: { itemId: items[name].id } },
    );
  const counts = async (user = users.admin, time = now) =>
    Object.fromEntries(
      (await purchaseAssignmentSummary(user, time)).channels.map((x) => [x.channel, x.count]),
    );
  assert.deepEqual(await counts(), { 渠道B: 2, 渠道A: 1 });
  assert.deepEqual(await counts(users.operations), { 渠道A: 1, 渠道B: 1 });
  assert.deepEqual(await counts(users.empty), {});
  // 前面的角色变更用例会将采购账号改为运营；此处明确验证采购角色的范围。
  assert.deepEqual(await counts({ id: users.purchasing.id, role: 'purchasing' }), await counts());
  assert.deepEqual(await counts(users.admin, Date.parse('2026-10-16T00:00:00+08:00')), {
    渠道A: 1,
  });
  const summary = await purchaseAssignmentSummary(users.admin, now);
  assert.equal(summary.date, '2026-10-15');
  assert.equal(summary.expiresAt, '2026-10-15T16:00:00.000Z');
  await Purchase.update({ purchaseChannel: ['渠道B'] }, { where: { itemId: items.A.id } });
  assert.deepEqual(await counts(), { 渠道B: 2 });
  await Purchase.update({ purchaseChannel: null }, { where: { itemId: items.A.id } });
  assert.deepEqual(await counts(), { 渠道B: 1 });
  // 新接口按真实今天查询；列表无匹配也必须返回权限范围内的当天汇总。
  await Purchase.update(
    { purchaseChannel: ['渠道A'], purchaseAssignedAt: new Date() },
    { where: { itemId: items.A.id } },
  );
  const response = await request('operations', '/orders?q=NO_MATCHING_ORDER_FOR_SUMMARY');
  assert.equal(response.status, 200);
  assert.equal(response.data.total, 0);
  assert.deepEqual(response.data.purchaseAssignmentSummary.channels, [
    { channel: '渠道A', count: 1 },
  ]);
  await Purchase.update(
    { purchaseChannel: ['渠道B'], purchaseAssignedAt: null },
    { where: { itemId: items.A.id } },
  );
  assert.deepEqual((await purchaseAssignmentSummary(users.operations)).channels, []);
});

test('采购平台多选使用维护选项，列表与导出同范围且不扩大运营权限', async () => {
  await DictionaryOption.bulkCreate([
    { kind: 'purchasePlatform', value: '平台甲', active: true },
    { kind: 'purchasePlatform', value: '平台乙', active: true },
    { kind: 'purchasePlatform', value: '停用平台', active: false },
  ]);
  const meta = await request('admin', '/meta');
  const options = meta.data.fields.find((field) => field.key === 'purchasePlatform').options;
  assert.ok(options.includes('平台甲') && options.includes('平台乙'));
  assert.ok(!options.includes('停用平台'));
  for (const [name, platform] of [
    ['A', '平台甲'],
    ['B', '平台乙'],
    ['NONE', '未选平台'],
    ['ORPHAN', null],
  ])
    await Purchase.update({ purchasePlatform: platform }, { where: { itemId: items[name].id } });
  const query = (platforms) =>
    '/orders?' + new URLSearchParams({ purchasePlatforms: JSON.stringify(platforms) });
  const single = await request('admin', query(['平台甲']));
  assert.deepEqual(
    single.data.rows.map((row) => row.id),
    [items.A.id],
  );
  const multi = await request('admin', query(['平台甲', '平台乙', '平台甲']));
  assert.equal(multi.status, 200);
  assert.deepEqual(multi.data.rows.map((row) => row.id).sort(), [items.A.id, items.B.id].sort());
  const own = await request('operations', query(['平台甲', '平台乙']));
  assert.deepEqual(
    own.data.rows.map((row) => row.id),
    [items.A.id],
  );
  assert.equal(
    (await request('admin', query([]))).data.total,
    (await request('admin', '/orders')).data.total,
  );
  for (const invalid of ['bad-json', '{}', '[null]', '[""]'])
    assert.equal(
      (await request('admin', '/orders?' + new URLSearchParams({ purchasePlatforms: invalid })))
        .status,
      400,
    );
  for (const route of ['/orders/export', '/orders/export-purchases']) {
    const result = await request(
      'admin',
      route,
      'POST',
      { filters: { purchasePlatforms: ['平台甲', '平台乙'] } },
      true,
    );
    assert.equal(result.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.data);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 3);
    assert.deepEqual([sheet.getCell('A2').value, sheet.getCell('A3').value].sort(), ['A', 'B']);
  }
});
