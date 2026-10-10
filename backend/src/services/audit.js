import { Op, literal } from 'sequelize';
import { randomUUID } from 'node:crypto';
import {
  db,
  AuditLog,
  User,
  Store,
  OrderItem,
  Purchase,
  ImportTemplate,
  ImportJob,
  DictionaryOption,
  RiskAddress,
  Upload,
} from '../models.js';
import { auditContext, auditCutoff, safeAuditValue } from '../lib/audit-context.js';
import { assert } from '../errors.js';

let installed = false;
const pending = new Set();
function track(promise) {
  pending.add(promise);
  promise
    .catch((error) => console.error('操作日志写入失败', error.message))
    .finally(() => pending.delete(promise));
}
export const drainAudit = () => Promise.allSettled([...pending]);

/** 字段日志和业务修改共用事务，回滚时不会留下成功修改的假记录。 */
export function installAuditHooks() {
  if (installed) return;
  installed = true;
  AuditLog.addHook('beforeCreate', 'auditMetadata', (row) => {
    const context = auditContext.getStore();
    row.details = safeAuditValue({
      ...row.details,
      ...(context
        ? {
            actor: context.actor,
            requestId: context.id,
            method: context.method,
            path: context.path,
          }
        : {}),
    });
  });
  for (const [model, resource] of [
    [User, 'users'],
    [Store, 'stores'],
    [OrderItem, 'orders'],
    [Purchase, 'purchases'],
    [ImportTemplate, 'templates'],
    [ImportJob, 'imports'],
    [DictionaryOption, 'dictionaries'],
    [RiskAddress, 'risk-addresses'],
    [Upload, 'uploads'],
  ]) {
    const write = async (instance, action, options, before = null) => {
      const context = auditContext.getStore();
      if (!context) return;
      const after = action === 'delete_record' ? null : instance.get({ plain: true });
      const changes = {};
      for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
        if (
          [
            'createdAt',
            'updatedAt',
            'version',
            'orderIdentityKey',
            'purchaseChannelKey',
            'addressKey',
            'walmart',
            'rows',
            'errors',
            'warnings',
            'templateSnapshot',
          ].includes(key)
        )
          continue;
        if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null))
          changes[key] = {
            before: safeAuditValue(before?.[key] ?? null, key),
            after: safeAuditValue(after?.[key] ?? null, key),
          };
      }
      if (action === 'update_record' && !Object.keys(changes).length) return;
      await AuditLog.create(
        {
          userId: context.actor.id,
          action,
          entityId: String(instance.id),
          details: {
            resource,
            changes,
            ...(model === Purchase ? { itemId: instance.itemId } : {}),
          },
        },
        { transaction: options.transaction },
      );
    };
    model.addHook('afterCreate', 'auditCreate', (row, options) =>
      write(row, 'create_record', options),
    );
    model.addHook('afterUpdate', 'auditUpdate', (row, options) =>
      write(row, 'update_record', options, { ...row.get({ plain: true }), ...row.previous() }),
    );
    model.addHook('afterDestroy', 'auditDelete', (row, options) =>
      write(row, 'delete_record', options, row.get({ plain: true })),
    );
    model.addHook('beforeBulkDestroy', 'auditBulkDelete', async (options) => {
      if (!auditContext.getStore() || options.individualHooks) return;
      const rows = await model.findAll({ where: options.where, transaction: options.transaction });
      for (const row of rows) await write(row, 'delete_record', options, row.get({ plain: true }));
    });
  }
}

/** 只审计账号操作：查看（包括失败请求）和 Walmart 内部同步不进入审计上下文。 */
export function auditRequests(req, res, next) {
  if (
    ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
    /^\/stores\/[^/]+\/walmart\/(sync|preview)\/?$/.test(req.path)
  )
    return auditContext.run(undefined, next);
  const context = {
    actor: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      role: req.user.role,
    },
    id: randomUUID(),
    method: req.method,
    path: req.originalUrl.split('?')[0],
  };
  let summary = {};
  const json = res.json;
  res.json = function (body) {
    summary = {
      total: body?.total ?? (Array.isArray(body) ? body.length : undefined),
      updated: body?.updated,
      skipped: body?.skipped,
      message: res.statusCode >= 400 ? body?.message : undefined,
    };
    return json.call(this, body);
  };
  res.once('finish', () => {
    const action =
      res.statusCode >= 400
        ? 'request_failed'
        : req.path.includes('/export')
          ? 'export'
          : 'operation';
    track(
      AuditLog.create({
        userId: req.user.id,
        action,
        entityId: String(req.params?.id || '').slice(0, 100),
        details: safeAuditValue({
          actor: context.actor,
          requestId: context.id,
          method: req.method,
          path: context.path,
          status: res.statusCode,
          filters: req.body?.filters,
          ...summary,
          total: res.locals.auditTotal ?? summary.total,
        }),
      }),
    );
  });
  auditContext.run(context, next);
}

function logWhere(user) {
  return {
    createdAt: { [Op.gte]: auditCutoff() },
    ...(user.role === 'admin' ? {} : { userId: user.id }),
  };
}
export async function listAudit(query, user) {
  const where = logWhere(user);
  const page = Number(query.page || 1),
    pageSize = Number(query.pageSize || 20);
  assert(
    Number.isSafeInteger(page) && page > 0 && page <= 1000000 && [20, 50, 100].includes(pageSize),
    '分页参数无效',
  );
  if (query.action) {
    assert(typeof query.action === 'string' && query.action.length <= 64, '操作类型无效');
    where.action = query.action;
  }
  if (query.userId) {
    assert(
      user.role === 'admin' || Number(query.userId) === user.id,
      '只能查看自己的操作日志',
      403,
    );
    assert(Number.isSafeInteger(Number(query.userId)) && Number(query.userId) > 0, '账号无效');
    where.userId = Number(query.userId);
  }
  if (query.q) {
    assert(typeof query.q === 'string' && query.q.length <= 100, '关键词最多100字');
    const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    where[Op.or] = [{ entityId: { [Op.like]: like } }, { action: { [Op.like]: like } }];
  }
  for (const [key, op] of [
    ['startDate', Op.gte],
    ['endDate', Op.lt],
  ]) {
    if (!query[key]) continue;
    assert(/^\d{4}-\d{2}-\d{2}$/.test(query[key]), '日期格式无效');
    const date = new Date(`${query[key]}T00:00:00+08:00`);
    assert(
      Number.isFinite(date.getTime()) &&
        new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) === query[key],
      '日期无效',
    );
    if (key === 'endDate') date.setTime(date.getTime() + 86400000);
    where.createdAt[op] = key === 'startDate' && date < auditCutoff() ? auditCutoff() : date;
  }
  assert(
    !where.createdAt[Op.lt] || !query.startDate || query.startDate <= query.endDate,
    '开始日期不能晚于结束日期',
  );
  const result = await AuditLog.findAndCountAll({
    where,
    // 列表仅取摘要，字段前后值按需在详情接口读取，避免翻页传输大段 JSON。
    attributes: [
      'id',
      'userId',
      'action',
      'entityId',
      'createdAt',
      [literal("JSON_EXTRACT(details, '$.actor')"), 'actorSnapshot'],
      [literal("JSON_UNQUOTE(JSON_EXTRACT(details, '$.resource'))"), 'resource'],
      [literal("JSON_UNQUOTE(JSON_EXTRACT(details, '$.path'))"), 'path'],
      [literal("JSON_UNQUOTE(JSON_EXTRACT(details, '$.status'))"), 'status'],
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const users = await User.findAll({
    where: { id: [...new Set(result.rows.map((row) => row.userId).filter(Boolean))] },
    attributes: ['id', 'username', 'displayName'],
  });
  const byId = new Map(users.map((row) => [row.id, row.toJSON()]));
  return {
    page,
    pageSize,
    total: result.count,
    rows: result.rows.map((instance) => {
      const row = instance.toJSON();
      const actor =
        typeof row.actorSnapshot === 'string' ? JSON.parse(row.actorSnapshot) : row.actorSnapshot;
      return {
        id: row.id,
        userId: row.userId,
        actor: actor || byId.get(row.userId) || { displayName: '系统/已删除账号' },
        action: row.action,
        entityId: row.entityId,
        createdAt: row.createdAt,
        resource: row.resource || row.path || '',
        status: Number(row.status || 200),
        importId: ['import_purchases', 'import_orders'].includes(row.action) ? row.entityId : null,
      };
    }),
  };
}
export async function getAudit(id, user) {
  const row = await AuditLog.findOne({ where: { ...logWhere(user), id } });
  assert(row, '日志不存在或无权查看', 404);
  return { ...row.toJSON(), details: safeAuditValue(row.details) };
}

/** 小批量删除利用时间索引；不删除订单、导入报告或上传文件。 */
export async function cleanupAudit(now = new Date(), maxBatches = 10) {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const [, meta] = await db.query(
      'DELETE FROM audit_logs WHERE createdAt < :cutoff ORDER BY createdAt LIMIT 1000',
      { replacements: { cutoff: auditCutoff(now) } },
    );
    const count = Number(meta.affectedRows || 0);
    total += count;
    if (count < 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return total;
}
export function startAuditCleanup() {
  let running;
  const run = () => {
    if (!running)
      running = cleanupAudit()
        .catch((error) => console.error('过期操作日志清理失败', error.message))
        .finally(() => {
          running = null;
        });
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
    await drainAudit();
  };
}
