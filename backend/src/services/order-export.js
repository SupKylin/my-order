import ExcelJS from 'exceljs';
import { Op } from 'sequelize';
import { fields } from '../fields.js';
import { OrderItem, itemInclude, serializeItem } from '../models.js';
import { assert } from '../errors.js';
import { buildFilters } from './orders.js';

const batchSize = 500;
const maxRows = 1_048_575;
const columns = [
  ...fields.map(({ key, label }) => ({ key, header: label })),
  { key: 'assigneeName', header: '采购人员' },
];

export function exportRow(item) {
  const row = serializeItem(item);
  return columns.map(({ key }) => {
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

export async function exportOrders(input, res) {
  const ids = input.ids;
  assert(ids === undefined || Array.isArray(ids), '选中订单格式无效');
  assert(!ids || ids.length <= 100, '单次最多导出 100 条勾选订单');
  if (ids)
    assert(
      ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0),
      '选中订单格式无效',
    );

  const filters = ids ? null : buildFilters(input.filters || {}, Date.now());
  const selected = ids ? [...new Set(ids)] : null;
  let lastId = null;
  const fetchBatch = () =>
    OrderItem.findAll({
      ...(selected
        ? { where: { id: { [Op.in]: selected } }, include: itemInclude }
        : {
            ...filters,
            where: lastId
              ? { [Op.and]: [filters.where, { id: { [Op.lt]: lastId } }] }
              : filters.where,
          }),
      order: [['id', 'DESC']],
      limit: batchSize,
      subQuery: false,
    });
  const count = await OrderItem.count({
    ...(selected ? { where: { id: { [Op.in]: selected } }, include: itemInclude } : filters),
    distinct: true,
    col: 'id',
  });
  assert(count <= maxRows, '导出超过 Excel 单表行数上限，请缩小筛选范围');
  let batch = await fetchBatch();
  assert(batch.length, '没有可导出的订单');

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', 'attachment; filename="orders.xlsx"');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const sheet = workbook.addWorksheet('订单明细');
  sheet.columns = columns.map(({ header }) => ({ header, width: 22 }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  do {
    for (const item of batch) {
      sheet.addRow(exportRow(item)).commit();
    }
    if (selected || batch.length < batchSize) break;
    lastId = batch.at(-1).id;
    batch = await fetchBatch();
  } while (batch.length);
  sheet.commit();
  await workbook.commit();
}
