import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import {
  db,
  Upload,
  ImportTemplate,
  ImportJob,
  OrderItem,
  Order,
  Purchase,
  AuditLog,
} from '../models.js';
import { uploadPath, saveImage } from './storage.js';
import { validatePatch } from '../validation.js';
import { templatePayload } from './templates.js';
import { getFieldDefinitions } from './dictionaries.js';
import { upsertImported } from './orders.js';
import { AppError, assert } from '../errors.js';
import { IMPORT_MATCH_RULE, PURCHASE_MATCH_RULE } from '../lib/order-identity.js';
import { matchImportRows, matchPurchaseRows } from '../lib/import-matching.js';
import { fieldMap } from '../fields.js';
import { purchaseFingerprint } from '../lib/order-concurrency.js';
import { allowedStoreNames, NO_STORE_PERMISSION } from '../permissions.js';
import {
  assertPurchaseImport,
  isWfsOrder,
  WFS_READ_ONLY_REASON,
} from '../lib/order-write-policy.js';

const importRowOrder = (a, b) =>
  a.patch.orderNumber.localeCompare(b.patch.orderNumber) ||
  (a.sequence ?? a.rowNumber) - (b.sequence ?? b.rowNumber);

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
  if (kind === 'purchase') {
    assert(
      selected.some(
        (mapping) =>
          mapping.field !== 'purchaseChannel' && fieldMap[mapping.field].group === 'purchase',
      ),
      '采购导入至少需要映射一个采购字段',
    );
    for (const key of ['shopName', 'orderNumber', 'walmartSku'])
      assert(
        selected.some((mapping) => mapping.field === key),
        `采购导入必须映射${fieldMap[key].label}`,
      );
  } else assert(!template.purchaseChannelId, '订单导入不能绑定采购渠道');
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
  assertPurchaseImport(kind);
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
  const allowed = await allowedStoreNames(user);
  const snapshots = [];
  const ignoredStatusSources = new Set();
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
    // 工作表属于本次文件选择，绝不复用旧模板中保存的工作表。
    assert(typeof entry.sheetName === 'string' && entry.sheetName.trim(), '请选择本次导入的工作表');
    template.sheetName = entry.sheetName;
    validateImportMappings(template, kind);
    firstTemplate ||= template;
    const ignoreStatus =
      user.role === 'operations' &&
      template.mappings.some((mapping) => mapping.field === 'purchaseStatus');
    if (ignoreStatus) ignoredStatusSources.add(upload.id);
    const extracted = await extractRows(
      await loadWorkbook(uploadPath(upload)),
      ignoreStatus
        ? {
            ...template,
            mappings: template.mappings.filter((mapping) => mapping.field !== 'purchaseStatus'),
          }
        : template,
      (buffer) => saveImage(buffer, user.id, upload.originalName),
      fieldDefinitions,
      { allowedStoreNames: allowed, retainInvalidIdentity: kind === 'purchase' },
    );
    if (ignoreStatus)
      extracted.warnings.push({
        row: template.headerRow,
        field: 'purchaseStatus',
        message: '运营账号无权修改采购状态，已跳过该字段并保留原值',
      });
    for (const key of ['rows', 'errors', 'warnings'])
      data[key].push(
        ...extracted[key].map((row) => ({
          ...row,
          sourceId: upload.id,
          sourceName: upload.originalName,
          ...(key === 'rows'
            ? {
                purchaseSkuMapped: template.mappings.some(
                  (mapping) => mapping.field === 'purchaseSku',
                ),
              }
            : {}),
        })),
      );
    snapshots.push({
      uploadId: upload.id,
      name: upload.originalName,
      templateId: source.id || null,
      sheetName: template.sheetName,
    });
  }
  const template = {
    ...firstTemplate,
    matchRule: kind === 'purchase' ? PURCHASE_MATCH_RULE : IMPORT_MATCH_RULE,
    importKind: kind,
    sources: snapshots,
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
          { model: Purchase, as: 'purchase', required: false },
        ],
        attributes: ['id', 'walmartSku', 'shopName', 'version', 'fulfillmentParty'],
        ...(allowed ? { where: { shopName: [...allowed] } } : {}),
        order: [['id', 'ASC']],
      })
    : [];
  const sortedRows = [...data.rows].sort(importRowOrder);
  // 采购重复行按上传文件顺序、文件内行顺序更新，后面的非空字段生效。
  if (kind === 'purchase') {
    data.rows.forEach((row, index) => {
      row.sequence = index;
    });
    sortedRows.sort(importRowOrder);
  }
  const existingRows = existing.map((item) => ({
    id: item.id,
    version: item.version,
    purchaseFingerprint: purchaseFingerprint(item.purchase),
    orderNumber: item.order.orderNumber,
    walmartSku: item.walmartSku,
    shopName: item.shopName,
    purchaseSku: item.purchase?.purchaseSku,
    fulfillmentParty: item.fulfillmentParty,
  }));
  const purchaseMatches = kind === 'purchase' ? matchPurchaseRows(sortedRows, existingRows) : [];
  const sortedTargets =
    kind === 'purchase'
      ? purchaseMatches.map((match) => match.target)
      : matchImportRows(sortedRows, existingRows, kind);
  for (const [index, row] of sortedRows.entries()) {
    if (allowed && !allowed.has(row.patch.shopName)) {
      row.action = 'missing';
      row.skipReason = NO_STORE_PERMISSION;
      row.expectedId = null;
      row.expectedVersion = null;
      continue;
    }
    const old = sortedTargets[index];
    row.action = old ? 'update' : kind === 'purchase' ? 'missing' : 'create';
    row.expectedId = old?.id || null;
    row.expectedVersion = old?.version || null;
    if (kind === 'purchase' && old) row.expectedPurchaseFingerprint = old.purchaseFingerprint;
    if (row.action === 'missing') row.skipReason = purchaseMatches[index].reason;
    if (old && isWfsOrder(old)) {
      row.action = 'missing';
      row.skipReason = WFS_READ_ONLY_REASON;
    }
    if (
      kind === 'purchase' &&
      !Object.keys(row.patch).some((key) => fieldMap[key]?.group === 'purchase') &&
      !row.purchaseSkuMapped &&
      !data.errors.some(
        (error) => error.sourceId === row.sourceId && error.row === row.rowNumber,
      ) &&
      row.action !== 'missing'
    ) {
      if (ignoredStatusSources.has(row.sourceId)) {
        row.action = 'missing';
        row.skipReason = '运营账号无权修改采购状态，本行没有其他可更新的采购字段';
      } else
        data.errors.push({
          row: row.rowNumber,
          sourceName: row.sourceName,
          label: '采购字段',
          message: '本行没有可更新的采购字段',
        });
    }
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
    ...skippedResult(rows),
    errorCount: job.errors.length,
    blockingErrorCount: blockingImportErrors(job).length,
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

/** 未匹配行的错误保留报告，但不阻塞；无法关联到行的错误继续阻塞旧预览。 */
function blockingImportErrors(job) {
  if (job.templateSnapshot.importKind !== 'purchase') return job.errors;
  const rowKey = (source, row) => JSON.stringify([source.sourceId || source.sourceName || '', row]);
  const skipped = new Set(
    job.rows.filter((row) => row.action === 'missing').map((row) => rowKey(row, row.rowNumber)),
  );
  return job.errors.filter((error) => !skipped.has(rowKey(error, error.row)));
}

/** 完整保留未匹配清单，预览、提交结果及历史记录使用同一份报告。 */
function skippedResult(rows) {
  const skippedRows = rows
    .filter((row) => row.action === 'missing')
    .map((row) => ({
      rowNumber: row.rowNumber,
      sourceName: row.sourceName,
      shopName: row.patch.shopName || '',
      orderNumber: row.patch.orderNumber,
      walmartSku: row.patch.walmartSku || '',
      reason: row.skipReason || '系统内不存在三项完全一致的订单商品明细',
    }));
  return { skipped: skippedRows.length, skippedRows };
}
/** 幂等提交预览；版本冲突或匹配行的校验错误中止整个事务。 */
export async function commitImport(id, user, kind = 'legacy') {
  assertPurchaseImport(kind);
  return db.transaction(async (t) => {
    const job = await ImportJob.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    assert(job, '导入预览不存在', 404);
    assert(job.createdBy === user.id, '请由生成预览的账号确认导入', 403);
    assert((job.templateSnapshot.importKind || 'legacy') === kind, '请使用对应的导入入口确认', 409);
    if (job.status === 'completed')
      return {
        id: job.id,
        added: job.added,
        updated: job.updated,
        ...skippedResult(job.rows),
        alreadyCompleted: true,
      };
    assert(
      job.templateSnapshot.matchRule ===
        (kind === 'purchase' ? PURCHASE_MATCH_RULE : IMPORT_MATCH_RULE),
      '导入匹配规则已更新，请重新预览',
      409,
    );
    assert(!blockingImportErrors(job).length, '存在错误行，请修正 Excel 后重新预览');
    // 不能按已停用字段的旧预览提交，重新预览会保留源列并解除该映射。
    assert(
      !job.rows.some((row) => Object.hasOwn(row.patch || {}, 'supervisorConfirmed')),
      '主管确认字段已停用，请重新预览后导入',
      409,
    );
    assert(
      Date.now() - new Date(job.createdAt).getTime() < 2 * 60 * 60 * 1000,
      '预览已超过 2 小时，请重新生成',
    );
    let added = 0,
      updated = 0;
    const allowed = await allowedStoreNames(user, t);
    // 角色可能在预览后变化，旧预览提交时也不能绕过字段权限。
    for (const row of job.rows) {
      delete row.patch.purchaseChannel;
      if (user.role !== 'operations' || !Object.hasOwn(row.patch, 'purchaseStatus')) continue;
      delete row.patch.purchaseStatus;
      job.warnings.push({
        row: row.rowNumber,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        field: 'purchaseStatus',
        message: '运营账号无权修改采购状态，已跳过该字段并保留原值',
      });
      if (
        row.action === 'update' &&
        !Object.keys(row.patch).some((key) => fieldMap[key]?.group === 'purchase') &&
        !row.purchaseSkuMapped
      ) {
        row.action = 'missing';
        row.skipReason = '运营账号无权修改采购状态，本行没有其他可更新的采购字段';
      }
    }
    // 店铺归属在预览后可能变化，提交前重新授权，越权行单独跳过。
    if (allowed)
      for (const row of job.rows) {
        if (!allowed.has(row.patch.shopName)) {
          row.action = 'missing';
          row.skipReason = NO_STORE_PERMISSION;
        }
      }
    // 统一锁顺序，降低多人导入相同订单时死锁的概率。
    // 未匹配行只生成报告，不查找/创建订单，提交时也不会转为新增。
    const sorted = job.rows
      .filter((row) => kind !== 'purchase' || row.action === 'update')
      .sort(importRowOrder);
    const orderRows = new Map();
    for (const row of sorted) {
      const number = row.patch.orderNumber;
      if (!orderRows.has(number)) orderRows.set(number, []);
      orderRows.get(number).push(row);
    }
    const targets = new Map();
    for (const [orderNumber, rows] of orderRows) {
      const order =
        kind === 'purchase'
          ? await Order.findOne({ where: { orderNumber }, transaction: t, lock: t.LOCK.UPDATE })
          : (await Order.findOrCreate({ where: { orderNumber }, transaction: t }))[0];
      assert(order, '匹配订单在预览后已被删除，请重新预览', 409);
      await order.reload({ transaction: t, lock: t.LOCK.UPDATE });
      // 同订单只读取一次锁定快照，本批新增不能改变后续行的目标。
      const items = await OrderItem.findAll({
        where: { orderId: order.id },
        include: [{ model: Purchase, as: 'purchase', required: false }],
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
    // 同一 Excel 多行可更新同一已有明细，先核对导入前版本，再按文件/行顺序写入。
    for (const row of sorted) {
      const item = targets.get(row);
      // 预览后可能被官方同步改为 WFS；提交时用锁定的当前值再次检查并记录跳过。
      if (item && isWfsOrder(item)) {
        row.action = 'missing';
        row.skipReason = WFS_READ_ONLY_REASON;
        continue;
      }
      // 新预览核对采购快照，平台同步不构成采购冲突；旧预览继续严格校验版本。
      const changed =
        kind === 'purchase' && row.expectedPurchaseFingerprint
          ? purchaseFingerprint(item?.purchase) !== row.expectedPurchaseFingerprint
          : (item?.version || null) !== row.expectedVersion;
      if ((item?.id || null) !== row.expectedId || changed)
        throw new AppError(
          409,
          `第 ${row.rowNumber} 行对应商品在预览后发生变化，请重新预览，避免覆盖他人修改`,
        );
      if (kind === 'purchase') assert(item, '采购导入仅允许更新已有商品明细，请重新预览', 409);
    }
    for (const row of sorted) {
      if (row.action === 'missing') continue;
      // 兼容升级前生成但尚未提交的预览：采购导入永远不修改渠道。
      if (kind === 'purchase') delete row.patch.purchaseChannel;
      // 预览与提交之间字典可能发生变化；重新验证，防止写入已停用或旧名称。
      try {
        const normalized = validatePatch(row.patch, { requireKeys: true, fieldDefinitions });
        for (const key of ['purchaseChannel', 'purchasePlatform', 'orderStatus', 'purchaseStatus'])
          assert(
            JSON.stringify(normalized[key]) === JSON.stringify(row.patch[key]),
            '字典名称已变化',
          );
      } catch {
        throw new AppError(409, `第 ${row.rowNumber} 行的下拉选项已变化，请重新预览`);
      }
      const item = targets.get(row);
      const result = await upsertImported(row.patch, t, user, item);
      result.created ? added++ : updated++;
    }
    // JSON 内部属性变更需显式标记，保证提交阶段新增的跳过原因保存到历史记录。
    job.changed('rows', true);
    job.changed('warnings', true);
    await job.update(
      {
        status: 'completed',
        rows: job.rows,
        warnings: job.warnings,
        added,
        updated,
        committedAt: new Date(),
      },
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
          skipped: skippedResult(job.rows).skipped,
          filename: (await Upload.findByPk(job.uploadId, { transaction: t }))?.originalName,
          filenames: job.templateSnapshot.sources?.map((source) => source.name),
        },
      },
      { transaction: t },
    );
    return { id: job.id, added, updated, ...skippedResult(job.rows) };
  });
}

export async function listImports(user) {
  const jobs = await ImportJob.findAll({
    ...(user && user.role !== 'admin' ? { where: { createdBy: user.id } } : {}),
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

export async function getImportPreview(id, user) {
  const job = await ImportJob.findByPk(id);
  assert(job, '导入记录不存在', 404);
  assert(!user || user.role === 'admin' || job.createdBy === user.id, '无权查看该导入结果', 403);
  return previewResult(job);
}
