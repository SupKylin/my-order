// 开发验收辅助，只创建或清理名称明确的 QA-UI 测试数据。
import fs from 'node:fs/promises';
import path from 'node:path';
import { Op } from 'sequelize';
import { backendRoot } from '../src/config.js';
import {
  db,
  Order,
  OrderItem,
  ImportTemplate,
  ImportJob,
  Upload,
  AuditLog,
} from '../src/models.js';
import { uploadPath, imageDir } from '../src/services/storage.js';
const manifestPath = path.resolve(backendRoot, '../logs/ui-fixture.json');
if (process.argv[2] === 'clean') {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.orderNumber !== 'QA-UI-20260930') throw new Error('验收数据标识不匹配');
  const order = await Order.findOne({ where: { orderNumber: manifest.orderNumber } });
  const items = order ? await OrderItem.findAll({ where: { orderId: order.id } }) : [];
  if (order) await order.destroy();
  await ImportJob.destroy({ where: { id: { [Op.in]: manifest.jobIds } } });
  await ImportTemplate.destroy({ where: { id: manifest.templateId, name: '[验收] QA UI 模板' } });
  await AuditLog.destroy({
    where: {
      [Op.or]: [
        { entityId: { [Op.in]: manifest.jobIds } },
        ...items.map((item) => ({
          entityId: String(item.id),
          action: { [Op.in]: ['edit_item', 'create_item'] },
        })),
      ],
    },
  });
  const assignments = await AuditLog.findAll({ where: { action: 'assign_items' } });
  const itemIds = items.map((i) => i.id);
  for (const log of assignments)
    if (log.details?.itemIds?.length && log.details.itemIds.every((id) => itemIds.includes(id)))
      await log.destroy();
  for (const id of manifest.uploadIds) {
    const upload = await Upload.findByPk(id);
    if (!upload) continue;
    await fs.rm(uploadPath(upload), { force: true });
    if (upload.kind === 'image')
      await fs.rm(path.join(imageDir, `${id}.thumb.webp`), { force: true });
    await upload.destroy();
  }
  console.log('页面验收订单、模板、导入记录和图片已清理。');
  await db.close();
} else if (process.argv[2] === 'seed') {
  let cookie = '',
    csrf = '';
  const call = async (url, method = 'GET', body) => {
    const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await fetch('http://127.0.0.1:3000/api' + url, {
      method,
      headers,
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const result = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(result));
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    if (result.csrfToken) csrf = result.csrfToken;
    return result;
  };
  await call('/auth/login', 'POST', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD,
  });
  const form = new FormData();
  form.append(
    'file',
    new Blob([await fs.readFile(path.resolve(backendRoot, '../logs/QA-UI-import.xlsx'))]),
    'QA-UI-import.xlsx',
  );
  const upload = await call('/uploads/excel', 'POST', form);
  const template = await call('/templates', 'POST', {
    name: '[验收] QA UI 模板',
    sheetName: upload.sheetName,
    headerRow: 1,
    mappings: upload.columns
      .filter((c) => c.suggestedField)
      .map((c) => ({ column: c.column, header: c.header, field: c.suggestedField })),
  });
  const preview = await call('/imports/preview', 'POST', {
    uploadId: upload.id,
    templateId: template.id,
  });
  const result = await call(`/imports/${preview.id}/commit`, 'POST');
  const images = preview.rows
    .map((r) => r.patch.productImage)
    .filter(Boolean)
    .map((p) => path.basename(p, '.webp'));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        orderNumber: 'QA-UI-20260930',
        templateId: template.id,
        jobIds: [preview.id],
        uploadIds: [upload.id, ...images],
      },
      null,
      2,
    ),
  );
  await call('/auth/logout', 'POST');
  console.log(
    JSON.stringify({
      added: result.added,
      updated: result.updated,
      templateId: template.id,
      hasEmbeddedImage: images.length > 0,
    }),
  );
  await db.close();
} else {
  console.log('仅接受 seed 或 clean 参数。');
  await db.close();
  process.exitCode = 1;
}
