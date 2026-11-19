const common = [
  '/home',
  '/store-summary',
  '/purchase-statistics',
  '/orders',
  '/purchase-after-sales',
  '/imports/purchases/new',
  '/templates',
  '/imports',
];
const paths = {
  supervisor: [
    ...common,
    '/stores',
    '/settings/purchase-platforms',
    '/settings/risk-addresses',
    '/settings/order-statuses',
  ],
  operations: [...common, '/settings/risk-addresses', '/settings/order-statuses'],
  purchasing: [
    ...common,
    '/settings/channels',
    '/settings/purchase-platforms',
    '/settings/purchase-statuses',
  ],
};
export function canVisit(role, path) {
  return role === 'admin' || Boolean(paths[role]?.includes(path));
}
export function canManageProcurement(role) {
  return ['admin', 'supervisor', 'purchasing'].includes(role);
}
export function canViewAllActivity(role) {
  return ['admin', 'supervisor'].includes(role);
}
