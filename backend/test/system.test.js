import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { Op } from 'sequelize';
import { createApp } from '../src/app.js';
import {
  db,
  Order,
  OrderItem,
  Purchase,
  User,
  ImportJob,
  ImportTemplate,
  AuditLog,
  Upload,
  Session,
  DictionaryOption,
} from '../src/models.js';
import { config } from '../src/config.js';
import { ensureStorage, uploadPath, imageDir } from '../src/services/storage.js';
import { validatePatch } from '../src/validation.js';
import { loadWorkbook, extractRows } from '../src/lib/excel/index.js';
import {
  alignMappings,
  suggestedMappings,
  mappingIssues,
  selectedMappings,
} from '../../frontend/src/mapping.js';
import { fields } from '../src/fields.js';
import { money } from '../../frontend/src/utils/format.js';
import { purchaseWarning } from '../../frontend/src/utils/purchaseWarning.js';
import { migrateOrderIdentity } from '../src/migrations/order-identity.js';
import { orderIdentityKey } from '../src/lib/order-identity.js';
const prefix = `QA${Date.now()}`;
const identityChannels = [`${prefix}-渠道B`, `${prefix}-渠道C`];
let server, base, cookie, csrf, admin, initialUploads, startedAt, reusableTemplateId;
const userIds = [],
  orderNumbers = [],
  jobIds = [],
  templateIds = [],
  dictionaryIds = [];
async function request(url, method = 'GET', body, credentials = { cookie, csrf }) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
  if (credentials?.cookie) headers.Cookie = credentials.cookie;
  if (credentials?.csrf) headers['X-CSRF-Token'] = credentials.csrf;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, {
    method,
    headers,
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data, headers: response.headers };
}
async function makeWorkbook(headers, rows, { image = false, headerRow = 2 } = {}) {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet('每日订单');
  if (headerRow === 2) sheet.addRow(['每日订单导入']);
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  if (image) {
    const buffer = await sharp({
      create: { width: 50, height: 50, channels: 3, background: '#087f79' },
    })
      .png()
      .toBuffer();
    const id = workbook.addImage({ buffer, extension: 'png' });
    sheet.addImage(id, { tl: { col: 5, row: headerRow }, ext: { width: 45, height: 45 } });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function previewRows(headers, rows, keys, options = {}) {
  const buffer = await makeWorkbook(headers, rows, options),
    body = new FormData();
  body.append('file', new Blob([buffer]), `${prefix}.xlsx`);
  const upload = await request('/api/uploads/excel', 'POST', body);
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const template = {
    name: prefix,
    sheetName: '每日订单',
    headerRow: options.headerRow || 2,
    mappings: keys.map((field, index) => ({ field, column: index + 1, header: headers[index] })),
  };
  const preview = await request('/api/imports/preview', 'POST', {
    uploadId: upload.data.id,
    template,
  });
  if (preview.data?.id) jobIds.push(preview.data.id);
  return { ...preview, upload: upload.data, template };
}
before(async () => {
  startedAt = new Date();
  await db.authenticate();
  await ensureStorage();
  initialUploads = new Set((await Upload.findAll({ attributes: ['id'] })).map((u) => u.id));
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const result = await request(
    '/api/auth/login',
    'POST',
    { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD },
    {},
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  cookie = result.headers.get('set-cookie').split(';')[0];
  csrf = result.data.csrfToken;
  admin = result.data.user;
  for (const value of identityChannels) {
    const option = await request('/api/dictionaries/purchaseChannel', 'POST', {
      value,
      sortOrder: 1,
      active: true,
    });
    assert.equal(option.status, 201);
    dictionaryIds.push(option.data.id);
  }
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await ImportJob.destroy({ where: { id: { [Op.in]: jobIds } } });
  await ImportTemplate.destroy({ where: { id: { [Op.in]: templateIds } } });
  await DictionaryOption.destroy({ where: { id: { [Op.in]: dictionaryIds } } });
  const testOrders = await Order.findAll({
    where: { orderNumber: { [Op.in]: orderNumbers } },
    attributes: ['id'],
  });
  const testItemIds = (
    await OrderItem.findAll({
      where: { orderId: { [Op.in]: testOrders.map((o) => o.id) } },
      attributes: ['id'],
    })
  ).map((x) => x.id);
  await Order.destroy({ where: { orderNumber: { [Op.in]: orderNumbers } } });
  await User.destroy({ where: { id: { [Op.in]: userIds } } });
  const testLogs = await AuditLog.findAll({ where: { createdAt: { [Op.gte]: startedAt } } });
  for (const log of testLogs) {
    const belongs =
      jobIds.includes(log.entityId) ||
      (['edit_item', 'create_item'].includes(log.action) &&
        testItemIds.includes(Number(log.entityId))) ||
      (['create_user', 'edit_user'].includes(log.action) &&
        userIds.includes(Number(log.entityId))) ||
      (['assign_items', 'batch_update_order_status'].includes(log.action) &&
        log.details?.itemIds?.length &&
        log.details.itemIds.every((id) => testItemIds.includes(id)));
    if (belongs) await log.destroy();
  }
  const uploads = await Upload.findAll({ where: { originalName: { [Op.like]: `${prefix}%` } } });
  for (const upload of uploads) {
    if (initialUploads.has(upload.id)) continue;
    await fs.rm(uploadPath(upload), { force: true });
    if (upload.kind === 'image')
      await fs.rm(path.join(imageDir, `${upload.id}.thumb.webp`), { force: true });
    await upload.destroy();
  }
  const sessions = await Session.findAll();
  for (const session of sessions) {
    const data = JSON.parse(session.data);
    if (userIds.includes(data.userId) || session.data.includes(csrf)) await session.destroy();
  }
  await db.close();
});
test('自动映射不猜测重复来源，草稿校验准确定位重复和空关系', () => {
  const columns = [
    { column: 1, header: '订单号', suggestedField: 'orderNumber' },
    { column: 2, header: 'SKU', suggestedField: 'sku' },
    { column: 3, header: '商品名称', suggestedField: 'productName' },
    { column: 4, header: '商品名', suggestedField: 'productName' },
    { column: 5, header: '自定义说明', suggestedField: '' },
  ];
  const automatic = suggestedMappings(columns);
  assert.deepEqual(
    automatic.map((mapping) => mapping.field),
    ['orderNumber', 'sku', '', '', ''],
  );
  assert.deepEqual(
    automatic.map((mapping) => mapping.header),
    columns.map((column) => column.header),
  );
  assert.equal(mappingIssues(automatic, fields).length, 0);
  const duplicate = mappingIssues(
    [...automatic, { column: 3, header: '其他单号', field: 'orderNumber' }],
    fields,
  );
  assert.equal(duplicate[0].index, 5);
  assert.match(duplicate[0].message, /订单号.*第 1 条/);
  const drafts = [
    ...automatic,
    { column: null, header: '', field: '' },
    { column: 1, header: '', field: null },
  ];
  assert.deepEqual(mappingIssues(drafts, fields), []);
  assert.deepEqual(selectedMappings(drafts), automatic.slice(0, 2));
  assert.deepEqual(mappingIssues(automatic.slice(0, 1), fields), []);
  assert.match(mappingIssues(automatic.slice(1), fields)[0].message, /订单号/);
});

test('复用模板保留空目标，展示新表头且不自动替用户选择字段', () => {
  const mappings = [
    { column: 1, header: '订单号', field: 'orderNumber' },
    { column: 2, header: 'SKU', field: 'sku' },
    { column: 3, header: '数量', field: '' },
  ];
  const aligned = alignMappings(mappings, [
    { column: 1, header: 'SKU', suggestedField: 'sku' },
    { column: 2, header: '订单号', suggestedField: 'orderNumber' },
    { column: 3, header: '数量', suggestedField: 'quantity' },
    { column: 4, header: '采购备注', suggestedField: 'purchaseNote' },
  ]);
  assert.deepEqual(aligned.mappings, [
    { column: 1, header: 'SKU', field: 'sku' },
    { column: 2, header: '订单号', field: 'orderNumber' },
    { column: 3, header: '数量', field: '' },
    { column: 4, header: '采购备注', field: '' },
  ]);
  assert.deepEqual(aligned.missing, []);
});

test('模板新增及删除映射可持久化，重复关系返回具体原因且不改写模板', async () => {
  const mappings = [
    { column: 1, header: '订单号', field: 'orderNumber' },
    { column: 2, header: 'SKU', field: 'sku' },
  ];
  const payload = { name: `${prefix}-MAPPING`, sheetName: '每日订单', headerRow: 1, mappings };
  const created = await request('/api/templates', 'POST', payload);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  templateIds.push(created.data.id);
  const url = `/api/templates/${created.data.id}`;
  const extra = { column: 3, header: '商品名称', field: 'productName' };
  assert.equal(
    (await request(url, 'PUT', { ...payload, mappings: [...mappings, extra] })).status,
    200,
  );
  let saved = (await request('/api/templates')).data.find((row) => row.id === created.data.id);
  assert.deepEqual(saved.mappings, [...mappings, extra]);
  const duplicate = await request(url, 'PUT', {
    ...payload,
    mappings: [...mappings, { ...extra, field: 'orderNumber' }],
  });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.data.message, /第 3 条.*订单号.*第 1 条/);
  const duplicateColumn = await request(url, 'PUT', {
    ...payload,
    mappings: [...mappings, { ...extra, column: 1 }],
  });
  assert.match(duplicateColumn.data.message, /Excel 第 1 列/);
  const invalid = await request(url, 'PUT', {
    ...payload,
    mappings: [...mappings, { ...extra, field: 'unknown' }],
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.message, /第 3 条.*有效/);
  saved = (await request('/api/templates')).data.find((row) => row.id === created.data.id);
  assert.deepEqual(saved.mappings, [...mappings, extra]);
  assert.equal((await request(url, 'PUT', payload)).status, 200);
  saved = (await request('/api/templates')).data.find((row) => row.id === created.data.id);
  assert.deepEqual(saved.mappings, mappings);
  assert.equal(
    (await request(url, 'PUT', { ...payload, mappings: [mappings[1], extra] })).status,
    400,
  );
});

test('未登录拦截、七天会话与 CSRF 防护', async () => {
  assert.equal((await request('/api/orders', 'GET', null, {})).status, 401);
  const me = await request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.ok(me.data.expiresAt - Date.now() > 6.9 * 24 * 3600 * 1000);
  assert.ok(me.data.expiresAt - Date.now() <= config.sessionMs);
  assert.equal((await request('/api/orders', 'POST', { fields: {} }, { cookie })).status, 403);
  const bad = await request(
    '/api/auth/login',
    'POST',
    { username: 'missing', password: 'wrong' },
    {},
  );
  assert.equal(bad.status, 401);
});
test('字段定义完整、下拉选项与严格格式校验', async () => {
  const meta = await request('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.data.fields.length, 46);
  assert.ok(meta.data.fields.some((field) => field.key === 'walmartSku'));
  assert.ok(meta.data.fields.some((field) => field.key === 'purchaseSku'));
  assert.deepEqual(meta.data.fields.find((f) => f.key === 'settlement').options, [
    '已结算',
    '未结算',
  ]);
  assert.throws(() => validatePatch({ orderDate: '2026-02-30' }));
  assert.throws(() => validatePatch({ quantity: 0 }));
  assert.throws(() => validatePatch({ purchaseStatus: '随意填写' }));
  assert.throws(() => validatePatch({ unexpected: '不允许' }));
  assert.deepEqual(
    validatePatch({ tax: 0, productName: ' ', purchaseNote: null }, { skipBlank: true }),
    { tax: '0.00' },
  );
});
test('三个角色均可操作账号、独立商品采购分配及最后一个总账号保护', async () => {
  for (const role of ['operations', 'purchasing']) {
    const r = await request('/api/users', 'POST', {
      username: `${prefix}_${role}`,
      displayName: role === 'operations' ? '测试运营' : '测试采购',
      role,
      password: 'TestOnly!2026',
      active: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    userIds.push(r.data.id);
  }
  const login = await request(
    '/api/auth/login',
    'POST',
    { username: `${prefix}_operations`, password: 'TestOnly!2026' },
    {},
  );
  const operator = {
    cookie: login.headers.get('set-cookie').split(';')[0],
    csrf: login.data.csrfToken,
  };
  assert.equal((await request('/api/users', 'GET', null, operator)).status, 200);
  if ((await User.count({ where: { role: 'admin', active: true } })) === 1)
    assert.equal((await request(`/api/users/${admin.id}`, 'PUT', { active: false })).status, 400);
  const orderNumber = `${prefix}-MAIN`;
  orderNumbers.push(orderNumber);
  const a = await request('/api/orders', 'POST', {
    fields: {
      orderNumber,
      sku: 'SKU-A',
      shopName: '测试店铺',
      productName: '保留的名称',
      quantity: 2,
      purchaseNote: '旧采购备注',
      purchaseAmount: '12.30',
      merchantName: '单一供应商',
      orderStatus: '采购成功虚拟单号发货',
      allocatable: '是',
    },
  });
  const b = await request('/api/orders', 'POST', {
    fields: {
      orderNumber,
      sku: 'SKU-B',
      purchaseChannel: [identityChannels[0]],
      productName: '不受影响的另一个商品',
      quantity: 1,
      purchaseNote: 'B 的采购记录',
    },
  });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(b.status, 201);
  assert.equal(
    (
      await request('/api/assignments', 'POST', {
        items: [{ id: a.data.id, version: a.data.version }],
        assignedTo: userIds[1],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/api/assignments', 'POST', {
        items: [{ id: b.data.id, version: b.data.version }],
        assignedTo: userIds[0],
      })
    ).status,
    200,
  );
  const a2 = (await request(`/api/orders/${a.data.id}`)).data,
    b2 = (await request(`/api/orders/${b.data.id}`)).data;
  assert.equal(a2.assignedTo, userIds[1]);
  assert.equal(b2.assignedTo, userIds[0]);
  assert.equal(
    (
      await request('/api/assignments', 'POST', {
        items: [{ id: a.data.id, version: 1 }],
        assignedTo: userIds[0],
      })
    ).status,
    409,
  );
});
test('批量更改订单状态只影响勾选明细，版本冲突时整批回滚', async () => {
  const number = `${prefix}-BATCH-STATUS`;
  orderNumbers.push(number);
  const created = [];
  for (const sku of ['STATUS-A', 'STATUS-B', 'STATUS-C']) {
    const response = await request('/api/orders', 'POST', {
      fields: { orderNumber: number, sku },
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    created.push(response.data);
  }
  const entries = created.slice(0, 2).map(({ id, version }) => ({ id, version }));
  assert.equal(
    (await request('/api/orders/batch-status', 'POST', { items: entries, orderStatus: '砍单' }, {}))
      .status,
    401,
  );
  for (const items of [[], [null], [entries[0], entries[0]]]) {
    assert.equal(
      (await request('/api/orders/batch-status', 'POST', { items, orderStatus: '砍单' })).status,
      400,
    );
  }
  for (const orderStatus of ['', '不存在的状态']) {
    assert.equal(
      (await request('/api/orders/batch-status', 'POST', { items: entries, orderStatus })).status,
      400,
    );
  }
  assert.equal(
    (
      await request('/api/orders/batch-status', 'POST', {
        items: [entries[0], { id: 2147483647, version: 1 }],
        orderStatus: '砍单',
      })
    ).status,
    404,
  );
  assert.equal((await request(`/api/orders/${created[0].id}`)).data.orderStatus, null);
  const edit = await request(`/api/orders/${created[1].id}`, 'PUT', {
    version: created[1].version,
    fields: { orderNumber: number, sku: 'STATUS-B', productName: '刚被修改' },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(
    (await request('/api/orders/batch-status', 'POST', { items: entries, orderStatus: '砍单' }))
      .status,
    409,
  );
  assert.equal((await request(`/api/orders/${created[0].id}`)).data.orderStatus, null);
  assert.equal((await request(`/api/orders/${created[0].id}`)).data.version, created[0].version);
  const current = await request(`/api/orders/${created[1].id}`);
  const updated = await request('/api/orders/batch-status', 'POST', {
    items: [entries[0], { id: current.data.id, version: current.data.version }],
    orderStatus: '砍单',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.updated, 2);
  for (const row of created.slice(0, 2)) {
    const result = await request(`/api/orders/${row.id}`);
    assert.equal(result.data.orderStatus, '砍单');
    assert.equal(result.data.version, row.version + (row.id === created[1].id ? 2 : 1));
  }
  assert.equal((await request(`/api/orders/${created[2].id}`)).data.orderStatus, null);
  const logs = await AuditLog.findAll({ where: { action: 'batch_update_order_status' } });
  assert.ok(
    logs.some(
      (log) =>
        log.userId === admin.id &&
        log.details?.orderStatus === '砍单' &&
        entries.every(({ id }) => log.details.itemIds.includes(id)),
    ),
  );
});

test('Excel 表头映射、嵌入图片、非空更新、零值更新与其他渠道明细保留', async () => {
  const orderNumber = orderNumbers[0];
  const headers = [
    '平台单号',
    '商品编码',
    '商品名',
    '采购备注',
    '采购金额',
    '产品图',
    '状态',
    '采购渠道',
    '店铺名',
  ];
  const keys = [
    'orderNumber',
    'sku',
    'productName',
    'purchaseNote',
    'purchaseAmount',
    'productImage',
    'orderStatus',
    'purchaseChannel',
    'shopName',
  ];
  const p = await previewRows(
    headers,
    [
      [orderNumber, 'SKU-A', '', '新的采购备注', 0, '', '采购成功真实单号发货', '', '测试店铺'],
      [orderNumber, '000123', '新增的商品', '', '', '', '', identityChannels[1]],
    ],
    keys,
    { image: true },
  );
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.errorCount, 0, JSON.stringify(p.data.errors));
  assert.equal(p.data.added, 1);
  assert.equal(p.data.updated, 1);
  const imagePath = p.data.rows[0].patch.productImage;
  assert.match(imagePath, /^\/uploads\/images\//);
  const saved = await request('/api/templates', 'POST', { ...p.template, name: `${prefix}-映射` });
  assert.equal(saved.status, 201);
  templateIds.push(saved.data.id);
  reusableTemplateId = saved.data.id;
  const commit = await request(`/api/imports/${p.data.id}/commit`, 'POST');
  assert.equal(commit.status, 200, JSON.stringify(commit.data));
  assert.equal(commit.data.added, 1);
  assert.equal(commit.data.updated, 1);
  assert.equal(
    (await request(`/api/imports/${p.data.id}/commit`, 'POST')).data.alreadyCompleted,
    true,
  );
  const list = await request('/api/orders?q=' + encodeURIComponent(orderNumber));
  assert.equal(list.data.total, 3);
  const a = list.data.rows.find((r) => r.sku === 'SKU-A'),
    b = list.data.rows.find((r) => r.sku === 'SKU-B'),
    c = list.data.rows.find((r) => r.sku === '000123');
  assert.equal(a.productName, '保留的名称');
  assert.equal(a.purchaseNote, '新的采购备注');
  assert.equal(a.purchaseAmount, '0');
  assert.equal(a.merchantName, '单一供应商');
  assert.equal(a.assignedTo, userIds[1]);
  assert.equal(a.orderStatus, '采购成功真实单号发货');
  assert.equal(a.productImage, imagePath);
  assert.equal(b.productName, '不受影响的另一个商品');
  assert.equal(b.purchaseNote, 'B 的采购记录');
  assert.equal(b.assignedTo, userIds[0]);
  assert.equal(c.sku, '000123');
  const imageResponse = await fetch(base + imagePath);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/webp');
  const thumbResponse = await fetch(base + imagePath.replace('.webp', '.thumb.webp'));
  assert.equal(thumbResponse.status, 200);
});
test('未映射字段和采购空白保持原值，人工编辑允许清空', async () => {
  const p = await previewRows(
    ['单号', 'SKU', '备注', '店铺名'],
    [[orderNumbers[0], 'SKU-A', '   ', '测试店铺']],
    ['orderNumber', 'sku', 'purchaseNote', 'shopName'],
  );
  assert.equal(p.data.errorCount, 0);
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const list = (await request('/api/orders?q=' + encodeURIComponent(orderNumbers[0]))).data.rows;
  const a = list.find((x) => x.sku === 'SKU-A');
  assert.equal(a.purchaseNote, '新的采购备注');
  assert.equal(a.productName, '保留的名称');
  const edited = await request(`/api/orders/${a.id}`, 'PUT', {
    version: a.version,
    fields: { orderNumber: a.orderNumber, sku: a.sku, purchaseNote: null },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.purchaseNote, null);
  assert.equal(edited.data.merchantName, '单一供应商');
});
test('错误行阻止整批提交；同一文件重复行全部保留', async () => {
  const number = `${prefix}-INVALID`;
  orderNumbers.push(number);
  const p = await previewRows(
    ['单号', 'SKU', '数量'],
    [
      [number, 'SKU-1', 1],
      [number, 'SKU-2', -1],
    ],
    ['orderNumber', 'sku', 'quantity'],
  );
  assert.ok(p.data.errorCount > 0);
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 400);
  assert.equal((await request('/api/orders?q=' + number)).data.total, 0);
  const d = await previewRows(
    ['单号', 'SKU'],
    [
      [number, 'SAME'],
      [number, 'SAME'],
    ],
    ['orderNumber', 'sku'],
  );
  assert.equal(d.data.errorCount, 0);
  assert.equal((await request(`/api/imports/${d.data.id}/commit`, 'POST')).status, 200);
  assert.equal((await request('/api/orders?q=' + number)).data.total, 2);
});
test('订单与采购导入入口隔离；采购仅按三项匹配更新，无匹配跳过且不新增', async () => {
  const number = `${prefix}-SPLIT-IMPORT`;
  orderNumbers.push(number);
  const order = await previewRows(
    ['订单号', 'SKU', '店铺名', '商品名称'],
    [[number, 'SPLIT-1', '采购测试店', '原商品']],
    ['orderNumber', 'sku', 'shopName', 'productName'],
  );
  const orderPreview = await request('/api/imports/orders/preview', 'POST', {
    uploadId: order.upload.id,
    template: order.template,
  });
  assert.equal(orderPreview.status, 200, JSON.stringify(orderPreview.data));
  jobIds.push(orderPreview.data.id);
  assert.equal(orderPreview.data.added, 1);
  assert.equal(
    (await request(`/api/imports/purchases/${orderPreview.data.id}/commit`, 'POST')).status,
    409,
  );
  assert.equal(
    (await request(`/api/imports/orders/${orderPreview.data.id}/commit`, 'POST')).status,
    200,
  );

  const invalidOrder = await request('/api/imports/orders/preview', 'POST', {
    uploadId: order.upload.id,
    template: {
      ...order.template,
      mappings: [
        ...order.template.mappings,
        { column: 5, header: '采购备注', field: 'purchaseNote' },
      ],
    },
  });
  assert.equal(invalidOrder.status, 400);

  const purchaseTemplate = {
    name: `${prefix}-采购模板`,
    sheetName: '每日订单',
    headerRow: 2,
    mappings: [
      { column: 1, header: '订单号', field: 'orderNumber' },
      { column: 2, header: 'WalmartSku', field: 'walmartSku' },
      { column: 3, header: '店铺名', field: 'shopName' },
      { column: 4, header: '采购Sku', field: 'purchaseSku' },
      { column: 5, header: '采购备注', field: 'purchaseNote' },
    ],
  };
  const saved = await request('/api/templates', 'POST', purchaseTemplate);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  templateIds.push(saved.data.id);
  async function purchaseUpload(rows) {
    const body = new FormData();
    body.append(
      'file',
      new Blob([await makeWorkbook(['订单号', 'WalmartSku', '店铺名', '采购Sku', '采购备注'], rows)]),
      `${prefix}-${randomUUID()}.xlsx`,
    );
    const uploaded = await request('/api/uploads/excel', 'POST', body);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    return { uploadId: uploaded.data.id, templateId: saved.data.id };
  }
  const first = await purchaseUpload([[number, 'SPLIT-1', '采购测试店', 'P-1', '第一次采购']]);
  const second = await purchaseUpload([[number, 'SPLIT-1', '采购测试店', 'P-2', '第二次采购']]);
  const duplicate = await request('/api/imports/purchases/preview', 'POST', {
    sources: [first, second],
  });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.data));
  jobIds.push(duplicate.data.id);
  assert.equal(duplicate.data.updated, 2);
  assert.equal(duplicate.data.added, 0);
  assert.equal(duplicate.data.errorCount, 0);
  assert.equal(
    (await request(`/api/imports/purchases/${duplicate.data.id}/commit`, 'POST')).status,
    200,
  );

  const missing = await purchaseUpload([[number, 'NOT-FOUND', '采购测试店', 'P-3', '新明细']]);
  const unmatched = await request('/api/imports/purchases/preview', 'POST', { sources: [missing] });
  assert.equal(unmatched.status, 200, JSON.stringify(unmatched.data));
  jobIds.push(unmatched.data.id);
  assert.equal(unmatched.data.added, 0);
  assert.equal(unmatched.data.skipped, 1);
  assert.equal(unmatched.data.errorCount, 0);
  assert.equal(
    (await request(`/api/imports/purchases/${unmatched.data.id}/commit`, 'POST')).status,
    200,
  );

  const blank = await purchaseUpload([[number, 'SPLIT-1', '采购测试店', '', '空采购Sku新增']]);
  const blankPreview = await request('/api/imports/purchases/preview', 'POST', { sources: [blank] });
  assert.equal(blankPreview.status, 200, JSON.stringify(blankPreview.data));
  jobIds.push(blankPreview.data.id);
  assert.equal(blankPreview.data.added, 0);
  assert.equal(blankPreview.data.updated, 1);
  assert.equal((await request(`/api/imports/purchases/${blankPreview.data.id}/commit`, 'POST')).status, 200);

  const valid = await request('/api/imports/purchases/preview', 'POST', { sources: [first] });
  assert.equal(valid.status, 200, JSON.stringify(valid.data));
  jobIds.push(valid.data.id);
  assert.equal(valid.data.added, 0);
  assert.equal(valid.data.updated, 1);
  assert.equal((await request(`/api/imports/${valid.data.id}/commit`, 'POST')).status, 409);
  assert.equal(
    (await request(`/api/imports/purchases/${valid.data.id}/commit`, 'POST')).status,
    200,
  );
  const rows = (await request('/api/orders?q=' + encodeURIComponent(number))).data.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows.find((row) => row.purchaseSku === 'P-1').productName, '原商品');
  assert.equal(rows.find((row) => row.purchaseSku === 'P-1').purchaseNote, '第一次采购');
  assert.equal(rows[0].walmartSku, 'SPLIT-1');
});
test('复用模板时列顺序变化可重定位，缺少可选列仍保留原值', async () => {
  const p = await previewRows(
    ['商品编码', '平台单号', '店铺名'],
    [['SKU-A', orderNumbers[0], '测试店铺']],
    ['sku', 'orderNumber', 'shopName'],
  );
  const preview = await request('/api/imports/preview', 'POST', {
    uploadId: p.upload.id,
    templateId: reusableTemplateId,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  jobIds.push(preview.data.id);
  assert.equal(preview.data.errorCount, 0);
  assert.ok(preview.data.warnings.some((w) => w.message.includes('保留原值')));
  assert.equal((await request(`/api/imports/${preview.data.id}/commit`, 'POST')).status, 200);
  const a = (await request('/api/orders?q=' + encodeURIComponent(orderNumbers[0]))).data.rows.find(
    (x) => x.sku === 'SKU-A',
  );
  assert.equal(a.merchantName, '单一供应商');
  assert.equal(a.productName, '保留的名称');
  assert.equal(a.assignedTo, userIds[1]);
});
test('预览后发生修改会中止提交，避免覆盖其他人员修改', async () => {
  const p = await previewRows(
    ['单号', 'SKU', '采购备注', '店铺名'],
    [[orderNumbers[0], 'SKU-A', '不应提交的备注', '测试店铺']],
    ['orderNumber', 'sku', 'purchaseNote', 'shopName'],
  );
  const row = (
    await request('/api/orders?q=' + encodeURIComponent(orderNumbers[0]))
  ).data.rows.find((r) => r.sku === 'SKU-A');
  const edit = await request(`/api/orders/${row.id}`, 'PUT', {
    version: row.version,
    fields: { orderNumber: row.orderNumber, sku: row.sku, purchaseNote: '其他人员的新备注' },
  });
  assert.equal(edit.status, 200);
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 409);
  assert.equal((await request(`/api/orders/${row.id}`)).data.purchaseNote, '其他人员的新备注');
});
test('表头变化被拦截，SQL 字符串按普通文本检索，伪造图片无法上传', async () => {
  const p = await previewRows(
    ['单号', 'SKU'],
    [[orderNumbers[0], 'SKU-A']],
    ['orderNumber', 'sku'],
  );
  const invalid = await request('/api/imports/preview', 'POST', {
    uploadId: p.upload.id,
    template: {
      ...p.template,
      mappings: [{ column: 1, header: '旧表头', field: 'orderNumber' }, p.template.mappings[1]],
    },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await request('/api/orders?q=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
  const body = new FormData();
  body.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'bad.png');
  assert.equal((await request('/api/uploads/image', 'POST', body)).status, 400);
});
test('不可分配标志生效，停用账号立即失去会话访问', async () => {
  const row = (
    await request('/api/orders?q=' + encodeURIComponent(orderNumbers[0]))
  ).data.rows.find((r) => r.sku === 'SKU-B');
  const edit = await request(`/api/orders/${row.id}`, 'PUT', {
    version: row.version,
    fields: { orderNumber: row.orderNumber, sku: row.sku, allocatable: '否' },
  });
  assert.equal(edit.status, 200);
  assert.equal(
    (
      await request('/api/assignments', 'POST', {
        items: [{ id: row.id, version: edit.data.version }],
        assignedTo: userIds[1],
      })
    ).status,
    400,
  );
  const login = await request(
    '/api/auth/login',
    'POST',
    { username: `${prefix}_purchasing`, password: 'TestOnly!2026' },
    {},
  );
  const credential = {
    cookie: login.headers.get('set-cookie').split(';')[0],
    csrf: login.data.csrfToken,
  };
  assert.equal((await request('/api/templates', 'GET', null, credential)).status, 200);
  await request(`/api/users/${userIds[1]}`, 'PUT', { active: false });
  assert.equal((await request('/api/auth/me', 'GET', null, credential)).status, 401);
});

test('三个字典支持自定义和元数据同步，改名不改历史记录，旧值仍可原样编辑', async () => {
  const custom = {};
  for (const kind of ['purchaseChannel', 'orderStatus', 'purchaseStatus']) {
    const response = await request(`/api/dictionaries/${kind}`, 'POST', {
      value: `${prefix}-${kind}`,
      sortOrder: 2,
      active: true,
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    dictionaryIds.push(response.data.id);
    custom[kind] = response.data;
    const meta = (await request('/api/meta')).data;
    assert.ok(
      meta.fields.find((field) => field.key === kind).options.includes(response.data.value),
    );
    const duplicate = await request(`/api/dictionaries/${kind}`, 'POST', {
      value: response.data.value,
      sortOrder: 2,
      active: true,
    });
    assert.equal(duplicate.status, 409);
  }
  const orderNumber = `${prefix}-DICTIONARY`;
  orderNumbers.push(orderNumber);
  const values = Object.fromEntries(
    Object.entries(custom).map(([kind, option]) => [kind, option.value]),
  );
  const created = await request('/api/orders', 'POST', {
    fields: { orderNumber, sku: 'CUSTOM', ...values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  for (const [kind, option] of Object.entries(custom)) {
    const renamed = await request(`/api/dictionaries/${kind}/${option.id}`, 'PUT', {
      ...option,
      value: `${option.value}-新版`,
    });
    assert.equal(renamed.status, 200);
    assert.equal(
      (
        await request(`/api/dictionaries/${kind}/${option.id}`, 'PUT', {
          ...option,
          value: '过期修改',
        })
      ).status,
      409,
    );
    const meta = (await request('/api/meta')).data;
    assert.ok(!meta.fields.find((field) => field.key === kind).options.includes(option.value));
    assert.ok(meta.fields.find((field) => field.key === kind).options.includes(renamed.data.value));
    assert.deepEqual(
      (await request(`/api/orders/${created.data.id}`)).data[kind],
      kind === 'purchaseChannel' ? [option.value] : option.value,
    );
    const inactive = await request(`/api/dictionaries/${kind}/${option.id}`, 'PUT', {
      ...renamed.data,
      active: false,
    });
    assert.equal(inactive.status, 200);
    assert.ok(
      !(await request('/api/meta')).data.fields
        .find((field) => field.key === kind)
        .options.includes(renamed.data.value),
    );
  }
  const edited = await request(`/api/orders/${created.data.id}`, 'PUT', {
    version: created.data.version,
    fields: { orderNumber, sku: 'CUSTOM', ...values, operationsNote: '保留旧选项' },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  for (const kind of Object.keys(values))
    assert.deepEqual(edited.data[kind], kind === 'purchaseChannel' ? [values[kind]] : values[kind]);
  assert.equal(
    (await request('/api/orders', 'POST', { fields: { orderNumber, sku: 'NEW', ...values } }))
      .status,
    400,
  );
  assert.equal((await request('/api/dictionaries/unknown')).status, 404);
});

test('模板渠道填补空白与缺列，Excel 非空优先，未选字段忽略，空渠道独立匹配', async () => {
  async function channel(name) {
    const result = await request('/api/dictionaries/purchaseChannel', 'POST', {
      value: `${prefix}-${name}`,
      sortOrder: 9,
      active: true,
    });
    assert.equal(result.status, 201);
    dictionaryIds.push(result.data.id);
    return result.data;
  }
  const bound = await channel('绑定渠道');
  const excelChannel = await channel('表格渠道');
  const number = `${prefix}-CHANNEL`;
  orderNumbers.push(number);
  const p = await previewRows(
    ['单号', 'SKU', '渠道', '采购备注'],
    [
      [number, 'BLANK', '', ''],
      [number, 'EXCEL', excelChannel.value, ''],
    ],
    ['orderNumber', 'sku', 'purchaseChannel', 'purchaseNote'],
  );
  const templatePayload = {
    ...p.template,
    name: `${prefix}-BOUND`,
    purchaseChannelId: bound.id,
    mappings: [
      ...p.template.mappings.slice(0, 3),
      { column: 4, header: '采购备注', field: '' },
      { column: null, field: null },
    ],
  };
  const saved = await request('/api/templates', 'POST', templatePayload);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  templateIds.push(saved.data.id);
  assert.equal(saved.data.mappings.length, 4);
  assert.deepEqual(saved.data.mappings[3], { column: 4, header: '采购备注', field: '' });
  assert.equal(saved.data.purchaseChannelId, bound.id);
  async function preview(uploadId, input) {
    const result = await request('/api/imports/preview', 'POST', { uploadId, ...input });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    jobIds.push(result.data.id);
    return result.data;
  }
  const imported = await preview(p.upload.id, { templateId: saved.data.id });
  assert.deepEqual(imported.rows[0].patch.purchaseChannel, [bound.value]);
  assert.deepEqual(imported.rows[1].patch.purchaseChannel, [excelChannel.value]);
  assert.ok(!Object.hasOwn(imported.rows[0].patch, 'purchaseNote'));
  assert.equal((await request(`/api/imports/${imported.id}/commit`, 'POST')).status, 200);
  const single = await previewRows(
    ['单号', 'SKU', '渠道'],
    [[number, 'UNBOUND', excelChannel.value]],
    ['orderNumber', 'sku', 'purchaseChannel'],
  );
  const unbound = await preview(single.upload.id, {
    template: { ...p.template, mappings: p.template.mappings.slice(0, 2) },
  });
  assert.ok(!Object.hasOwn(unbound.rows[0].patch, 'purchaseChannel'));
  assert.equal((await request(`/api/imports/${unbound.id}/commit`, 'POST')).status, 200);
  assert.deepEqual(
    (await request('/api/orders?q=' + number)).data.rows.find((row) => row.sku === 'BLANK')
      .purchaseChannel,
    [bound.value],
  );
  const renamed = await request(`/api/dictionaries/purchaseChannel/${bound.id}`, 'PUT', {
    ...bound,
    value: `${bound.value}-新版`,
  });
  assert.equal(renamed.status, 200);
  const missing = await previewRows(['单号', 'SKU'], [[number, 'MISSING']], ['orderNumber', 'sku']);
  const fallback = await preview(missing.upload.id, { templateId: saved.data.id });
  assert.deepEqual(fallback.rows[0].patch.purchaseChannel, [renamed.data.value]);
  assert.equal((await request(`/api/imports/${fallback.id}/commit`, 'POST')).status, 200);
  const ignored = await preview(single.upload.id, {
    template: {
      ...templatePayload,
      mappings: [...p.template.mappings.slice(0, 2), { column: 3, header: '渠道', field: '' }],
    },
  });
  assert.deepEqual(ignored.rows[0].patch.purchaseChannel, [renamed.data.value]);
  const bad = await previewRows(
    ['单号', 'SKU', '渠道'],
    [[number, 'INVALID', '不存在的渠道']],
    ['orderNumber', 'sku', 'purchaseChannel'],
  );
  const invalid = await preview(bad.upload.id, { templateId: saved.data.id });
  assert.ok(invalid.errorCount > 0);
  assert.equal((await request(`/api/imports/${invalid.id}/commit`, 'POST')).status, 400);
  const disabled = await request(`/api/dictionaries/purchaseChannel/${bound.id}`, 'PUT', {
    ...renamed.data,
    active: false,
  });
  assert.equal(disabled.status, 200);
  assert.equal((await request(`/api/imports/${ignored.id}/commit`, 'POST')).status, 409);
  assert.equal(
    (
      await request('/api/imports/preview', 'POST', {
        uploadId: missing.upload.id,
        templateId: saved.data.id,
      })
    ).status,
    400,
  );
});

test('未匹配表头保存后可继续配置，空目标不读取数据也不覆盖原值', async () => {
  const number = `${prefix}-UNMAPPED`;
  orderNumbers.push(number);
  const created = await request('/api/orders', 'POST', {
    fields: { orderNumber: number, sku: 'KEEP', purchaseNote: '原备注' },
  });
  assert.equal(created.status, 201);
  const p = await previewRows(
    ['订单号', 'SKU', '外部自定义说明', '不导入的错误单元格'],
    [[number, 'KEEP', '新备注', { error: '#VALUE!' }]],
    ['orderNumber', 'sku', '', ''],
  );
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.errorCount, 0);
  const saved = await request('/api/templates', 'POST', {
    ...p.template,
    name: `${prefix}-ALL-HEADERS`,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  templateIds.push(saved.data.id);
  const reopened = (await request('/api/templates')).data.find((t) => t.id === saved.data.id);
  assert.deepEqual(reopened.mappings, p.template.mappings);
  async function importSaved() {
    const result = await request('/api/imports/preview', 'POST', {
      uploadId: p.upload.id,
      templateId: saved.data.id,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    jobIds.push(result.data.id);
    assert.equal(result.data.errorCount, 0);
    assert.equal((await request(`/api/imports/${result.data.id}/commit`, 'POST')).status, 200);
    return result.data.rows[0].patch;
  }
  assert.ok(!Object.hasOwn(await importSaved(), 'purchaseNote'));
  assert.equal((await request(`/api/orders/${created.data.id}`)).data.purchaseNote, '原备注');
  reopened.mappings[2].field = 'purchaseNote';
  assert.equal((await request(`/api/templates/${saved.data.id}`, 'PUT', reopened)).status, 200);
  assert.equal((await importSaved()).purchaseNote, '新备注');
  assert.equal((await request(`/api/orders/${created.data.id}`)).data.purchaseNote, '新备注');
});

test('20 位小数在手工保存、Excel 导入和显示中保持精度，超过 20 位拒绝', async () => {
  const number = `${prefix}-PRECISION`;
  orderNumbers.push(number);
  const exact = '123456789012.12345678901234567891';
  const decimalFields = fields.filter((field) => ['money', 'decimal'].includes(field.type));
  const values = Object.fromEntries(decimalFields.map((field) => [field.key, exact]));
  assert.equal(money(exact), '123,456,789,012.12345678901234567891');
  assert.equal(validatePatch({ tax: 1e-7 }).tax, '0.0000001');
  for (const field of decimalFields)
    assert.throws(
      () => validatePatch({ [field.key]: exact + '1' }),
      (error) => error.details[0].message.includes('20 位'),
    );
  const created = await request('/api/orders', 'POST', {
    fields: { orderNumber: number, sku: 'EXACT', ...values },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  for (const field of decimalFields) assert.equal(created.data[field.key], exact);
  const p = await previewRows(
    ['订单号', 'SKU', ...decimalFields.map((field) => field.label)],
    [[number, 'EXCEL', ...decimalFields.map(() => exact)]],
    ['orderNumber', 'sku', ...decimalFields.map((field) => field.key)],
  );
  assert.equal(p.data.errorCount, 0, JSON.stringify(p.data));
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const imported = (await request('/api/orders?q=' + number)).data.rows.find(
    (row) => row.sku === 'EXCEL',
  );
  for (const field of decimalFields) assert.equal(imported[field.key], exact);
});

test('采购渠道多选与斜杠导入、历史单选兼容及主管确认新增选项', async () => {
  const number = `${prefix}-MULTICHANNEL`;
  orderNumbers.push(number);
  const legacyCombined = 'Ebay-2（0902）/恩恩采购表（eBay）';
  assert.deepEqual(validatePatch({ purchaseChannel: legacyCombined }).purchaseChannel, [
    legacyCombined,
  ]);
  const combined = `${prefix}-渠道一/渠道二`;
  const selected = [`${prefix}-新店铺`, combined, `${prefix}-MY`];
  for (const value of selected) {
    const option = await request('/api/dictionaries/purchaseChannel', 'POST', {
      value,
      sortOrder: 1,
      active: true,
    });
    assert.equal(option.status, 201);
    dictionaryIds.push(option.data.id);
  }
  assert.deepEqual(validatePatch({ purchaseChannel: [] }).purchaseChannel, null);
  assert.throws(() => validatePatch({ purchaseChannel: '新店铺/不存在的渠道' }));
  const p = await previewRows(
    ['订单号', 'SKU', '采购渠道', '主管确认'],
    [[number, 'MULTI', ` ${selected.join(' / ')} / ${selected[0]} `, '已确认']],
    ['orderNumber', 'sku', 'purchaseChannel', 'supervisorConfirmed'],
  );
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.errorCount, 0, JSON.stringify(p.data.errors));
  assert.deepEqual(p.data.rows[0].patch.purchaseChannel, selected);
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const row = (await request('/api/orders?q=' + number)).data.rows[0];
  assert.deepEqual(row.purchaseChannel, selected);
  assert.equal(row.supervisorConfirmed, '已确认');
  const filtered = await request(
    '/api/orders?q=' + number + '&purchaseChannel=' + encodeURIComponent(combined),
  );
  assert.equal(filtered.status, 200, JSON.stringify(filtered.data));
  assert.equal(filtered.data.total, 1);
  const edited = await request(`/api/orders/${row.id}`, 'PUT', {
    version: row.version,
    fields: {
      orderNumber: number,
      sku: 'MULTI',
      purchaseChannel: [combined, selected[0]],
      supervisorConfirmed: '不可分配',
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.deepEqual(edited.data.purchaseChannel, [combined, selected[0]]);
  assert.equal(edited.data.supervisorConfirmed, '不可分配');
  // 模拟升级前的原始字符串存储，确认读取和筛选不破坏历史值。
  await db.query('UPDATE purchases SET purchaseChannel = :channel WHERE itemId = :itemId', {
    replacements: { channel: combined, itemId: row.id },
  });
  assert.deepEqual((await request(`/api/orders/${row.id}`)).data.purchaseChannel, [combined]);
  assert.equal(
    (await request('/api/orders?q=' + number + '&purchaseChannel=' + encodeURIComponent(combined)))
      .data.total,
    1,
  );
  const cleared = await request(`/api/orders/${row.id}`, 'PUT', {
    version: edited.data.version,
    fields: { orderNumber: number, sku: 'MULTI', purchaseChannel: [] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.purchaseChannel, null);
});

test('Excel 上传超过旧 50 MB 上限后仍进入格式校验', async () => {
  const body = new FormData();
  body.append('file', new Blob([Buffer.alloc(50 * 1024 * 1024 + 1)]), `${prefix}-LIMIT.xlsx`);
  const result = await request('/api/uploads/excel', 'POST', body);
  assert.equal(result.status, 400);
  assert.match(result.data.message, /不是有效的 XLSX/);
});

test('三项组合校验与导入匹配，渠道变更更新原明细，不同 SKU 或店铺独立', async () => {
  const number = `${prefix}-CHANNEL-IDENTITY`;
  orderNumbers.push(number);
  const channels = identityChannels;
  const create = async (sku, shopName, purchaseChannel = channels) => {
    const result = await request('/api/orders', 'POST', {
      fields: {
        orderNumber: number,
        purchaseChannel,
        sku,
        shopName,
        productName: '原商品',
        purchaseNote: '保留的备注',
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  const combined = await create('001', '店1');
  const single = await create('001', '店2');
  const differentSku = await create('002', '店1');
  const empty = await create(null, null);
  const blankShop = await create('001', null);
  const blankSku = await create(null, '店1');
  const duplicateCreate = await request('/api/orders', 'POST', {
    fields: { orderNumber: number, sku: '001', shopName: '店1', purchaseChannel: null },
  });
  assert.equal(duplicateCreate.status, 409);
  const p = await previewRows(
    ['订单号', '渠道', 'SKU', '订单状态', '采购状态', '店铺名'],
    [[number, channels[0], '001', '采购成功真实单号发货', '采购中', '店1']],
    ['orderNumber', 'purchaseChannel', 'sku', 'orderStatus', 'purchaseStatus', 'shopName'],
  );
  assert.equal(p.data.errorCount, 0, JSON.stringify(p.data.errors));
  assert.equal(p.data.added, 0);
  assert.equal(p.data.updated, 1);
  assert.equal(p.data.rows[0].expectedId, combined.id);
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const changed = (await request(`/api/orders/${combined.id}`)).data;
  assert.equal(changed.sku, '001');
  assert.deepEqual(changed.purchaseChannel, [channels[0]]);
  assert.equal(changed.orderStatus, '采购成功真实单号发货');
  assert.equal(changed.purchaseStatus, '采购中');
  assert.equal(changed.purchaseNote, '保留的备注');
  assert.equal((await request(`/api/orders/${single.id}`)).data.orderStatus, null);
  assert.equal((await request(`/api/orders/${empty.id}`)).data.orderStatus, null);
  assert.equal((await request(`/api/orders/${differentSku.id}`)).data.orderStatus, null);
  assert.equal((await request('/api/orders?q=' + number)).data.total, 6);

  const noSku = await previewRows(
    ['订单号', '渠道', '备注', '店铺名'],
    [[number, channels.join('/'), '更新采购备注', '店1']],
    ['orderNumber', 'purchaseChannel', 'purchaseNote', 'shopName'],
  );
  assert.equal(noSku.data.rows[0].expectedId, blankSku.id);
  assert.equal((await request(`/api/imports/${noSku.data.id}/commit`, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${combined.id}`)).data.purchaseNote, '保留的备注');
  const noShop = await previewRows(['订单号', 'SKU'], [[number, '001']], ['orderNumber', 'sku']);
  assert.equal(noShop.data.rows[0].expectedId, blankShop.id);

  const onlyNumber = await previewRows(['订单号'], [[number]], ['orderNumber']);
  assert.equal(onlyNumber.status, 200, JSON.stringify(onlyNumber.data));
  assert.equal(onlyNumber.data.rows[0].expectedId, empty.id);
  const template = await request('/api/templates', 'POST', {
    ...onlyNumber.template,
    name: `${prefix}-ONLY-NUMBER`,
  });
  assert.equal(template.status, 201, JSON.stringify(template.data));
  templateIds.push(template.data.id);
  assert.equal(template.data.mappings.length, 1);
  assert.equal((await request(`/api/imports/${onlyNumber.data.id}/commit`, 'POST')).status, 200);

  const conflict = await request(`/api/orders/${single.id}`, 'PUT', {
    version: single.version,
    fields: { orderNumber: number, shopName: '店1' },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
  assert.equal((await request(`/api/orders/${single.id}`)).data.shopName, '店2');
  const duplicate = await previewRows(
    ['订单号', '采购渠道', 'SKU', '店铺名'],
    [
      [number, channels.join('/'), '003', '店1'],
      [number, [...channels].reverse().join('/'), '003', '店1'],
    ],
    ['orderNumber', 'purchaseChannel', 'sku', 'shopName'],
  );
  assert.equal(duplicate.data.errorCount, 0);
  assert.deepEqual([duplicate.data.updated, duplicate.data.added], [0, 2]);
  assert.equal(duplicate.data.rows[1].expectedId, null);
  assert.equal((await request(`/api/imports/${duplicate.data.id}/commit`, 'POST')).status, 200);
});

test('身份键与预览版本同步变更，并拒绝按旧渠道规则生成的预览', async () => {
  const number = `${prefix}-IDENTITY-VERSION`;
  orderNumbers.push(number);
  const p = await previewRows(
    ['订单号', '采购渠道'],
    [[number, identityChannels[0]]],
    ['orderNumber', 'purchaseChannel'],
  );
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const row = (await request('/api/orders?q=' + number)).data.rows[0];
  const stale = await previewRows(
    ['订单号', '采购渠道'],
    [[number, identityChannels[0]]],
    ['orderNumber', 'purchaseChannel'],
  );
  const edited = await request(`/api/orders/${row.id}`, 'PUT', {
    version: row.version,
    fields: {
      orderNumber: number,
      purchaseChannel: [identityChannels[1]],
      sku: '新SKU',
      shopName: '新店',
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal((await request(`/api/imports/${stale.data.id}/commit`, 'POST')).status, 409);
  const next = await previewRows(
    ['订单号', '采购渠道', 'SKU', '店铺名'],
    [[number, identityChannels[1], '新SKU', '新店']],
    ['orderNumber', 'purchaseChannel', 'sku', 'shopName'],
  );
  assert.equal(next.data.rows[0].expectedId, row.id);
  const old = await ImportJob.findByPk(next.data.id);
  const snapshot = { ...old.templateSnapshot };
  snapshot.matchRule = 'order-channel-empty-fallback-v3';
  await old.update({ templateSnapshot: snapshot });
  const rejected = await request(`/api/imports/${next.data.id}/commit`, 'POST');
  assert.equal(rejected.status, 409);
  assert.match(rejected.data.message, /匹配规则已更新/);
});

test('历史匹配键回填可重复执行，保留重复明细、采购记录和时间戳', async () => {
  const number = `${prefix}-IDENTITY-MIGRATION`;
  orderNumbers.push(number);
  const p = await previewRows(
    ['订单号', 'SKU', '店铺名', '采购备注'],
    [
      [number, '001', '店1', '采购1'],
      [number, '001', '店1', '采购2'],
      [number, '', '', '空组合'],
    ],
    ['orderNumber', 'sku', 'shopName', 'purchaseNote'],
  );
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const order = await Order.findOne({ where: { orderNumber: number } });
  const records = () =>
    OrderItem.findAll({ where: { orderId: order.id }, order: [['id', 'ASC']], raw: true });
  const before = await records();
  const ids = before.map((item) => item.id);
  const purchasesBefore = await Purchase.findAll({
    where: { itemId: ids },
    order: [['id', 'ASC']],
    raw: true,
  });
  await OrderItem.update({ orderIdentityKey: null }, { where: { id: ids }, silent: true });
  await migrateOrderIdentity();
  await migrateOrderIdentity();
  assert.deepEqual(
    await records(),
    before.map((item) => ({ ...item, orderIdentityKey: orderIdentityKey(item) })),
  );
  assert.deepEqual(
    await Purchase.findAll({ where: { itemId: ids }, order: [['id', 'ASC']], raw: true }),
    purchasesBefore,
  );
});

test('采购金额与价格系数按字符串保存，允许非数字和超过 20 位的小数文本', async () => {
  const number = `${prefix}-TEXT-PURCHASE`;
  orderNumbers.push(number);
  const initial = {
    purchaseAmount: 'USD 12.30 + 运费',
    priceFactor: '待定 / 1.1234567890123456789012345',
  };
  const created = await request('/api/orders', 'POST', {
    fields: { orderNumber: number, ...initial },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.purchaseAmount, initial.purchaseAmount);
  assert.equal(created.data.priceFactor, initial.priceFactor);
  const p = await previewRows(
    ['订单号', '采购金额', '价格系数'],
    [[number, '0012.3000（含税）', '0.123456789012345678901234567890']],
    ['orderNumber', 'purchaseAmount', 'priceFactor'],
  );
  assert.equal(p.data.errorCount, 0, JSON.stringify(p.data.errors));
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const imported = (await request(`/api/orders/${created.data.id}`)).data;
  assert.equal(imported.purchaseAmount, '0012.3000（含税）');
  assert.equal(imported.priceFactor, '0.123456789012345678901234567890');
  const blank = await previewRows(
    ['订单号', '采购金额', '价格系数'],
    [[number, '', ' ']],
    ['orderNumber', 'purchaseAmount', 'priceFactor'],
  );
  assert.equal((await request(`/api/imports/${blank.data.id}/commit`, 'POST')).status, 200);
  const retained = (await request(`/api/orders/${created.data.id}`)).data;
  assert.equal(retained.purchaseAmount, imported.purchaseAmount);
  assert.equal(retained.priceFactor, imported.priceFactor);
  const meta = (await request('/api/meta')).data;
  for (const key of ['purchaseAmount', 'priceFactor'])
    assert.equal(meta.fields.find((field) => field.key === key).type, 'text');
});

test('导入未知或停用采购状态只跳过该字段，保留旧状态并导入其他内容', async () => {
  const oldStatus = `${prefix}-旧采购状态`,
    nextStatus = `${prefix}-新采购状态`,
    disabledStatus = `${prefix}-停用采购状态`;
  for (const value of [oldStatus, nextStatus, disabledStatus]) {
    const option = await request('/api/dictionaries/purchaseStatus', 'POST', {
      value,
      sortOrder: 1,
      active: value !== disabledStatus,
    });
    assert.equal(option.status, 201);
    dictionaryIds.push(option.data.id);
  }
  const existingNumber = `${prefix}-SKIP-EXISTING`,
    newNumber = `${prefix}-SKIP-NEW`;
  orderNumbers.push(existingNumber, newNumber);
  const created = await request('/api/orders', 'POST', {
    fields: { orderNumber: existingNumber, purchaseStatus: oldStatus, purchaseNote: '旧备注' },
  });
  assert.equal(created.status, 201);
  const p = await previewRows(
    ['订单号', '采购状态', '采购备注', '采购金额'],
    [
      [existingNumber, `${prefix}-不存在的状态`, '新备注', '金额待确认'],
      [newNumber, disabledStatus, '新增备注', 'USD 8 + 2'],
    ],
    ['orderNumber', 'purchaseStatus', 'purchaseNote', 'purchaseAmount'],
  );
  assert.equal(p.data.errorCount, 0, JSON.stringify(p.data.errors));
  assert.equal(p.data.warnings.filter((warning) => warning.field === 'purchaseStatus').length, 2);
  assert.ok(p.data.rows.every((row) => !Object.hasOwn(row.patch, 'purchaseStatus')));
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const retained = (await request(`/api/orders/${created.data.id}`)).data;
  assert.equal(retained.purchaseStatus, oldStatus);
  assert.equal(retained.purchaseNote, '新备注');
  assert.equal(retained.purchaseAmount, '金额待确认');
  assert.equal((await request('/api/orders?q=' + newNumber)).data.rows[0].purchaseStatus, null);
  const valid = await previewRows(
    ['订单号', '采购状态'],
    [[existingNumber, nextStatus]],
    ['orderNumber', 'purchaseStatus'],
  );
  assert.equal(valid.data.errorCount, 0);
  assert.equal((await request(`/api/imports/${valid.data.id}/commit`, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${created.data.id}`)).data.purchaseStatus, nextStatus);
  const otherError = await previewRows(
    ['订单号', '采购状态', '数量'],
    [[existingNumber, '不支持的状态', -1]],
    ['orderNumber', 'purchaseStatus', 'quantity'],
  );
  assert.ok(otherError.data.errors.some((error) => error.field === 'quantity'));
  assert.equal((await request(`/api/imports/${otherError.data.id}/commit`, 'POST')).status, 400);
});

test('发货预警统计覆盖全部筛选明细，不受分页影响且忽略空日期', async () => {
  const queryPrefix = `${prefix}-SHIP-COUNTS`;
  const dates = ['2026-10-01', '2026-10-02', '2026-10-02', '2026-10-03', null];
  for (const [index, date] of dates.entries()) {
    const orderNumber = `${queryPrefix}-${index}`;
    orderNumbers.push(orderNumber);
    const created = await request('/api/orders', 'POST', {
      fields: {
        orderNumber,
        platformShipDate: date,
        platformOrderStatus: '已确认',
        shopName: index < 2 ? '预警店铺A' : '预警店铺B',
        settlement: index < 2 ? '已结算' : '未结算',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
  }
  const expected = [
    { date: '2026-10-01', count: 1 },
    { date: '2026-10-02', count: 2 },
    { date: '2026-10-03', count: 1 },
  ];
  const grouped = (data) => data.shippingDates.sort((a, b) => a.date.localeCompare(b.date));
  for (const page of [1, 2]) {
    const result = await request(`/api/orders?q=${queryPrefix}&pageSize=1&page=${page}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.total, 5);
    assert.equal(result.data.rows.length, 1);
    assert.deepEqual(grouped(result.data), expected);
  }
  const shop = await request(
    `/api/orders?q=${queryPrefix}&shopName=${encodeURIComponent('预警店铺B')}`,
  );
  assert.deepEqual(grouped(shop.data), [
    { date: '2026-10-02', count: 1 },
    { date: '2026-10-03', count: 1 },
  ]);
  const settled = await request(
    `/api/orders?q=${queryPrefix}&settlement=${encodeURIComponent('已结算')}`,
  );
  assert.deepEqual(
    grouped(settled.data),
    expected.slice(0, 2).map((row) => ({ ...row, count: 1 })),
  );
  const empty = await request(`/api/orders?q=${queryPrefix}-MISSING`);
  assert.deepEqual(empty.data.shippingDates, []);
});

test('重复明细按出现顺序更新，超出新增，缺少保留，采购人员及空字段独立保持', async () => {
  const number = `${prefix}-OCCURRENCES`;
  orderNumbers.push(number);
  const headers = ['订单号', '采购渠道', 'SKU', '商品名称', '采购备注'];
  const keys = ['orderNumber', 'purchaseChannel', 'sku', 'productName', 'purchaseNote'];
  const preview = (rows) => previewRows(headers, rows, keys);
  const items = async () =>
    (await request('/api/orders?q=' + number)).data.rows.sort((a, b) => a.id - b.id);
  const first = await preview([
    [number, identityChannels[0], '同SKU', 'A1', '采购1'],
    [number, identityChannels[1], '其他SKU', 'B1', '独立商品'],
    [number, identityChannels[0], '同SKU', 'A2', '采购2'],
    [number, '', '', '空渠道1', ''],
    [number, '', '', '空渠道2', ''],
  ]);
  assert.equal(first.data.errorCount, 0);
  assert.equal(first.data.added, 5);
  assert.equal((await request(`/api/imports/${first.data.id}/commit`, 'POST')).status, 200);
  let saved = await items();
  const group = saved.filter((row) => row.purchaseChannel?.includes(identityChannels[0]));
  const other = saved.find((row) => row.purchaseChannel?.includes(identityChannels[1]));
  const blankIds = saved.filter((row) => !row.purchaseChannel?.length).map((row) => row.id);
  assert.equal(group.length, 2);
  assert.equal(blankIds.length, 2);
  assert.equal(
    (
      await request('/api/assignments', 'POST', {
        items: [{ id: group[1].id, version: group[1].version }],
        assignedTo: userIds[0],
      })
    ).status,
    200,
  );
  const second = await preview([
    [number, identityChannels[0], '同SKU', '更新1', ''],
    [number, identityChannels[0], '同SKU', '更新2', ''],
    [number, identityChannels[0], '同SKU', '新增3', '采购3'],
  ]);
  assert.deepEqual([second.data.added, second.data.updated], [1, 2]);
  assert.deepEqual(
    second.data.rows.map((row) => row.expectedId),
    [group[0].id, group[1].id, null],
  );
  assert.equal((await request(`/api/imports/${second.data.id}/commit`, 'POST')).status, 200);
  assert.equal(
    (await request(`/api/imports/${second.data.id}/commit`, 'POST')).data.alreadyCompleted,
    true,
  );
  saved = await items();
  const a = saved.filter((row) => row.purchaseChannel?.includes(identityChannels[0]));
  assert.deepEqual(
    a.map((row) => row.productName),
    ['更新1', '更新2', '新增3'],
  );
  assert.deepEqual(
    a.map((row) => row.purchaseNote),
    ['采购1', '采购2', '采购3'],
  );
  assert.deepEqual(
    a.map((row) => row.assignedTo),
    [admin.id, userIds[0], admin.id],
  );
  assert.equal(saved.find((row) => row.id === other.id).productName, 'B1');
  assert.ok(blankIds.every((id) => saved.some((row) => row.id === id)));
  const again = await preview([
    [number, identityChannels[0], '同SKU', '更新1', ''],
    [number, identityChannels[0], '同SKU', '更新2', ''],
    [number, identityChannels[0], '同SKU', '新增3', ''],
  ]);
  assert.deepEqual([again.data.added, again.data.updated], [0, 3]);
  assert.equal((await request(`/api/imports/${again.data.id}/commit`, 'POST')).status, 200);
  const less = await preview([[number, identityChannels[0], '同SKU', '仅第一条变化', '']]);
  assert.equal((await request(`/api/imports/${less.data.id}/commit`, 'POST')).status, 200);
  assert.equal((await items()).length, 6);
  assert.equal((await items()).find((row) => row.id === a[1].id).productName, '更新2');
  // 已有重复组合中的某一条仍可单独编辑。
  const current = (await request(`/api/orders/${a[1].id}`)).data;
  assert.equal(
    (
      await request(`/api/orders/${a[1].id}`, 'PUT', {
        version: current.version,
        fields: { orderNumber: number, productName: '单独编辑' },
      })
    ).status,
    200,
  );
  // 后面的重复行发生版本冲突时，前面的更新也必须回滚。
  const stale = await preview([
    [number, identityChannels[0], '同SKU', '不得写入', ''],
    [number, identityChannels[0], '同SKU', '旧预览', ''],
  ]);
  const changed = (await request(`/api/orders/${a[1].id}`)).data;
  assert.equal(
    (
      await request(`/api/orders/${changed.id}`, 'PUT', {
        version: changed.version,
        fields: { orderNumber: number, productName: '其他人的修改' },
      })
    ).status,
    200,
  );
  assert.equal((await request(`/api/imports/${stale.data.id}/commit`, 'POST')).status, 409);
  assert.equal((await request(`/api/orders/${a[0].id}`)).data.productName, '仅第一条变化');
  // 两个预览都准备新增同一组合时，后提交者必须重新预览。
  const combined = `${identityChannels[0]}/${identityChannels[1]}`;
  const p1 = await preview([
    [number, combined, '竞争SKU', '组合1', ''],
    [number, combined, '竞争SKU', '组合2', ''],
  ]);
  const p2 = await preview([
    [number, combined, '竞争SKU', '组合1', ''],
    [number, combined, '竞争SKU', '组合2', ''],
  ]);
  assert.equal((await request(`/api/imports/${p1.data.id}/commit`, 'POST')).status, 200);
  assert.equal((await request(`/api/imports/${p2.data.id}/commit`, 'POST')).status, 409);
  const reversed = await preview([
    [number, `${identityChannels[1]}/${identityChannels[0]}`, '竞争SKU', '组合更新1', ''],
    [number, combined, '竞争SKU', '组合更新2', ''],
  ]);
  assert.deepEqual([reversed.data.added, reversed.data.updated], [0, 2]);
});

test('空 SKU 和店铺的组合改渠道仍更新，SKU 不同新增，竞争预览回滚', async () => {
  const number = `${prefix}-EMPTY-FALLBACK`;
  orderNumbers.push(number);
  const preview = (rows) =>
    previewRows(
      ['订单号', '采购渠道', '商品名称', '采购备注', 'SKU'],
      rows.map((values) => [number, ...values]),
      ['orderNumber', 'purchaseChannel', 'productName', 'purchaseNote', 'sku'],
    );
  const commit = async (p) => {
    assert.equal(p.data.errorCount, 0, JSON.stringify(p.data.errors));
    const result = await request(`/api/imports/${p.data.id}/commit`, 'POST');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const items = async () =>
    (await request('/api/orders?q=' + number)).data.rows.sort((a, b) => a.id - b.id);
  await commit(await preview([['', '首次商品', '保留备注']]));
  const original = (await items())[0];
  await request('/api/assignments', 'POST', {
    items: [{ id: original.id, version: original.version }],
    assignedTo: userIds[0],
  });
  const second = await preview([[identityChannels[0], '补全渠道', '']]);
  assert.deepEqual([second.data.updated, second.data.added], [1, 0]);
  assert.equal(second.data.rows[0].expectedId, original.id);
  await commit(second);
  let saved = await items();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].purchaseChannel, [identityChannels[0]]);
  assert.equal(saved[0].purchaseNote, '保留备注');
  assert.equal(saved[0].assignedTo, userIds[0]);

  const third = await preview([
    [identityChannels[0], '更新第一条', ''],
    [identityChannels[0], '新增第二条', ''],
  ]);
  assert.deepEqual([third.data.updated, third.data.added], [1, 1]);
  assert.deepEqual(
    third.data.rows.map((r) => r.expectedId),
    [original.id, null],
  );
  await commit(third);
  saved = await items();
  assert.equal(saved.length, 2);
  assert.deepEqual(
    saved.map((r) => r.assignedTo),
    [userIds[0], admin.id],
  );
  const again = await preview([
    [identityChannels[0], '再次更新1', ''],
    [identityChannels[0], '再次更新2', ''],
  ]);
  assert.deepEqual([again.data.updated, again.data.added], [2, 0]);
  await commit(again);
  const changedChannel = await preview([[identityChannels[1], '更换渠道', '']]);
  assert.equal(changedChannel.data.rows[0].expectedId, original.id);
  await commit(changedChannel);
  const otherChannel = await preview([[identityChannels[1], '其他商品', '', '其他SKU']]);
  assert.deepEqual([otherChannel.data.updated, otherChannel.data.added], [0, 1]);
  await commit(otherChannel);
  const blank = (await items()).find((r) => r.id === original.id);
  const combined = identityChannels.join('/');
  const p1 = await preview([[combined, '竞争1', '']]);
  const p2 = await preview([[combined, '竞争2', '']]);
  assert.equal(p1.data.rows[0].expectedId, blank.id);
  assert.equal(p2.data.rows[0].expectedId, blank.id);
  await commit(p1);
  assert.equal((await request(`/api/imports/${p2.data.id}/commit`, 'POST')).status, 409);
  saved = await items();
  assert.equal(saved.length, 3);
  assert.equal(saved.find((r) => r.id === blank.id).productName, '竞争1');
});

test('平台发货日期与采购渠道组合筛选，日期含边界且预警统计覆盖全部匹配记录', async () => {
  const number = `${prefix}-SHIP-FILTER`;
  orderNumbers.push(number);
  const p = await previewRows(
    ['订单号', '采购渠道', '平台发货日期'],
    [
      [number, identityChannels.join('/'), '2026-09-29'],
      [number, identityChannels[0], '2026-09-30'],
      [number, identityChannels[0], '2026-10-01'],
      [number, identityChannels[1], '2026-09-30'],
      [number, identityChannels[0], ''],
    ],
    ['orderNumber', 'purchaseChannel', 'platformShipDate'],
  );
  assert.equal((await request(`/api/imports/${p.data.id}/commit`, 'POST')).status, 200);
  const url =
    '/api/orders?' +
    new URLSearchParams({
      q: number,
      purchaseChannel: identityChannels[0],
      shipStartDate: '2026-09-29',
      shipEndDate: '2026-09-30',
      pageSize: '1',
    });
  const filtered = await request(url);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.total, 2);
  assert.equal(filtered.data.rows.length, 1);
  assert.deepEqual(filtered.data.shippingDates.map((d) => [d.date, Number(d.count)]).sort(), [
    ['2026-09-29', 1],
    ['2026-09-30', 1],
  ]);
  assert.equal((await request(`/api/orders?q=${number}&shipStartDate=2026-10-01`)).data.total, 1);
  assert.equal((await request(`/api/orders?q=${number}&shipEndDate=2026-09-29`)).data.total, 1);
  assert.equal((await request(`/api/orders?q=${number}&shipStartDate=2026-02-30`)).status, 400);
  assert.equal(
    (await request(`/api/orders?q=${number}&shipStartDate=2026-10-01&shipEndDate=2026-09-29`))
      .status,
    400,
  );
});

test('单条及批量删除校验登录、版本和目标，整批失败不误删其他明细', async () => {
  const number = `${prefix}-DELETE`;
  orderNumbers.push(number);
  const p = await previewRows(
    ['订单号', '商品名称'],
    [
      [number, '第一条'],
      [number, '第二条'],
      [number, '保留'],
    ],
    ['orderNumber', 'productName'],
  );
  await request(`/api/imports/${p.data.id}/commit`, 'POST');
  const rows = (await request('/api/orders?q=' + number)).data.rows.sort((a, b) => a.id - b.id);
  const entries = rows.slice(0, 2).map(({ id, version }) => ({ id, version }));
  assert.equal(
    (await request('/api/orders/batch-delete', 'POST', { items: entries }, {})).status,
    401,
  );
  assert.equal((await request(`/api/orders/${rows[0].id}`, 'DELETE', {})).status, 400);
  for (const items of [[], [null], [entries[0], entries[0]], Array(501).fill(entries[0])]) {
    assert.equal((await request('/api/orders/batch-delete', 'POST', { items })).status, 400);
  }
  await request(`/api/orders/${rows[1].id}`, 'PUT', {
    version: rows[1].version,
    fields: { orderNumber: number, productName: '他人刚修改' },
  });
  assert.equal((await request('/api/orders/batch-delete', 'POST', { items: entries })).status, 409);
  assert.equal((await request('/api/orders?q=' + number)).data.total, 3);
  assert.ok(await Purchase.findOne({ where: { itemId: rows[0].id } }));
  assert.equal(
    (
      await request('/api/orders/batch-delete', 'POST', {
        items: [entries[0], { id: 2147483647, version: 1 }],
      })
    ).status,
    404,
  );
  assert.ok(await OrderItem.findByPk(rows[0].id));
  const single = await request(`/api/orders/${rows[0].id}`, 'DELETE', { version: rows[0].version });
  assert.equal(single.status, 200);
  assert.equal(single.data.deleted, 1);
  assert.equal(await Purchase.findOne({ where: { itemId: rows[0].id } }), null);
  assert.equal((await request(`/api/orders/${rows[0].id}`)).status, 404);
  const remaining = (await request('/api/orders?q=' + number)).data.rows;
  assert.equal(remaining.length, 2);
  const bulk = await request('/api/orders/batch-delete', 'POST', {
    items: remaining.map(({ id, version }) => ({ id, version })),
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.deleted, 2);
  assert.equal((await request('/api/orders?q=' + number)).data.total, 0);
  assert.equal(await Purchase.count({ where: { itemId: { [Op.in]: rows.map((r) => r.id) } } }), 0);
  // 已生成的旧预览不能在明细被删除后悄悄创建替代记录。
  const pending = await previewRows(['订单号'], [[number]], ['orderNumber']);
  await request(`/api/imports/${pending.data.id}/commit`, 'POST');
  const stale = await previewRows(['订单号'], [[number]], ['orderNumber']);
  const current = (await request('/api/orders?q=' + number)).data.rows[0];
  await request(`/api/orders/${current.id}`, 'DELETE', { version: current.version });
  assert.equal((await request(`/api/imports/${stale.data.id}/commit`, 'POST')).status, 409);
});

test('新增及导入新明细自动绑定当前账号，客户端无法伪造采购人员', async () => {
  const login = await request(
    '/api/auth/login',
    'POST',
    { username: `${prefix}_operations`, password: 'TestOnly!2026' },
    {},
  );
  assert.equal(login.status, 200);
  const operator = {
    cookie: login.headers.get('set-cookie').split(';')[0],
    csrf: login.data.csrfToken,
  };
  const manualNumber = `${prefix}-AUTO-MANUAL`,
    importedNumber = `${prefix}-AUTO-IMPORT`;
  orderNumbers.push(manualNumber, importedNumber);
  const created = await request(
    '/api/orders',
    'POST',
    { fields: { orderNumber: manualNumber }, assignedTo: admin.id },
    operator,
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.assignedTo, login.data.user.id);
  assert.equal(created.data.assignee.username, login.data.user.username);
  assert.ok(created.data.assignedAt);
  const p = await previewRows(['订单号'], [[importedNumber]], ['orderNumber']);
  const preview = await request(
    '/api/imports/preview',
    'POST',
    { uploadId: p.upload.id, template: p.template, assignedTo: admin.id },
    operator,
  );
  assert.equal(preview.status, 200);
  jobIds.push(preview.data.id);
  assert.equal(
    (
      await request(
        `/api/imports/${preview.data.id}/commit`,
        'POST',
        { assignedTo: admin.id },
        operator,
      )
    ).status,
    200,
  );
  const imported = (await request('/api/orders?q=' + importedNumber)).data.rows[0];
  assert.equal(imported.assignedTo, login.data.user.id);
  assert.equal(imported.assignee.username, login.data.user.username);
  assert.ok(imported.assignedAt);
  const mine = await request(
    '/api/orders?q=' + importedNumber + '&assignedTo=' + login.data.user.id,
  );
  assert.equal(mine.data.total, 1);
  const unassigned = await request('/api/orders?q=' + importedNumber + '&assignedTo=unassigned');
  assert.equal(unassigned.data.total, 0);
});

test('价格系数等级筛选覆盖全部明细，与渠道交集、分页及预警统计一致', async () => {
  const group = `${prefix}-FACTOR`;
  const samples = [
    ['0.799999999999999999999999999999999999', 'low'],
    ['-1', 'low'],
    ['0.8', 'medium'],
    ['0.849999999999999999999999999999999999', 'medium'],
    ['0.85', 'high'],
    ['+001.00', 'high'],
    ['待定', null],
    ['', null],
  ];
  const created = [];
  for (const [index, [factor, level]] of samples.entries()) {
    const orderNumber = `${group}-${index}`;
    orderNumbers.push(orderNumber);
    const result = await request('/api/orders', 'POST', {
      fields: {
        orderNumber,
        priceFactor: factor,
        purchaseChannel: [identityChannels[index % 2]],
        platformShipDate: '2026-10-01',
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.orderNumber, orderNumber);
    assert.equal(result.data.priceFactorLevel, level);
    created.push(result.data);
  }
  for (const level of ['low', 'medium', 'high']) {
    const ids = [];
    for (const page of [1, 2]) {
      const result = await request(
        `/api/orders?q=${group}&priceFactorLevel=${level}&pageSize=1&page=${page}`,
      );
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.total, 2);
      assert.equal(result.data.rows.length, 1);
      assert.equal(result.data.rows[0].priceFactorLevel, level);
      assert.equal(
        result.data.shippingDates.reduce((sum, entry) => sum + entry.count, 0),
        2,
      );
      ids.push(result.data.rows[0].id);
    }
    assert.equal(new Set(ids).size, 2);
    const combined = await request(
      `/api/orders?q=${group}&priceFactorLevel=${level}&purchaseChannel=${encodeURIComponent(identityChannels[0])}`,
    );
    assert.equal(combined.status, 200, JSON.stringify(combined.data));
    assert.equal(combined.data.total, 1);
    assert.equal(combined.data.rows[0].priceFactorLevel, level);
  }
  const changed = await request(`/api/orders/${created[4].id}`, 'PUT', {
    version: created[4].version,
    fields: { orderNumber: created[4].orderNumber, priceFactor: '0.79' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.orderNumber, created[4].orderNumber);
  assert.equal(changed.data.priceFactorLevel, 'low');
  assert.equal((await request(`/api/orders?q=${group}&priceFactorLevel=high`)).data.total, 1);
  assert.equal((await request(`/api/orders?q=${group}`)).data.total, samples.length);
  assert.equal((await request(`/api/orders?q=${group}&priceFactorLevel=invalid`)).status, 400);
});

test('三类价格区间筛选支持单端边界，分页与预警统计一致', async () => {
  const group = `${prefix}-PRICE-RANGE`;
  const samples = [
    ['10.00', '20.00', '30.00'],
    ['20.00', '10.00', '20.00'],
    ['30.00', '30.00', '10.00'],
    [null, null, null],
  ];
  for (const [index, [purchaseLinkAmount, orderAmount, purchaseLimit]] of samples.entries()) {
    const orderNumber = `${group}-${index}`;
    orderNumbers.push(orderNumber);
    const result = await request('/api/orders', 'POST', {
      fields: {
        orderNumber,
        purchaseLinkAmount,
        orderAmount,
        purchaseLimit,
        platformShipDate: '2026-10-01',
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
  }
  const cases = [
    ['purchaseLinkAmount', '&minPrice=20&maxPrice=30', [1, 2]],
    ['orderAmount', '&maxPrice=20', [0, 1]],
    ['purchaseLimit', '&minPrice=20', [0, 1]],
    ['purchaseLimit', '&minPrice=20&maxPrice=20', [1]],
  ];
  for (const [priceType, range, indexes] of cases) {
    const expected = indexes.map((index) => `${group}-${index}`);
    const query = `/api/orders?q=${group}&priceType=${priceType}${range}&pageSize=1`;
    const rows = [];
    for (let page = 1; page <= expected.length; page++) {
      const result = await request(`${query}&page=${page}`);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.total, expected.length);
      assert.equal(result.data.rows.length, 1);
      assert.equal(
        result.data.shippingDates.reduce((sum, entry) => sum + entry.count, 0),
        expected.length,
      );
      rows.push(result.data.rows[0].orderNumber);
    }
    assert.deepEqual(rows.sort(), expected.sort());
  }
  for (const range of [
    '&priceType=unknown&minPrice=1',
    '&priceType=orderAmount&minPrice=-1',
    '&priceType=orderAmount&minPrice=2&maxPrice=1',
    '&minPrice=1',
  ]) {
    assert.equal((await request(`/api/orders?q=${group}${range}`)).status, 400);
  }
});

test('采购状态联动自动计时，重复保存和导入保留，填删单号及再次采购按规则处理', async () => {
  const number = `${prefix}-PURCHASE-TIMER`;
  orderNumbers.push(number);
  let result = await request('/api/orders', 'POST', {
    fields: { orderNumber: number, purchaseStatus: '采购中' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  let row = result.data;
  assert.equal(row.purchaseConfirmedAt, null);
  async function edit(fields) {
    result = await request(`/api/orders/${row.id}`, 'PUT', {
      version: row.version,
      fields: { orderNumber: number, ...fields },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    row = result.data;
  }
  const before = Date.now();
  await edit({ purchaseStatus: '采购成功未出跟踪号' });
  const first = row.purchaseConfirmedAt;
  assert.ok(Date.parse(first) >= before && Date.parse(first) <= Date.now());
  await edit({ purchaseStatus: '采购成功未出跟踪号', purchaseNote: '普通保存' });
  assert.equal(row.purchaseConfirmedAt, first);
  const imported = await previewRows(
    ['订单号', '采购状态'],
    [[number, '采购成功未出跟踪号']],
    ['orderNumber', 'purchaseStatus'],
  );
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal((await request(`/api/imports/${imported.data.id}/commit`, 'POST')).status, 200);
  row = (await request(`/api/orders/${row.id}`)).data;
  assert.equal(row.purchaseConfirmedAt, first);
  await edit({ trackingNumber: 'TRACK-TIMER', purchaseStatus: '采购成功已出跟踪号' });
  assert.equal(row.purchaseConfirmedAt, first);
  assert.equal(purchaseWarning(row, Date.parse(first) + 50 * 3600000), null);
  await edit({ trackingNumber: null });
  assert.equal(row.purchaseConfirmedAt, first);
  assert.equal(purchaseWarning(row, Date.parse(first) + 50 * 3600000).level, 'red');
  for (const purchaseStatus of ['采购中', '砍单', '采购失败']) {
    await edit({ purchaseStatus });
    assert.equal(row.purchaseConfirmedAt, null);
    const resumedAt = Date.now();
    await edit({ purchaseStatus: '采购成功未出跟踪号' });
    assert.ok(Date.parse(row.purchaseConfirmedAt) >= resumedAt);
  }
  const persisted = row.purchaseConfirmedAt;
  const conflict = await request(`/api/orders/${row.id}`, 'PUT', {
    version: row.version - 1,
    fields: { orderNumber: number, purchaseStatus: '采购失败' },
  });
  assert.equal(conflict.status, 409);
  assert.equal((await request(`/api/orders/${row.id}`)).data.purchaseConfirmedAt, persisted);
  assert.equal(
    (
      await request(`/api/orders/${row.id}`, 'PUT', {
        version: row.version,
        fields: { orderNumber: number, purchaseConfirmedAt: '2020-01-01' },
      })
    ).status,
    400,
  );
  const resetImport = await previewRows(
    ['订单号', '采购状态'],
    [[number, '采购失败']],
    ['orderNumber', 'purchaseStatus'],
  );
  assert.equal((await request(`/api/imports/${resetImport.data.id}/commit`, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${row.id}`)).data.purchaseConfirmedAt, null);
  const retryImport = await previewRows(
    ['订单号', '采购状态'],
    [[number, '采购成功未出跟踪号']],
    ['orderNumber', 'purchaseStatus'],
  );
  const committedAt = Date.now();
  assert.equal((await request(`/api/imports/${retryImport.data.id}/commit`, 'POST')).status, 200);
  assert.ok(
    Date.parse((await request(`/api/orders/${row.id}`)).data.purchaseConfirmedAt) >= committedAt,
  );
});

test('未出跟踪号提醒筛选在分页之前完成，包含统计并排除已有单号及非成功状态', async () => {
  const group = `${prefix}-TRACK-FILTER`;
  const now = Date.now();
  const fixtures = [
    [1, '采购成功未出跟踪号', null],
    [25, '采购成功未出跟踪号', null],
    [49, '采购成功未出跟踪号', null],
    [50, '采购成功已出跟踪号', null],
    [60, '采购成功未出跟踪号', 'TRACKED'],
    [60, '采购失败', null],
    [0, '采购成功已出跟踪号', null],
    [2, '采购成功（未出跟踪号）', ' \n '],
    [26, '采购成功 (未出跟踪号)', null],
    [50, '采购成功（已出跟踪号）', null],
  ];
  for (let i = 0; i < fixtures.length; i++) {
    const [hours, purchaseStatus, trackingNumber] = fixtures[i];
    const orderNumber = `${group}-${i}`;
    orderNumbers.push(orderNumber);
    const created = await request('/api/orders', 'POST', {
      fields: {
        orderNumber,
        purchaseStatus: purchaseStatus.replace(/[\s（）()]/g, ''),
        trackingNumber,
        orderAmount: '12',
        platformShipDate: '2026-10-07',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    await Purchase.update(
      {
        purchaseStatus,
        trackingNumber,
        purchaseConfirmedAt: hours ? new Date(now - hours * 3600000) : null,
      },
      { where: { itemId: created.data.id } },
    );
  }
  for (const [trackingWarning, indexes] of [
    ['all', [0, 1, 2, 3, 7, 8, 9]],
    ['waiting', [0, 7]],
    ['yellow', [1, 8]],
    ['red', [2, 3, 9]],
  ]) {
    const numbers = [];
    for (let page = 1; page <= indexes.length; page++) {
      const result = await request(
        `/api/orders?q=${group}&trackingWarning=${trackingWarning}&priceType=orderAmount&minPrice=12&maxPrice=12&pageSize=1&page=${page}`,
      );
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.total, indexes.length);
      assert.equal(result.data.rows.length, 1);
      assert.ok(Math.abs(Date.now() - Date.parse(result.data.serverNow)) < 5000);
      assert.equal(
        result.data.shippingDates.reduce((n, entry) => n + entry.count, 0),
        indexes.length,
      );
      numbers.push(result.data.rows[0].orderNumber);
    }
    assert.deepEqual(numbers.sort(), indexes.map((i) => `${group}-${i}`).sort());
  }
});

test('订单导出忽略分页，按筛选或勾选明细生成 Excel', async () => {
  const group = `${prefix}-EXPORT`;
  const items = [];
  for (const [index, shopName] of ['导出店铺A', '导出店铺A', '导出店铺B'].entries()) {
    const orderNumber = `${group}-${index}`;
    orderNumbers.push(orderNumber);
    const created = await request('/api/orders', 'POST', {
      fields: { orderNumber, sku: `EXPORT-SKU-${index}`, shopName },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    items.push(created.data);
  }

  async function download(body) {
    const response = await fetch(`${base}/api/orders/export`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost:5173',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200)
      assert.fail(`导出失败：${response.status} ${await response.text()}`);
    assert.match(response.headers.get('content-type'), /spreadsheetml/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const sheet = workbook.getWorksheet('订单明细');
    const orderColumn = sheet.getRow(1).values.indexOf('订单号');
    return Array.from(
      { length: sheet.rowCount - 1 },
      (_, index) => sheet.getRow(index + 2).getCell(orderColumn).value,
    );
  }

  const all = await download({ filters: { q: group, page: 1, pageSize: 1 } });
  assert.deepEqual(all.sort(), items.map((item) => item.orderNumber).sort());
  const filtered = await download({ filters: { q: group, shopName: '导出店铺A' } });
  assert.deepEqual(
    filtered.sort(),
    items
      .slice(0, 2)
      .map((item) => item.orderNumber)
      .sort(),
  );
  const selected = await download({
    filters: { q: group, shopName: '导出店铺A' },
    ids: [items[1].id],
  });
  assert.deepEqual(selected, [items[1].orderNumber]);
  assert.equal((await request('/api/orders/export', 'POST', { ids: ['bad'] })).status, 400);
});
