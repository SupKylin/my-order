const common = [
  '/home',
  '/store-summary',
  '/orders',
  '/imports/purchases/new',
  '/templates',
  '/imports',
];
const paths = {
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
  return role === 'admin' || role === 'purchasing';
}
