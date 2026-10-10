import { AuditLog, db } from '../models.js';

export async function migratePermissionsAudit() {
  await AuditLog.sync();
  const query = db.getQueryInterface();
  // 幂等增量索引，不重建表、不改写现有业务数据。
  for (const [table, name, fields] of [
    ['audit_logs', 'audit_logs_time_id', ['createdAt', 'id']],
    ['audit_logs', 'audit_logs_user_time_id', ['userId', 'createdAt', 'id']],
    ['audit_logs', 'audit_logs_action_time', ['action', 'createdAt']],
    ['import_jobs', 'import_jobs_creator_time', ['createdBy', 'createdAt']],
    ['order_items', 'order_items_shop_date_id', ['shopName', 'orderDate', 'id']],
  ]) {
    const indexes = await query.showIndex(table);
    if (!indexes.some((index) => index.name === name))
      await query.addIndex(table, fields, { name });
  }
}
