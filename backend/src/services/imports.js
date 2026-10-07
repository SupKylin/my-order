import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import { db, Upload, ImportTemplate, ImportJob, OrderItem, Order, Purchase, AuditLog } from '../models.js';
import { uploadPath, saveImage } from './storage.js';
import { validatePatch } from '../validation.js';
import { templatePayload } from './templates.js';
import { getFieldDefinitions } from './dictionaries.js';
import { upsertImported } from './orders.js';
import { AppError, assert } from '../errors.js';
import { IMPORT_MATCH_RULE } from '../lib/order-identity.js';
import { matchImportRows } from '../lib/import-matching.js';
import { fieldMap } from '../fields.js';

const importRowOrder = (a, b) =>
  a.patch.orderNumber.localeCompare(b.patch.orderNumber) || a.rowNumber - b.rowNumber;

export function validateImportMappings(template, kind) {
  if (kind === 'legacy') return;
  const selected = template.mappings.filter((mapping) => mapping.field);
  const allowed = (field) =>
    kind === 'order'
      ? field.group !== 'purchase'
      : ['orderNumber', 'walmartSku', 'shopName'].includes(field.key) || field.group === 'purchase';
  const invalid = selected.find((mapping) => !allowed(fieldMap[mapping.field]));
  assert(
    !invalid,
    `“${fieldMap[invalid?.field]?.label}”不属于${kind === 'order' ? '订单' : '采购'}导入字段`,
  );
  if (kind === 'purchase')
    assert(
      selected.some((mapping) => fieldMap[mapping.field].group === 'purchase'),
      '采购导入至少需要映射一个采购字段',
    );
  else assert(!template.purchaseChannelId, '订单导入不能绑定采购渠道');
}
export async function getExcelUpload(id) {
  const file = await Upload.findByPk(id);
  assert(file?.kind === 'excel', '上传文件不存在', 404);
  return file;
}
export async function inspectExcel(id, sheetName, headerRow) {
  // 工作簿解析器体积较大，仅在检查或导入 Excel 时加载。
  const { loadWorkbook, workbookInfo } = await import('../lib/excel/index.js');
  return workbookInfo(
    (await loadWorkbook(uploadPath(await getExcelUpload(id)))).workbook,
    sheetName,
    Number(headerRow || 1),
  );
}
/** 预览保存数据快照和目标版本，尚不修改订单。 */
export async function prepareImport(input, user, kind = 'legacy') {
  const { loadWorkbook, extractRows } = await import('../lib/excel/index.js');
  const sources = kind === 'purchase' ? input?.sources : [input];
  assert(
    Array.isArray(sources) &&
      sources.length > 0 &&
      sources.length <= (kind === 'purchase' ? 10 : 1),
    '上传区数量无效',
  );
  assert(
    new Set(sources.map((source) => source.uploadId)).size === sources.length,
    '同一文件不能重复预览',
  );
  const data = { rows: [], errors: [], warnings: [] };
  const snapshots = [];
  let firstTemplate;
  const fieldDefinitions = await getFieldDefinitions();
  for (const entry of sources) {
    assert(entry && typeof entry === 'object' && entry.uploadId, '请选择要导入的 Excel 文件');
    const upload = await getExcelUpload(entry.uploadId);
    assert(upload.uploadedBy === user.id, '只能导入自己上传的文件', 403);
    const source = entry.templateId
      ? await ImportTemplate.findByPk(entry.templateId)
      : entry.template;
    assert(source, '请选择导入模板');
    const template = await templatePayload(source.toJSON ? source.toJSON() : source);
    validateImportMappings(template, kind);
    firstTemplate ||= template;
    const extracted = await extractRows(
      await loadWorkbook(uploadPath(upload)),
      template,
      (buffer) => saveImage(buffer, user.id, upload.originalName),
      fieldDefinitions,
    );
    for (const key of ['rows', 'errors', 'warnings'])
      data[key].push(
        ...extracted[key].map((row) => ({
          ...row,
          sourceName: upload.originalName,
          ...(key === 'rows'
            ? { purchaseSkuMapped: template.mappings.some((mapping) => mapping.field === 'purchaseSku') }
            : {}),
        })),
      );
    snapshots.push({
      uploadId: upload.id,
      name: upload.originalName,
      templateId: source.id || null,
    });
  }
  const template = {
    ...firstTemplate,
    matchRule: IMPORT_MATCH_RULE,
    importKind: kind,
    sources: snapshots,
    purchaseChannel: snapshots.length === 1 ? firstTemplate.purchaseChannel : null,
  };
  assert(
    Buffer.byteLength(JSON.stringify(data.rows), 'utf8') < 8 * 1024 * 1024,
    '导入数据内容过大，请拆分为较小文件',
  );
  const orderNumbers = [...new Set(data.rows.map((r) => r.patch.orderNumber))];
  const existing = orderNumbers.length
    ? await OrderItem.findAll({
        include: [
          { model: Order, as: 'order', where: { orderNumber: { [Op.in]: orderNumbers } } },
          { model: Purchase, as: 'purchase', attributes: ['purchaseSku'], required: false },
        ],
        attributes: ['id', 'walmartSku', 'shopName', 'version'],
        order: [['id', 'ASC']],
      })
    : [];
  const sortedRows = [...data.rows].sort(importRowOrder);
  const sortedTargets = matchImportRows(
    sortedRows,
    existing.map((item) => ({
      id: item.id,
      version: item.version,
      orderNumber: item.order.orderNumber,
      walmartSku: item.walmartSku,
      shopName: item.shopName,
      purchaseSku: item.purchase?.purchaseSku,
    })),
    kind,
  );
  for (const [index, row] of sortedRows.entries()) {
    const old = sortedTargets[index];
    row.action = old ? 'update' : 'create';
    row.expectedId = old?.id || null;
    row.expectedVersion = old?.version || null;
    if (
      kind === 'purchase' &&
      !Object.keys(row.patch).some((key) => fieldMap[key]?.group === 'purchase') &&
      !row.purchaseSkuMapped
    )
      data.errors.push({
        row: row.rowNumber,
        sourceName: row.sourceName,
        label: '采购字段',
        message: '本行没有可更新的采购字段',
      });
  }
  const job = await ImportJob.create({
    id: randomUUID(),
    uploadId: snapshots[0].uploadId,
    templateId: snapshots.length === 1 ? snapshots[0].templateId : null,
    templateSnapshot: template,
    ...data,
    createdBy: user.id,
  });
  return previewResult(job);
}
export function previewResult(job) {
  const rows = job.rows;
  return {
    id: job.id,
    status: job.status,
    total: rows.length,
    added: rows.filter((r) => r.action === 'create').length,
    updated: rows.filter((r) => r.action === 'update').length,
    errorCount: job.errors.length,
    errors: job.errors.slice(0, 200),
    warnings: job.warnings.slice(0, 100),
    rows: rows.slice(0, 100),
    previewLimit: 100,
    importKind: job.templateSnapshot.importKind || 'legacy',
    sources: job.templateSnapshot.sources || [],
    purchaseChannel: job.templateSnapshot.purchaseChannel || null,
    createdAt: job.createdAt,
  };
}
/** 幂等提交预览；版本冲突或任意错误都会中止整个事务。 */
export async function commitImport(id, user, kind = 'legacy') {
  return db.transaction(async (t) => {
    const job = await ImportJob.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    assert(job, '导入预览不存在', 404);
    assert(job.createdBy === user.id, '请由生成预览的账号确认导入', 403);
    assert((job.templateSnapshot.importKind || 'legacy') === kind, '请使用对应的导入入口确认', 409);
    if (job.status === 'completed')
      return { id: job.id, added: job.added, updated: job.updated, alreadyCompleted: true };
    assert(
      job.templateSnapshot.matchRule === IMPORT_MATCH_RULE,
      '导入匹配规则已更新，请重新预览',
      409,
    );
    assert(!job.errors.length, '存在错误行，请修正 Excel 后重新预览');
    assert(
      Date.now() - new Date(job.createdAt).getTime() < 2 * 60 * 60 * 1000,
      '预览已超过 2 小时，请重新生成',
    );
    let added = 0,
      updated = 0;
    // 统一锁顺序，降低多人导入相同订单时死锁的概率。
    const sorted = [...job.rows].sort(importRowOrder);
    const orderRows = new Map();
    for (const row of sorted) {
      const number = row.patch.orderNumber;
      if (!orderRows.has(number)) orderRows.set(number, []);
      orderRows.get(number).push(row);
    }
    const targets = new Map();
    for (const [orderNumber, rows] of orderRows) {
      const [order] = await Order.findOrCreate({ where: { orderNumber }, transaction: t });
      await order.reload({ transaction: t, lock: t.LOCK.UPDATE });
      // 同订单只读取一次锁定快照，本批新增不能改变后续行的目标。
      const items = await OrderItem.findAll({
        where: { orderId: order.id },
        include: [{ model: Purchase, as: 'purchase', attributes: ['purchaseSku'], required: false }],
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const byId = new Map(items.map((item) => [item.id, item]));
      const matches = matchImportRows(
        rows,
        items.map((item) => ({
          id: item.id,
          version: item.version,
          orderNumber,
          walmartSku: item.walmartSku,
          shopName: item.shopName,
          purchaseSku: item.purchase?.purchaseSku,
        })),
        kind,
      );
      rows.forEach((row, index) => targets.set(row, byId.get(matches[index]?.id) || null));
    }
    const fieldDefinitions = await getFieldDefinitions(t);
    for (const row of sorted) {
      // 预览与提交之间字典可能发生变化；重新验证，防止写入已停用或旧名称。
      try {
        const normalized = validatePatch(row.patch, { requireKeys: true, fieldDefinitions });
        for (const key of ['purchaseChannel', 'orderStatus', 'purchaseStatus'])
          assert(
            JSON.stringify(normalized[key]) === JSON.stringify(row.patch[key]),
            '字典名称已变化',
          );
      } catch {
        throw new AppError(409, `第 ${row.rowNumber} 行的下拉选项已变化，请重新预览`);
      }
      const item = targets.get(row);
      if ((item?.id || null) !== row.expectedId || (item?.version || null) !== row.expectedVersion)
        throw new AppError(
          409,
          `第 ${row.rowNumber} 行对应商品在预览后发生变化，请重新预览，避免覆盖他人修改`,
        );
      const result = await upsertImported(row.patch, t, user, item);
      result.created ? added++ : updated++;
    }
    await job.update(
      { status: 'completed', added, updated, committedAt: new Date() },
      { transaction: t },
    );
    await AuditLog.create(
      {
        userId: user.id,
        action: kind === 'purchase' ? 'import_purchases' : 'import_orders',
        entityId: job.id,
        details: {
          added,
          updated,
          filename: (await Upload.findByPk(job.uploadId, { transaction: t }))?.originalName,
          filenames: job.templateSnapshot.sources?.map((source) => source.name),
        },
      },
      { transaction: t },
    );
    return { id: job.id, added, updated };
  });
}

export async function listImports() {
  const jobs = await ImportJob.findAll({
    attributes: [
      'id',
      'uploadId',
      'status',
      'added',
      'updated',
      'createdBy',
      'createdAt',
      'committedAt',
    ],
    limit: 100,
    order: [['createdAt', 'DESC']],
  });
  const uploads = await Upload.findAll({
    where: { id: { [Op.in]: jobs.map((job) => job.uploadId) } },
    attributes: ['id', 'originalName'],
  });
  const names = new Map(uploads.map((upload) => [upload.id, upload.originalName]));
  return jobs.map((job) => ({ ...job.toJSON(), filename: names.get(job.uploadId) || '' }));
}

export async function getImportPreview(id) {
  const job = await ImportJob.findByPk(id);
  assert(job, '导入记录不存在', 404);
  return previewResult(job);
}
