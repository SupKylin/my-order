import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { DataTypes } from 'sequelize';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  Order,
  OrderItem,
  Purchase,
  DictionaryOption,
  Upload,
  ImportJob,
  AuditLog,
  PurchaseAfterSaleRecord,
} from '../src/models.js';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { migrateUserRoles } from '../src/migrations/user-roles.js';
import { drainAudit } from '../src/services/audit.js';
import { prepareImport } from '../src/services/imports.js';
import { ensureStorage, uploadPath } from '../src/services/storage.js';
import { ROLES } from '../src/fields.js';

// 仅一次性隔离库；不读写真实业务数据、不调用 Walmart 或企业微信。
const isolated = /^my_order_supervisor_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
const users = {},
  sessions = {},
  items = {},
  stores = {},
  files = [];
let connection,
  created = false,
  server,
  base,
  legacyUsers,
  migratedUsers,
  migrationWrites = 0;
async function request(role, path, method = 'GET', body, binary = false) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...sessions[role],
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json(),
    headers: response.headers,
  };
}
async function read(name) {
  return (await request('supervisor', `/orders/${items[name].id}`)).data;
}
async function edit(name, fields, role = 'supervisor') {
  const row = await read(name);
  return request(role, `/orders/${row.id}`, 'PUT', {
    version: row.version,
    baseFields: row,
    fields,
  });
}
async function preview(role, names) {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('采购');
  const keys = ['shopName', 'orderNumber', 'walmartSku', 'purchaseStatus', 'purchaseNote'];
  sheet.addRow(keys);
  names.forEach((name) =>
    sheet.addRow([
      name === 'WFS' ? 'B' : name,
      `ORDER-${name}`,
      name === 'WFS' ? 'WFS-SKU' : 'SKU',
      '采购成功（未出跟踪号）',
      `import-${role}`,
    ]),
  );
  const id = randomUUID();
  const upload = await Upload.create({
    id,
    filename: `${id}.xlsx`,
    originalName: '主管权限.xlsx',
    kind: 'excel',
    uploadedBy: users[role].id,
  });
  files.push(uploadPath(upload));
  await book.xlsx.writeFile(uploadPath(upload));
  return prepareImport(
    {
      sources: [
        {
          uploadId: id,
          sheetName: '采购',
          template: {
            name: '主管模板',
            headerRow: 1,
            mappings: keys.map((field) => ({ field, header: field })),
          },
        },
      ],
    },
    users[role],
    'purchase',
  );
}
before(async () => {
  if (!isolated) return;
  config.wecom.webhook = '';
  config.wecom.appUrl = '';
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
  const query = db.getQueryInterface();
  await query.changeColumn('users', 'role', {
    type: DataTypes.ENUM('operations', 'purchasing', 'admin'),
    allowNull: false,
  });
  const passwordHash = await hashPassword('Supervisor-test-123');
  for (const role of ['admin', 'operations', 'purchasing'])
    users[role] = await User.create({
      username: role,
      displayName: ROLES[role],
      role,
      passwordHash,
    });
  legacyUsers = await User.findAll({ raw: true, order: [['id', 'ASC']] });
  const change = query.changeColumn;
  query.changeColumn = function (...args) {
    migrationWrites++;
    return change.apply(this, args);
  };
  try {
    await migrateUserRoles();
    await migrateUserRoles();
  } finally {
    query.changeColumn = change;
  }
  migratedUsers = await User.findAll({ raw: true, order: [['id', 'ASC']] });
  users.supervisor = await User.create({
    username: 'supervisor',
    displayName: '测试主管',
    role: 'supervisor',
    passwordHash,
  });
  for (const name of ['A', 'B'])
    stores[name] = await Store.create({
      systemStoreName: name,
      walmartStoreName: name,
      ownerId: users[name === 'A' ? 'operations' : 'admin'].id,
      clientId: 'test-id',
      clientSecret: 'test-secret',
    });
  for (const name of ['A', 'B', 'WFS']) {
    const order = await Order.create({ orderNumber: `ORDER-${name}` });
    items[name] = await OrderItem.create({
      orderId: order.id,
      shopName: name === 'WFS' ? 'B' : name,
      walmartSku: name === 'WFS' ? 'WFS-SKU' : 'SKU',
      purchaseChannelKey: 'test',
      orderDate: '2026-11-07',
      orderAmount: 100,
      fulfillmentParty: name === 'WFS' ? 'WFSFulfilled' : 'SellerFulfilled',
      platformOrderStatus: '已确认',
    });
    await Purchase.create({ itemId: items[name].id, allocatable: '是' });
  }
  for (const [kind, values] of Object.entries({
    purchaseChannel: ['渠道A', '渠道B'],
    purchaseStatus: ['采购中', '采购失败', '采购成功（未出跟踪号）'],
    orderStatus: ['待处理'],
    purchasePlatform: ['Amazon'],
  }))
    await DictionaryOption.bulkCreate(values.map((value) => ({ kind, value })));
  await ensureStorage();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const role of Object.keys(users)) {
    const login = await request(role, '/auth/login', 'POST', {
      username: role,
      password: 'Supervisor-test-123',
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

test('旧角色原值保留，主管ENUM增量升级幂等；管理员可创建、筛选主管', async () => {
  assert.deepEqual(migratedUsers, legacyUsers);
  assert.equal(migrationWrites, 1);
  assert.equal((await request('supervisor', '/meta')).data.roles.supervisor, '主管');
  const made = await request('admin', '/users', 'POST', {
    username: 'new-supervisor',
    displayName: '新主管',
    role: 'supervisor',
    active: true,
    password: 'Supervisor-test-123',
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const filtered = await request('admin', '/management/users?role=supervisor');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.total, 2);
  assert.ok(filtered.data.rows.every((row) => row.role === 'supervisor'));
});

test('主管三个维护菜单的旧接口、分页及写接口均拒绝，不能借kind参数或角色提升绕过', async () => {
  const paths = [
    ['/users', 'GET'],
    ['/users', 'POST'],
    [`/users/${users.supervisor.id}`, 'PUT'],
    ['/management/users', 'GET'],
    ['/management/users/batch-delete', 'POST'],
    ...['purchaseChannel', 'purchaseStatus'].flatMap((kind) => [
      [`/dictionaries/${kind}`, 'GET'],
      [`/dictionaries/${kind}`, 'POST'],
      [`/dictionaries/${kind}/1`, 'PUT'],
      [`/dictionaries/${kind}/1`, 'DELETE'],
      [`/management/dictionaries?kind=${kind}`, 'GET'],
      ['/management/dictionaries/batch-delete?kind=orderStatus', 'POST', { kind, rows: [] }],
    ]),
  ];
  for (const [path, method, body] of paths) {
    const result = await request(
      'supervisor',
      path,
      method,
      method === 'GET' ? undefined : body || { role: 'admin' },
    );
    assert.equal(result.status, 403, `${method} ${path}: ${JSON.stringify(result.data)}`);
  }
  assert.equal((await users.supervisor.reload()).role, 'supervisor');
});

test('主管开放其他菜单、全部订单和金额；运营仍只能看本人店铺', async () => {
  for (const path of [
    '/home',
    '/stores',
    '/management/stores',
    '/templates',
    '/imports',
    '/audit-logs',
    '/risk-addresses',
    '/purchase-after-sales',
    '/dictionaries/orderStatus',
    '/dictionaries/purchasePlatform',
  ])
    assert.equal((await request('supervisor', path)).status, 200, path);
  const home = (await request('supervisor', '/home')).data;
  assert.deepEqual(
    home.stores.map((s) => s.name),
    ['A', 'B'],
  );
  assert.equal((await request('supervisor', '/orders')).data.total, 3);
  assert.equal(Number((await read('B')).orderAmount), 100);
  assert.equal((await request('operations', '/orders')).data.total, 1);
  assert.equal((await request('operations', `/orders/${items.B.id}`)).status, 403);
  const owners = (await request('supervisor', '/order-owners')).data;
  assert.equal(owners.length, 5);
  assert.ok(
    owners.every((row) => Object.keys(row).sort().join(',') === 'active,displayName,id,username'),
  );
  for (const path of ['/orders/export', '/orders/export-purchases']) {
    const exported = await request('supervisor', path, 'POST', { filters: {} }, true);
    assert.equal(exported.status, 200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(exported.data);
    assert.equal(book.worksheets[0].rowCount, 4);
  }
});

test('主管可维护店铺归属、佣金、允许的字典和共享模板，但不能管理账号', async () => {
  const row = (await request('supervisor', '/stores')).data.find((s) => s.id === stores.B.id);
  const result = await request('supervisor', `/stores/${row.id}`, 'PUT', {
    ...row,
    ownerId: users.supervisor.id,
    commissionRate: 15,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.ownerId, users.supervisor.id);
  assert.equal(Number(result.data.commissionRate), 15);
  for (const kind of ['orderStatus', 'purchasePlatform'])
    assert.equal(
      (
        await request('supervisor', `/dictionaries/${kind}`, 'POST', {
          value: '主管新增',
          active: true,
          sortOrder: 10,
        })
      ).status,
      201,
    );
  const template = await request('supervisor', '/templates', 'POST', {
    name: '共享主管模板',
    headerRow: 1,
    mappings: ['shopName', 'orderNumber', 'walmartSku', 'purchaseNote'].map((field) => ({
      field,
      header: field,
    })),
  });
  assert.equal(template.status, 201, JSON.stringify(template.data));
  assert.equal(
    (await request('operations', `/templates/${template.data.id}/copy`, 'POST', {})).status,
    201,
  );
});

test('主管可单条和跨店批量分配渠道、修改采购状态；运营仍禁止', async () => {
  assert.equal(
    (await edit('B', { purchaseStatus: '采购中', purchaseChannel: ['渠道A'] })).status,
    200,
  );
  const rows = await Promise.all(['A', 'B'].map(read));
  assert.equal(
    (
      await request('supervisor', '/assignments', 'POST', {
        items: rows.map(({ id, version }) => ({ id, version })),
        purchaseChannel: ['渠道A', '渠道B'],
      })
    ).status,
    200,
  );
  const latest = await Promise.all(['A', 'B'].map(read));
  const status = await request('supervisor', '/orders/batch-purchase-status', 'POST', {
    items: latest.map(({ id, version }) => ({ id, version })),
    purchaseStatus: '采购成功（未出跟踪号）',
  });
  assert.equal(status.status, 200, JSON.stringify(status.data));
  for (const name of ['A', 'B']) {
    const row = await read(name);
    assert.deepEqual(row.purchaseChannel, ['渠道A', '渠道B']);
    assert.ok(row.purchaseConfirmedAt);
    assert.ok(row.purchaseAssignedAt);
  }
  assert.equal((await edit('A', { purchaseStatus: '采购失败' }, 'operations')).status, 403);
  assert.equal((await edit('A', { purchaseChannel: null }, 'operations')).status, 403);
});

test('主管导入可跨店更新采购状态，但仍跳过WFS；普通角色导入限制不变', async () => {
  await edit('B', { purchaseStatus: '采购失败' });
  const job = await preview('supervisor', ['A', 'B', 'WFS']);
  assert.equal(job.updated, 2);
  assert.equal(job.skipped, 1);
  assert.match(job.skippedRows[0].reason, /WFS/);
  const done = await request('supervisor', `/imports/purchases/${job.id}/commit`, 'POST', {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.updated, 2);
  assert.equal((await read('WFS')).purchaseStatus, null);
  assert.equal((await read('B')).purchaseStatus, '采购成功（未出跟踪号）');
  const own = await preview('operations', ['A', 'B']);
  assert.equal(own.updated, 1);
  assert.equal(own.skipped, 1);
  assert.ok(own.warnings.some((w) => /无权修改采购状态/.test(w.message)));
});

test('主管可查看全部日志和导入结果，但不能提交别人的预览、修改日志或删除导入记录', async () => {
  const job = await preview('operations', ['A']);
  const stored = await ImportJob.findByPk(job.id);
  assert.equal((await request('supervisor', `/imports/${job.id}`)).status, 200);
  assert.equal(
    (await request('supervisor', `/uploads/excel/${stored.uploadId}/inspect`)).status,
    200,
  );
  assert.equal(
    (await request('supervisor', `/imports/purchases/${job.id}/commit`, 'POST', {})).status,
    403,
  );
  assert.equal(
    (await request('supervisor', '/management/imports')).data.total,
    await ImportJob.count(),
  );
  assert.equal((await request('supervisor', '/imports')).data.length, await ImportJob.count());
  assert.equal((await request('purchasing', `/imports/${job.id}`)).status, 403);
  await drainAudit();
  const logs = await request('supervisor', `/audit-logs?userId=${users.admin.id}`);
  assert.equal(logs.status, 200);
  assert.ok(logs.data.rows.length > 0);
  assert.ok(logs.data.rows.every((row) => row.userId === users.admin.id));
  assert.equal((await request('supervisor', `/audit-logs/${logs.data.rows[0].id}`)).status, 200);
  assert.equal((await request('operations', `/audit-logs?userId=${users.admin.id}`)).status, 403);
  for (const [path, method] of [
    ['/audit-logs', 'POST'],
    ['/audit-logs/1', 'PUT'],
    ['/audit-logs/1', 'DELETE'],
    ['/management/imports/batch-delete', 'POST'],
  ])
    assert.equal((await request('supervisor', path, method, {})).status, 403);
});

test('主管可创建、回复、反馈、完毕和重开全店工单，发送人角色正确且WFS仍只读', async () => {
  const message = (content) => ({ content, images: [], requestId: randomUUID() });
  const made = await request('supervisor', '/purchase-after-sales', 'POST', {
    itemId: items.B.id,
    ...message('主管售后'),
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const path = `/purchase-after-sales/${made.data.id}`;
  assert.equal(
    (await request('supervisor', `${path}/records`, 'POST', message('跟进'))).status,
    201,
  );
  assert.equal((await request('supervisor', `${path}/supplier-feedback`, 'POST', {})).status, 200);
  assert.equal((await request('operations', `${path}/supplier-feedback`, 'POST', {})).status, 403);
  const record = await PurchaseAfterSaleRecord.findOne({ where: { ticketId: made.data.id } });
  assert.equal(record.actorRole, 'supervisor');
  const refundVersion = (await request('supervisor', path)).data.version;
  assert.equal(
    (
      await request('supervisor', `${path}/refund-amount`, 'PUT', {
        version: refundVersion,
        purchaseRefundAmount: '0',
      })
    ).status,
    200,
  );
  for (const status of ['completed', 'open']) {
    const current = (await request('supervisor', path)).data;
    const result = await request('supervisor', `${path}/status`, 'POST', {
      status,
      version: current.version,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  assert.equal(
    (
      await request('supervisor', '/purchase-after-sales', 'POST', {
        itemId: items.WFS.id,
        ...message('禁止'),
      })
    ).status,
    403,
  );
});

test('WFS修改、分配及批量修改整批拒绝，订单不得人工新增或删除', async () => {
  assert.equal((await edit('WFS', { purchaseNote: '禁止写入' })).status, 403);
  const before = await read('A');
  const wfs = await read('WFS');
  for (const [path, fields] of [
    ['/assignments', { purchaseChannel: ['渠道B'] }],
    ['/orders/batch-purchase-status', { purchaseStatus: '采购失败' }],
  ]) {
    assert.equal(
      (
        await request('supervisor', path, 'POST', {
          items: [
            { id: before.id, version: before.version },
            { id: wfs.id, version: wfs.version },
          ],
          ...fields,
        })
      ).status,
      403,
    );
    assert.equal((await read('A')).version, before.version);
  }
  for (const [path, method] of [
    ['/orders', 'POST'],
    [`/orders/${before.id}`, 'DELETE'],
    ['/orders/batch-delete', 'POST'],
  ])
    assert.equal((await request('supervisor', path, method, {})).status, 403);
});

test('主管不是最高管理员替代人；角色更改在已有会话中立即生效', async () => {
  const admin = await users.admin.reload();
  const changed = await request('admin', `/users/${admin.id}`, 'PUT', {
    displayName: admin.displayName,
    role: 'supervisor',
    active: true,
    updatedAt: admin.updatedAt,
  });
  assert.equal(changed.status, 400, JSON.stringify(changed.data));
  assert.equal((await users.admin.reload()).role, 'admin');
  await users.supervisor.update({ role: 'operations' });
  assert.equal((await request('supervisor', '/stores')).status, 403);
  assert.equal((await request('supervisor', '/orders')).data.total, 2);
  assert.equal((await request('supervisor', '/assignments', 'POST', {})).status, 403);
  await users.supervisor.update({ role: 'supervisor' });
  assert.equal((await request('supervisor', '/stores')).status, 200);
});
