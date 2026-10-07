import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import ExcelJS from 'exceljs';
import { Op } from 'sequelize';
import { OrderItem } from '../src/models.js';
import { exportOrders } from '../src/services/order-export.js';

test('导出工作簿包含完整字段、中文表头和勾选明细', async () => {
  const originals = { count: OrderItem.count, findAll: OrderItem.findAll };
  const items = [
    {
      id: 2,
      order: { orderNumber: 'TEST-2' },
      platformTrackingNumber: 'PLATFORM-TRACK-2',
      walmartSku: 'SKU-002',
      purchase: { purchaseSku: 'BUY-002', purchaseChannel: ['渠道A', '渠道B'], assignee: { displayName: '采购员甲' } },
    },
    { id: 1, order: { orderNumber: 'TEST-1' }, walmartSku: 'SKU-001', purchase: {} },
  ];
  try {
    OrderItem.count = async () => items.length;
    OrderItem.findAll = async () => items;
    const response = new PassThrough();
    response.setHeader = () => {};
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    const complete = finished(response);
    await exportOrders({ ids: [2, 1] }, response);
    await complete;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks));
    const sheet = workbook.getWorksheet('订单明细');
    const headers = sheet.getRow(1).values;
    assert.equal(sheet.rowCount, 3);
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('订单号')).value, 'TEST-2');
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('WalmartSku')).value, 'SKU-002');
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('采购Sku')).value, 'BUY-002');
    assert.equal(
      sheet.getRow(2).getCell(headers.indexOf('平台发货物流单号')).value,
      'PLATFORM-TRACK-2',
    );
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('采购渠道')).value, '渠道A、渠道B');
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('采购人员')).value, '采购员甲');
  } finally {
    OrderItem.count = originals.count;
    OrderItem.findAll = originals.findAll;
  }
});

test('未勾选时导出全部匹配行，忽略页面分页并连续读取下一批', async () => {
  const originals = { count: OrderItem.count, findAll: OrderItem.findAll };
  const items = Array.from({ length: 501 }, (_, index) => ({
    id: 501 - index,
    order: { orderNumber: `BATCH-${501 - index}` },
    purchase: {},
  }));
  let requests = 0;
  try {
    OrderItem.count = async () => items.length;
    OrderItem.findAll = async (options) => {
      requests += 1;
      assert.equal(options.limit, 500);
      assert.ok(options.where[Op.and] || options.where[Op.or]);
      if (requests === 1) return items.slice(0, 500);
      assert.equal(options.where[Op.and][1].id[Op.lt], 2);
      return items.slice(500);
    };
    const response = new PassThrough();
    response.setHeader = () => {};
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    const complete = finished(response);
    await exportOrders({ filters: { q: 'BATCH', page: 1, pageSize: 1 } }, response);
    await complete;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks));
    assert.equal(requests, 2);
    assert.equal(workbook.getWorksheet('订单明细').rowCount, 502);
  } finally {
    OrderItem.count = originals.count;
    OrderItem.findAll = originals.findAll;
  }
});
