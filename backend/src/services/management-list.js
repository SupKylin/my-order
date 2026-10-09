import { Op } from 'sequelize';
import {
  User,
  Store,
  ImportTemplate,
  ImportJob,
  Upload,
  DictionaryOption,
  RiskAddress,
} from '../models.js';
import { WalmartSync } from './walmart/models.js';
import { publicUser } from '../auth.js';
import { dictionaryKinds } from '../dictionaries.js';
import { assert } from '../errors.js';

// 维护页独立使用分页接口，原有下拉框、导入页的全量查询保持兼容。
export const resources = {
  users: {
    model: User,
    search: ['username', 'displayName'],
    filters: { role: ['operations', 'purchasing', 'admin'], active: ['true', 'false'] },
  },
  stores: {
    model: Store,
    search: ['systemStoreName', 'walmartStoreName'],
    filters: { enabled: ['true', 'false'] },
  },
  templates: { model: ImportTemplate, search: ['name', 'sheetName'], filters: {} },
  imports: { model: ImportJob, search: [], filters: { status: ['preview', 'completed'] } },
  dictionaries: {
    model: DictionaryOption,
    search: ['value'],
    filters: { active: ['true', 'false'] },
  },
  'risk-addresses': {
    model: RiskAddress,
    search: ['address1', 'address2', 'city', 'state', 'postalCode', 'note'],
    filters: {},
  },
};

export function resourceConfig(resource, kind) {
  assert(Object.hasOwn(resources, resource), '列表不存在', 404);
  if (resource === 'dictionaries') assert(Object.hasOwn(dictionaryKinds, kind), '字典类型无效');
  return resources[resource];
}

function dateBoundary(value, nextDay = false) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '日期格式无效');
  const date = new Date(`${value}T00:00:00+08:00`);
  assert(
    Number.isFinite(date.getTime()) &&
      new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) === value,
    '日期无效',
  );
  return new Date(date.getTime() + (nextDay ? 86400000 : 0));
}

export async function listManagement(resource, query = {}) {
  const config = resourceConfig(resource, query.kind);
  const page = Number(query.page ?? 1),
    pageSize = Number(query.pageSize ?? 20);
  assert(Number.isSafeInteger(page) && page > 0 && page <= 1000000, '页码无效');
  assert([20, 50, 100].includes(pageSize), '每页条数无效');
  const where = resource === 'dictionaries' ? { kind: query.kind } : {};
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  assert(q.length <= 255, '关键词最多 255 字');
  // 转义 LIKE 通配符，关键词中的 % 和 _ 按原文搜索。
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  if (q && config.search.length)
    where[Op.or] = config.search.map((key) => ({ [key]: { [Op.like]: like } }));
  if (q && resource === 'imports') {
    const uploads = await Upload.findAll({
      where: { originalName: { [Op.like]: like } },
      attributes: ['id'],
    });
    where.uploadId = { [Op.in]: uploads.map((row) => row.id) };
  }
  for (const [key, values] of Object.entries(config.filters)) {
    if (query[key] == null || query[key] === '') continue;
    assert(values.includes(query[key]), '筛选值无效');
    if (key === 'enabled') {
      const states = await WalmartSync.findAll({
        where: { enabled: true },
        attributes: ['storeId'],
      });
      where.id = { [query[key] === 'true' ? Op.in : Op.notIn]: states.map((row) => row.storeId) };
    } else where[key] = key === 'active' ? query[key] === 'true' : query[key];
  }
  if (query.startDate || query.endDate) {
    const start = query.startDate ? dateBoundary(query.startDate) : null;
    const end = query.endDate ? dateBoundary(query.endDate, true) : null;
    assert(!start || !end || start < end, '开始日期不能晚于结束日期');
    where.createdAt = { ...(start ? { [Op.gte]: start } : {}), ...(end ? { [Op.lt]: end } : {}) };
  }
  const attributes =
    resource === 'users'
      ? ['id', 'username', 'displayName', 'role', 'active', 'createdAt', 'updatedAt']
      : resource === 'imports'
        ? [
            'id',
            'uploadId',
            'status',
            'added',
            'updated',
            'createdBy',
            'createdAt',
            'updatedAt',
            'committedAt',
          ]
        : undefined;
  // 保持原维护页排序习惯，补充主键排序以稳定分页边界。
  const order = {
    users: [['id', 'ASC']],
    stores: [
      ['systemStoreName', 'ASC'],
      ['id', 'ASC'],
    ],
    templates: [
      ['updatedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    imports: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    dictionaries: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
    'risk-addresses': [['id', 'DESC']],
  }[resource];
  const result = await config.model.findAndCountAll({
    where,
    attributes,
    order,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  let rows = result.rows.map((row) =>
    resource === 'users' ? { ...publicUser(row), updatedAt: row.updatedAt } : row.toJSON(),
  );
  if (resource === 'imports') {
    const uploads = await Upload.findAll({
      where: { id: rows.map((row) => row.uploadId) },
      attributes: ['id', 'originalName'],
    });
    const names = new Map(uploads.map((row) => [row.id, row.originalName]));
    rows = rows.map((row) => ({ ...row, filename: names.get(row.uploadId) || '原文件不可用' }));
  }
  if (resource === 'stores') {
    const states = await WalmartSync.findAll({
      where: { storeId: rows.map((row) => row.id) },
      attributes: ['storeId', 'enabled', 'status'],
    });
    const byId = new Map(states.map((row) => [row.storeId, row]));
    rows = rows.map((row) => ({
      ...row,
      syncEnabled: Boolean(byId.get(row.id)?.enabled),
      syncStatus: byId.get(row.id)?.status || 'idle',
    }));
  }
  return { rows, total: result.count, page, pageSize };
}
