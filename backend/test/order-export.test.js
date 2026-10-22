import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { Op } from 'sequelize';
import { DictionaryOption, OrderItem } from '../src/models.js';
import { exportOrders, purchaseTemplateColumns } from '../src/services/order-export.js';
import { createThumbnailCache } from '../src/lib/excel/thumbnail-cache.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('订单导出嵌入官方图片缩略图，相同图片仅下载一次，下载失败保留原图链接', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'export-images-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cache = createThumbnailCache({ directory });
  const originals = { count: OrderItem.count, findAll: OrderItem.findAll, fetch: globalThis.fetch };
  const url = 'https://i5.walmartimages.com/product.png';
  const failedUrl = 'https://i5.walmartimages.com/failed.png';
  const calls = [];
  const source = await sharp({
    create: { width: 150, height: 80, channels: 3, background: '#00aa88' },
  })
    .png()
    .toBuffer();
  try {
    OrderItem.count = async () => 4;
    OrderItem.findAll = async () =>
      [url, url, failedUrl, null].map((productImage, index) => ({
        id: 4 - index,
        productImage,
        order: { orderNumber: `IMAGE-${index}` },
        purchase: {},
      }));
    globalThis.fetch = async (requested, options) => {
      calls.push(requested);
      assert.equal(options.redirect, 'error');
      if (requested === failedUrl) throw new Error('timeout');
      return new Response(source, { headers: { 'content-type': 'image/png' } });
    };
    const response = new PassThrough();
    response.setHeader = () => {};
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    const complete = finished(response);
    const progress = [];
    await exportOrders({ filters: {} }, response, false, {
      cache,
      progress: (state) => progress.push(state),
    });
    await complete;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks));
    const sheet = workbook.getWorksheet('订单明细');
    const column = sheet.getRow(1).values.indexOf('商品图片');
    const images = sheet.getImages();
    assert.equal(images.length, 2);
    assert.notEqual(images[0].imageId, images[1].imageId);
    for (const [index, image] of images.entries()) {
      assert.equal(image.range.tl.nativeCol, column - 1);
      assert.equal(image.range.tl.nativeRow, index + 1);
      assert.equal(sheet.getRow(index + 2).height, 78);
      assert.equal(sheet.getCell(index + 2, column).note, url);
    }
    const metadata = await sharp(workbook.getImage(images[0].imageId).buffer).metadata();
    assert.equal(metadata.width, 96);
    assert.equal(metadata.height, 96);
    assert.equal(sheet.getCell(4, column).value.hyperlink, failedUrl);
    assert.equal(sheet.getCell(5, column).value ?? '', '');
    assert.deepEqual(calls.sort(), [url, failedUrl].sort());
    assert.ok(progress.some((state) => state.stage === 'images' && state.completedImages === 2));
    assert.equal(progress.at(-1).stage, 'done');
  } finally {
    OrderItem.count = originals.count;
    OrderItem.findAll = originals.findAll;
    globalThis.fetch = originals.fetch;
  }
});

test('导出工作簿包含完整字段且按筛选导出，勾选 ID 不覆盖筛选', async () => {
  const originals = { count: OrderItem.count, findAll: OrderItem.findAll };
  const items = [
    {
      id: 2,
      order: { orderNumber: 'TEST-2' },
      platformTrackingNumber: 'PLATFORM-TRACK-2',
      walmartSku: 'SKU-002',
      quantity: 3,
      purchase: {
        purchaseQuantity: 5,
        purchaseSku: 'BUY-002',
        purchaseChannel: ['渠道A', '渠道B'],
        assignee: { displayName: '采购员甲' },
      },
    },
    { id: 1, order: { orderNumber: 'TEST-1' }, walmartSku: 'SKU-001', purchase: {} },
  ];
  try {
    OrderItem.count = async () => items.length;
    OrderItem.findAll = async (options) => {
      assert.equal(options.where.shopName, '测试店铺');
      assert.equal(options.where.id, undefined);
      return items;
    };
    const response = new PassThrough();
    response.setHeader = () => {};
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    const complete = finished(response);
    await exportOrders({ ids: [999], filters: { shopName: '测试店铺' } }, response);
    await complete;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks));
    const sheet = workbook.getWorksheet('订单明细');
    const headers = sheet.getRow(1).values;
    assert.equal(sheet.rowCount, 3);
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('订单号')).value, 'TEST-2');
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('WalmartSku')).value, 'SKU-002');
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('采购Sku')).value, 'BUY-002');
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('商品数量')).value, 3);
    assert.equal(sheet.getRow(2).getCell(headers.indexOf('采购数量')).value, 5);
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

async function exportPurchaseTemplate() {
  const response = new PassThrough();
  response.setHeader = () => {};
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  const complete = finished(response);
  await exportOrders({ filters: {} }, response, true);
  await complete;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  return workbook;
}

test('采购模板下拉复用当前启用选项，支持长名称及逗号，保留历史值和空值', async () => {
  const originals = {
    count: OrderItem.count,
    findAll: OrderItem.findAll,
    options: DictionaryOption.findAll,
  };
  let choices = ['Amazon', 'Ebay', '自定义,平台"名称', '长'.repeat(255)];
  try {
    OrderItem.count = async () => 2;
    OrderItem.findAll = async () => [
      {
        id: 2,
        order: { orderNumber: 'HISTORICAL' },
        operationsNote: '优先处理',
        quantity: 3,
        purchase: {
          purchaseQuantity: 5,
          purchasePlatform: '停用的旧平台',
          shippingMode: 'FBA',
          allocatable: '是',
        },
      },
      { id: 1, order: { orderNumber: 'EMPTY' }, purchase: {} },
    ];
    DictionaryOption.findAll = async ({ where }) => {
      assert.deepEqual(where, { active: true });
      return choices.map((value) => ({ kind: 'purchasePlatform', value }));
    };
    const workbook = await exportPurchaseTemplate();
    const sheet = workbook.worksheets[0];
    const options = workbook.getWorksheet('_purchase_options');
    assert.equal(sheet.name, '采购信息');
    assert.equal(sheet.columnCount, 15);
    assert.equal(sheet.getCell('O1').value, '运营备注');
    assert.equal(sheet.getCell('O2').value, '优先处理');
    assert.equal(sheet.getCell('D1').value, '商品数量');
    assert.equal(sheet.getCell('E1').value, '采购数量');
    assert.equal(sheet.getCell('D2').value, 3);
    assert.equal(sheet.getCell('E2').value, 5);
    assert.equal(sheet.getCell('E3').value ?? '', '');
    assert.equal(sheet.rowCount, 3);
    assert.deepEqual(
      sheet.getRow(1).values.slice(1),
      purchaseTemplateColumns.map((c) => c.header),
    );
    assert.equal(options.state, 'veryHidden');
    assert.deepEqual(
      choices.map((_, index) => options.getCell(index + 2, 1).value),
      choices,
    );
    assert.equal(sheet.getCell('I2').value, '停用的旧平台');
    assert.ok(!choices.includes(sheet.getCell('I2').value));
    assert.equal(sheet.getCell('I3').value ?? '', '');
    for (const [column, key, expected] of [
      ['I', 'purchasePlatform', choices],
      ['J', 'shippingMode', ['FBM', 'FBA']],
      ['M', 'allocatable', ['是', '否']],
    ]) {
      const sourceColumn = { I: 'A', J: 'B', M: 'C' }[column];
      const name = `purchase_options_${key}`;
      assert.deepEqual(workbook.definedNames.getRanges(name).ranges, [
        `'_purchase_options'!$${sourceColumn}$2:$${sourceColumn}$${expected.length + 1}`,
      ]);
      assert.deepEqual(
        expected.map((_, index) => options.getCell(`${sourceColumn}${index + 2}`).value),
        expected,
      );
      for (const row of [2, 3]) {
        const validation = sheet.getCell(`${column}${row}`).dataValidation;
        assert.equal(validation.type, 'list');
        assert.equal(validation.allowBlank, true);
        assert.equal(validation.showErrorMessage, true);
        assert.equal(validation.errorStyle, 'stop');
        assert.deepEqual(validation.formulae, [name]);
      }
    }
    assert.equal(sheet.getCell('G2').dataValidation?.type, undefined);
    assert.equal(sheet.getCell('I1').dataValidation?.type, undefined);

    // 下一次导出必须重新读取维护后的选项，旧下载文件保留当时的快照。
    choices = ['平台新名称'];
    const updated = await exportPurchaseTemplate();
    assert.equal(updated.getWorksheet('_purchase_options').getCell('A2').value, '平台新名称');
    assert.deepEqual(updated.definedNames.getRanges('purchase_options_purchasePlatform').ranges, [
      "'_purchase_options'!$A$2",
    ]);
    assert.equal(options.getCell('A2').value, 'Amazon');

    choices = [];
    const empty = await exportPurchaseTemplate();
    assert.equal(empty.getWorksheet('_purchase_options').getCell('A2').value ?? '', '');
    assert.equal(empty.worksheets[0].getCell('I2').value, '停用的旧平台');
    assert.equal(empty.worksheets[0].getCell('I3').dataValidation.allowBlank, true);
  } finally {
    OrderItem.count = originals.count;
    OrderItem.findAll = originals.findAll;
    DictionaryOption.findAll = originals.options;
  }
});
