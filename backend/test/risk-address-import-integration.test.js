import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import express from 'express';
import { config } from '../src/config.js';
import { db, User, RiskAddress, AuditLog, Order, OrderItem, Purchase } from '../src/models.js';
import { importRiskAddresses } from '../src/services/risk-address-import.js';
import { normalizeRiskAddress } from '../src/services/risk-addresses.js';
import { getItem } from '../src/services/orders.js';
import { createRiskAddressesRouter } from '../src/routes/risk-addresses.js';
import { installAuditHooks } from '../src/services/audit.js';
import { auditContext } from '../src/lib/audit-context.js';
import { authorizeApi } from '../src/permissions.js';
import { errorHandler } from '../src/middleware/error-handler.js';

// 只允许自动创建、使用并删除一次性测试库。
const isolated = /^my_order_risk_import_test_\d+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
const headers = ['地址一', '地址二', '城市', '州', '邮编', '风险备注'];
const template = new URL('../src/assets/risk-address-import.xlsx', import.meta.url);
let connection,
  created = false,
  actor,
  operator,
  folder,
  server,
  baseUrl,
  sequence = 0;
const row = (street, note = '') => [street, '', 'Boston', 'MA', '02108', note];
async function fixture(rows, names = headers, setup) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('风险地址');
  sheet.addRow(names);
  rows.forEach((values) => sheet.addRow(values));
  setup?.(workbook, sheet);
  const target = path.join(folder, `${++sequence}.xlsx`);
  await workbook.xlsx.writeFile(target);
  return { path: target, originalname: '风险地址导入模板.xlsx' };
}
async function upload(file, role = 'admin') {
  const data = new FormData();
  data.append('file', new Blob([await fs.readFile(file.path)]), file.originalname);
  return fetch(`${baseUrl}/risk-addresses/import`, {
    method: 'POST',
    headers: { 'x-test-role': role },
    body: data,
  });
}
before(async () => {
  if (!isolated) return;
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'my-order-risk-import-'));
  config.storage = path.join(folder, 'storage');
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
  installAuditHooks();
  actor = await User.create({
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    passwordHash: 'test',
  });
  operator = await User.create({
    username: 'operator',
    displayName: '运营',
    role: 'operations',
    passwordHash: 'test',
  });
  const app = express();
  app.use((req, res, next) => {
    req.user =
      req.headers['x-test-role'] === 'operations'
        ? operator
        : { id: actor.id, role: req.headers['x-test-role'] || 'admin' };
    next();
  });
  app.use(authorizeApi);
  app.use('/risk-addresses', createRiskAddressesRouter());
  app.use(errorHandler);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
  if (folder) await fs.rm(folder, { recursive: true, force: true });
});

test('下载模板表头准确、数据区为空、保留文本邮编并冻结表头；模板可直接填入导入', async () => {
  const response = await fetch(`${baseUrl}/risk-addresses/import-template`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const data = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(data, await fs.readFile(template));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1, 7), headers);
  assert.equal(sheet.getCell('E2').numFmt, '@');
  assert.equal(sheet.views[0].ySplit, 1);
  for (let n = 2; n <= 1001; n++)
    for (let c = 1; c <= 6; c++) assert.equal(sheet.getRow(n).getCell(c).value, null);
  sheet.getRow(2).values = row('Template Road');
  const target = path.join(folder, 'filled-template.xlsx');
  await workbook.xlsx.writeFile(target);
  const result = await importRiskAddresses({ path: target, originalname: 'filled.xlsx' }, actor);
  assert.equal(result.total, 1);
  assert.equal(result.created, 1);
  assert.equal(
    (await RiskAddress.findOne({ where: { address1: 'Template Road' } })).postalCode,
    '02108',
  );
});

test('混合有效、重复与无效数据仅新增有效地址，保留原备注并返回准确行号和原因', async () => {
  const original = await RiskAddress.create(
    normalizeRiskAddress({
      address1: 'Existing Road',
      city: 'Boston',
      state: 'MA',
      postalCode: '02108',
      note: '原备注',
    }),
  );
  const file = await fixture(
    [
      row('  10   New Road  ', '新备注'),
      row('10 new road', '不可覆盖'),
      row('existing road', '不能覆盖旧备注'),
      ['Missing city', '', '', 'MA', '02108'],
      [],
      row('x'.repeat(256)),
      row('Error Road'),
      row('Number Road'),
      row('Date Road'),
    ],
    headers,
    (workbook, sheet) => {
      sheet.getCell('E8').value = { error: '#N/A' };
      sheet.getCell('E9').value = 2108;
      sheet.getCell('E9').numFmt = '00000';
      sheet.getCell('E10').value = new Date('2026-10-22T00:00:00Z');
    },
  );
  const result = await auditContext.run(
    { actor: { id: actor.id }, id: 'risk-test', method: 'POST', path: '/risk-addresses/import' },
    () => importRiskAddresses(file, actor),
  );
  assert.deepEqual(
    [result.total, result.created, result.duplicate, result.invalid, result.skipped],
    [8, 2, 2, 4, 6],
  );
  assert.deepEqual(
    result.details.map((r) => r.rowNumber),
    [3, 4, 5, 7, 8, 10],
  );
  assert.match(result.details[0].reason, /第 2 行/);
  assert.match(result.details[1].reason, /系统中已存在/);
  assert.match(result.details[4].reason, /Excel 错误/);
  await original.reload();
  assert.equal(original.note, '原备注');
  assert.equal(original.version, 1);
  const saved = await RiskAddress.findOne({ where: { address1: '10 New Road' } });
  assert.equal(saved.note, '新备注');
  assert.equal(
    (await RiskAddress.findOne({ where: { address1: 'Number Road' } })).postalCode,
    '02108',
  );
  const log = await AuditLog.findOne({
    where: { action: 'import_risk_addresses' },
    order: [['id', 'DESC']],
  });
  assert.equal(log.details.created, 2);
  assert.equal(log.details.skipped, 6);
  const changes = await AuditLog.findAll({ where: { action: 'create_record' } });
  assert.equal(changes.filter((log) => log.details.resource === 'risk-addresses').length, 2);
  const repeated = await importRiskAddresses(file, actor);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.duplicate, 4);
});

test('表头按名称匹配，允许调换列顺序和省略可选列，只读首个工作表', async () => {
  const file = await fixture(
    [['MA', '02108', 'Boston', 'Reordered Road']],
    ['州', '邮编', '城市', '地址一'],
    (workbook) => {
      const other = workbook.addWorksheet('不导入');
      other.addRow(headers);
      other.addRow(row('Other Sheet Road'));
    },
  );
  const result = await importRiskAddresses(file, actor);
  assert.equal(result.created, 1);
  assert.equal(await RiskAddress.count({ where: { address1: 'Other Sheet Road' } }), 0);
});

test('结构错误、空文件、格式错误及超量在写入前拒绝，数据库保持不变', async () => {
  const count = await RiskAddress.count();
  for (const [file, reason] of [
    [
      await fixture(
        [row('Bad Header')],
        ['地址一', '地址二', '未知城市', '州', '邮编', '风险备注'],
      ),
      /缺少必填表头/,
    ],
    [await fixture([], [...headers, '地址一']), /表头.*重复/],
    [await fixture([]), /没有可导入/],
    [await fixture(Array.from({ length: 1001 }, (_, i) => row(`Limit ${i}`))), /最多导入 1000/],
  ])
    await assert.rejects(importRiskAddresses(file, actor), reason);
  const bad = path.join(folder, 'bad.xlsx');
  await fs.writeFile(bad, 'invalid workbook');
  await assert.rejects(
    importRiskAddresses({ path: bad, originalname: 'bad.xlsx' }, actor),
    /无法读取/,
  );
  assert.equal(await RiskAddress.count(), count);
});

test('批量新增立即参与既有订单风险匹配，不修改订单字段或版本', async () => {
  const values = normalizeRiskAddress({
    address1: 'Order Road',
    city: 'Boston',
    state: 'MA',
    postalCode: '02108',
    note: '请核查地址',
  });
  const order = await Order.create({ orderNumber: 'risk-import-test' });
  const item = await OrderItem.create({
    orderId: order.id,
    shopName: 'RISK-TEST',
    walmartSku: 'SKU',
    purchaseChannelKey: '',
    quantity: 1,
    ...Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'note')),
  });
  await Purchase.create({ itemId: item.id });
  assert.equal((await getItem(item.id)).addressRisk, false);
  await item.reload();
  const previous = item.toJSON();
  await importRiskAddresses(await fixture([row('Order Road', values.note)]), actor);
  const detail = await getItem(item.id);
  assert.equal(detail.addressRisk, true);
  assert.equal(detail.addressRiskNote, values.note);
  await item.reload();
  assert.deepEqual(item.toJSON(), previous);
});

test('数据库写入失败整批回滚，避免反馈与实际数据不一致', async () => {
  const count = await RiskAddress.count(),
    logs = await AuditLog.count();
  let attempts = 0;
  RiskAddress.addHook('beforeCreate', 'testFailure', () => {
    if (++attempts === 2) throw new Error('test write failed');
  });
  try {
    await assert.rejects(
      importRiskAddresses(await fixture([row('Rollback One'), row('Rollback Two')]), actor),
      /test write failed/,
    );
  } finally {
    RiskAddress.removeHook('beforeCreate', 'testFailure');
  }
  assert.equal(await RiskAddress.count(), count);
  assert.equal(await AuditLog.count(), logs);
});

test('同时上传同一地址仅新增一条，另一份按系统重复反馈', async () => {
  const file = await fixture([row('Concurrent Road')]);
  const results = await Promise.all([
    importRiskAddresses(file, actor),
    importRiskAddresses(file, actor),
  ]);
  assert.equal(
    results.reduce((sum, result) => sum + result.created, 0),
    1,
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.duplicate, 0),
    1,
  );
});

test('管理员和运营可上传，采购无权限；文件大小错误提示准确且临时文件被清理', async () => {
  const file = await fixture([row('Route Road')]);
  assert.equal((await upload(file, 'purchasing')).status, 403);
  assert.equal(
    (
      await fetch(`${baseUrl}/risk-addresses/import-template`, {
        headers: { 'x-test-role': 'purchasing' },
      })
    ).status,
    403,
  );
  const response = await upload(file, 'operations');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).created, 1);
  const large = path.join(folder, 'large.xlsx');
  await fs.writeFile(large, Buffer.alloc(10 * 1024 * 1024 + 1));
  const oversized = await upload({ path: large, originalname: 'large.xlsx' });
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).message, /10 MB/);
  const malformed = path.join(folder, 'malformed.xlsx');
  await fs.writeFile(malformed, 'invalid');
  assert.equal((await upload({ path: malformed, originalname: 'malformed.xlsx' })).status, 400);
  assert.deepEqual(await fs.readdir(path.join(config.storage, '.tmp-uploads')), []);
});
