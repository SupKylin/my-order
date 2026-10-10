import ExcelJS from 'exceljs';
import { Op } from 'sequelize';
import { fields } from '../fields.js';
import { OrderItem, serializeItem } from '../models.js';
import { assert } from '../errors.js';
import { buildFilters } from './orders.js';
import { getFieldDefinitions } from './dictionaries.js';
import { createProductThumbnails } from '../lib/excel/product-thumbnails.js';

const batchSize = 500;
const maxRows = 1_048_575;
const columns = [
  ...fields.map(({ key, label }) => ({ key, header: label })),
  { key: 'assigneeName', header: '采购人员' },
  { key: 'addressRisk', header: '风险地址标记' },
  { key: 'addressRiskNote', header: '风险地址备注' },
];
export const purchaseTemplateColumns = [
  ['shopName', '店铺名'],
  ['orderNumber', '订单号'],
  ['walmartSku', 'WalmartSku'],
  ['quantity', '数量'],
  ['purchaseUrl', '采购商品链接'],
  ['purchaseSku', '采购Sku'],
  ['purchaseLinkAmount', '采购商品链接金额'],
  ['purchasePlatform', '采购平台'],
  ['shippingMode', '发货方式（FBA/FBM）'],
  ['merchantName', '采购商家名'],
  ['purchaseLimit', '采购限价'],
  ['allocatable', '是否可分配'],
  ['unallocatableReason', '不可分配原因'],
  ['operationsNote', '运营备注'],
].map(([key, header]) => ({ key, header }));

export function exportRow(item, selectedColumns = columns) {
  const row = serializeItem(item);
  return selectedColumns.map(({ key }) => {
    if (key === 'addressRisk') return row.addressRisk ? '风险地址' : '';
    const value =
      key === 'assigneeName' ? row.assignee?.displayName || row.assignee?.username : row[key];
    if (Array.isArray(value)) return value.join('、');
    if (value instanceof Date)
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(value);
    return value ?? '';
  });
}

/** 使用命名区域承载选项，避免内联列表的长度限制及名称中逗号被拆分。 */
function createDropdownSources(workbook, selectedColumns, definitions) {
  const dropdowns = selectedColumns.flatMap(({ key }, index) => {
    const field = definitions.find((definition) => definition.key === key);
    return field?.type === 'select'
      ? [{ column: index + 1, key, choices: field.options || [] }]
      : [];
  });
  if (!dropdowns.length) return [];
  const optionsSheet = workbook.addWorksheet('_purchase_options', { state: 'veryHidden' });
  optionsSheet.addRow(dropdowns.map(({ key }) => key)).commit();
  const optionCount = Math.max(1, ...dropdowns.map(({ choices }) => choices.length));
  for (let index = 0; index < optionCount; index += 1) {
    optionsSheet.addRow(dropdowns.map(({ choices }) => choices[index] ?? '')).commit();
  }
  const validations = dropdowns.map(({ column, key, choices }, index) => {
    const letter = optionsSheet.getColumn(index + 1).letter;
    const name = `purchase_options_${key}`;
    // 无启用选项时仍指向一个空单元格，仅允许留空。
    workbook.definedNames.add(
      `'${optionsSheet.name}'!$${letter}$2:$${letter}$${Math.max(1, choices.length) + 1}`,
      name,
    );
    return {
      column,
      validation: {
        type: 'list',
        allowBlank: true,
        formulae: [name],
        showErrorMessage: true,
        errorStyle: 'stop',
        errorTitle: '选项无效',
        error: '请从下拉列表中选择，或留空。',
      },
    };
  });
  optionsSheet.commit();
  return validations;
}

export async function exportOrders(
  input,
  res,
  purchaseTemplate = false,
  { progress = () => {}, cache, user } = {},
) {
  // 两类导出均复用列表筛选条件；勾选状态、分页参数不能缩小或绕过筛选范围。
  const filters = buildFilters(input.filters || {}, Date.now(), user);
  const selectedColumns = purchaseTemplate ? purchaseTemplateColumns : columns;
  let lastId = null;
  const fetchBatch = () =>
    OrderItem.findAll({
      ...filters,
      where: lastId ? { [Op.and]: [filters.where, { id: { [Op.lt]: lastId } }] } : filters.where,
      order: [['id', 'DESC']],
      limit: batchSize,
      subQuery: false,
    });
  const count = await OrderItem.count({
    ...filters,
    distinct: true,
    col: 'id',
  });
  assert(count <= maxRows, '导出超过 Excel 单表行数上限，请缩小筛选范围');
  if (res.locals) res.locals.auditTotal = count;
  let batch = await fetchBatch();
  assert(batch.length, '没有可导出的订单');
  const definitions = purchaseTemplate ? await getFieldDefinitions() : [];

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${purchaseTemplate ? 'purchase-template' : 'orders'}.xlsx"`,
  );
  // ExcelJS 流式工作表不支持单元格嵌入图片，完整订单导出使用普通工作簿。
  const workbook = purchaseTemplate
    ? new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true })
    : new ExcelJS.Workbook();
  const thumbnails = purchaseTemplate ? null : createProductThumbnails(workbook, cache);
  let completedRows = 0;
  const imageColumn = selectedColumns.findIndex(({ key }) => key === 'productImage') + 1;
  const sheet = workbook.addWorksheet(purchaseTemplate ? '采购信息' : '订单明细', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = selectedColumns.map(({ key, header }) => ({
    header,
    width: key === 'purchaseUrl' ? 40 : 22,
    style: { numFmt: key === 'quantity' ? '0' : '@' },
  }));
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: selectedColumns.length } };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  const dropdowns = createDropdownSources(workbook, selectedColumns, definitions);
  do {
    if (thumbnails)
      await thumbnails.prepare(batch, (completedImages, imageCount) => {
        progress({ stage: 'images', completedRows, totalRows: count, completedImages, imageCount });
      });
    for (const item of batch) {
      const row = sheet.addRow(exportRow(item, selectedColumns));
      for (const { column, validation } of dropdowns) {
        row.getCell(column).dataValidation = validation;
      }
      if (thumbnails) thumbnails.add(sheet, row, imageColumn, item.productImage);
      row.commit();
      completedRows += 1;
    }
    if (batch.length < batchSize) break;
    lastId = batch.at(-1).id;
    batch = await fetchBatch();
  } while (batch.length);
  progress({ stage: 'packing', completedRows, totalRows: count });
  if (purchaseTemplate) {
    sheet.commit();
    await workbook.commit();
  } else {
    await workbook.xlsx.write(res);
    res.end();
  }
  progress({ stage: 'done', completedRows, totalRows: count });
}
