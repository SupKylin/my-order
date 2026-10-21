import { Store } from './models.js';
import { assert } from './errors.js';

const common = ['home', 'orders', 'imports', 'templates', 'audit-logs'];
export const rolePermissions = {
  admin: ['*'],
  purchasing: [...common, 'purchaseChannel', 'purchasePlatform', 'purchaseStatus'],
  operations: [...common, 'risk-addresses', 'orderStatus'],
};
export function requirePermission(user, permission) {
  assert(
    user &&
      (rolePermissions[user.role]?.includes('*') ||
        rolePermissions[user.role]?.includes(permission)),
    '当前账号没有此功能权限',
    403,
  );
}
export function managementPermission(resource, kind) {
  return resource === 'dictionaries' ? kind : resource;
}

/** 数据权限作为额外 AND 条件，绝不允许客户端筛选覆盖它。 */
export function orderScope(user) {
  return user?.role === 'operations' ? { '$store.ownerId$': user.id } : {};
}
export async function allowedStoreNames(user, transaction) {
  if (user?.role !== 'operations') return null;
  const stores = await Store.findAll({
    where: { ownerId: user.id },
    attributes: ['systemStoreName'],
    order: [['id', 'ASC']],
    transaction,
    ...(transaction ? { lock: transaction.LOCK.SHARE } : {}),
  });
  return new Set(stores.map((store) => store.systemStoreName));
}
export const NO_STORE_PERMISSION = '无该店铺订单权限，已跳过';
export async function assertItemAccess(item, user, transaction) {
  if (user?.role !== 'operations') return;
  const store = await Store.findOne({
    where: { systemStoreName: item.shopName, ownerId: user.id },
    attributes: ['id'],
    transaction,
    ...(transaction ? { lock: transaction.LOCK.SHARE } : {}),
  });
  assert(store, '无权操作该店铺订单', 403);
}

/** 白名单覆盖旧接口及通用维护接口；下拉数据另走不包含账号/店铺密钥的只读接口。 */
export function authorizeApi(req, res, next) {
  const path = req.path;
  if (['/meta', '/dashboard', '/order-owners'].includes(path) && req.method === 'GET')
    return next();
  let permission;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'management') {
    // 与实际处理函数读取同一参数源，防止 query.kind 掩盖写请求的 body.kind。
    permission = managementPermission(
      parts[1],
      req.method === 'GET' ? req.query.kind : req.body?.kind,
    );
    if (['imports', 'audit-logs'].includes(parts[1]))
      assert(req.method === 'GET', '操作日志和导入记录仅允许查看', 403);
  } else if (parts[0] === 'dictionaries') permission = parts[1];
  else if (['orders', 'assignments'].includes(parts[0])) permission = 'orders';
  else if (parts[0] === 'uploads') permission = 'imports';
  else permission = parts[0];
  if (permission === 'audit-logs') assert(req.method === 'GET', '操作日志仅允许查看', 403);
  requirePermission(req.user, permission);
  next();
}
