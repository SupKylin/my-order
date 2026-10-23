import { Op } from 'sequelize';
import { db, RiskAddress, AuditLog } from '../models.js';
import { assert } from '../errors.js';
import { loadWorkbook, cellValue } from '../lib/excel/workbook.js';
import { riskAddressColumns, RISK_ADDRESS_IMPORT_MAX_ROWS } from '../lib/risk-address-fields.js';
import { normalizeRiskAddress } from './risk-addresses.js';

export async function importRiskAddresses(file, actor) {
  assert(file?.path && /\.xlsx$/i.test(file.originalname), '请上传 .xlsx 文件');
  const { workbook } = await loadWorkbook(file.path, { maxExpandedBytes: 30 * 1024 * 1024 });
  const sheet = workbook.worksheets[0];
  const columns = new Map();
  sheet.getRow(1).eachCell((cell, index) => {
    const name = cell.text.trim();
    const field = riskAddressColumns.find((field) => field.label === name);
    if (!field) return;
    assert(!columns.has(field.key), `表头“${name}”重复，请修改后重试`);
    columns.set(field.key, index);
  });
  for (const field of riskAddressColumns.filter((field) => field.required))
    assert(columns.has(field.key), `缺少必填表头“${field.label}”，请使用下载的模板`);

  const result = { total: 0, created: 0, duplicate: 0, invalid: 0, skipped: 0, details: [] };
  const candidates = [],
    seen = new Map();
  const skip = (rowNumber, raw, reason, kind) => {
    result[kind]++;
    result.skipped++;
    result.details.push({
      rowNumber,
      ...Object.fromEntries(
        riskAddressColumns
          .filter((f) => f.key !== 'note')
          .map((f) => [f.key, String(raw[f.key] ?? '').slice(0, 255)]),
      ),
      reason,
    });
  };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw = {},
      errors = [];
    for (const field of riskAddressColumns) {
      if (!columns.has(field.key)) continue;
      try {
        const value = cellValue(row.getCell(columns.get(field.key)), { type: 'text' });
        assert(!(value instanceof Date), '请填写文本，不要使用日期格式');
        raw[field.key] = value;
      } catch (error) {
        errors.push(`${field.label}：${error.message}`);
      }
    }
    if (!errors.length && !Object.values(raw).some((value) => String(value ?? '').trim())) return;
    result.total++;
    assert(
      result.total <= RISK_ADDRESS_IMPORT_MAX_ROWS,
      `单次最多导入 ${RISK_ADDRESS_IMPORT_MAX_ROWS} 行，请拆分文件`,
    );
    if (errors.length) return skip(rowNumber, raw, errors.join('；'), 'invalid');
    let values;
    try {
      values = normalizeRiskAddress(raw);
    } catch (error) {
      return skip(rowNumber, raw, error.message, 'invalid');
    }
    if (seen.has(values.addressKey))
      return skip(rowNumber, raw, `与第 ${seen.get(values.addressKey)} 行地址重复`, 'duplicate');
    seen.set(values.addressKey, rowNumber);
    candidates.push({ rowNumber, values });
  });
  assert(result.total, '没有可导入的数据，请从第 2 行开始填写地址');

  await db.transaction(async (transaction) => {
    const existing = new Set();
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const rows = await RiskAddress.findAll({
        where: {
          addressKey: {
            [Op.in]: candidates.slice(offset, offset + 500).map((row) => row.values.addressKey),
          },
        },
        attributes: ['addressKey'],
        transaction,
      });
      rows.forEach((row) => existing.add(row.addressKey));
    }
    // 固定插入顺序，降低同时上传相同地址时的锁冲突。
    for (const { rowNumber, values } of candidates.sort((a, b) =>
      a.values.addressKey.localeCompare(b.values.addressKey),
    )) {
      if (existing.has(values.addressKey)) {
        skip(rowNumber, values, '系统中已存在该地址，保留原有信息', 'duplicate');
        continue;
      }
      try {
        await RiskAddress.create(values, { transaction });
        result.created++;
      } catch (error) {
        // 唯一约束处理并发上传；其他数据库异常交由事务回滚，不能误报导入成功。
        if (error.name !== 'SequelizeUniqueConstraintError') throw error;
        skip(rowNumber, values, '系统中已存在该地址，保留原有信息', 'duplicate');
      }
    }
    await AuditLog.create(
      {
        userId: actor.id,
        action: 'import_risk_addresses',
        details: {
          filename: file.originalname.slice(0, 255),
          sheetName: sheet.name,
          total: result.total,
          created: result.created,
          duplicate: result.duplicate,
          invalid: result.invalid,
          skipped: result.skipped,
        },
      },
      { transaction },
    );
  });
  result.details.sort((a, b) => a.rowNumber - b.rowNumber);
  return result;
}
