import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canVisit,
  canManageProcurement,
  canViewAllActivity,
} from '../../frontend/src/utils/permissions.js';
import { rolePermissions, requirePermission } from '../src/permissions.js';
import { ROLES } from '../src/fields.js';

test('四角色菜单及业务权限矩阵，未知角色关闭', () => {
  for (const role of Object.keys(ROLES)) {
    assert.ok(rolePermissions[role]);
    for (const path of [
      '/home',
      '/store-summary',
      '/orders',
      '/purchase-after-sales',
      '/imports/purchases/new',
      '/templates',
      '/imports',
    ])
      assert.equal(canVisit(role, path), true);
    assert.equal(canVisit(role, '/users'), role === 'admin');
    assert.equal(canVisit(role, '/stores'), ['admin', 'supervisor'].includes(role));
    for (const path of ['/settings/channels', '/settings/purchase-statuses'])
      assert.equal(canVisit(role, path), ['admin', 'purchasing'].includes(role));
    assert.equal(canVisit(role, '/settings/purchase-platforms'), role !== 'operations');
    for (const path of ['/settings/order-statuses', '/settings/risk-addresses'])
      assert.equal(canVisit(role, path), role !== 'purchasing');
    assert.equal(canManageProcurement(role), role !== 'operations');
    assert.equal(canViewAllActivity(role), ['admin', 'supervisor'].includes(role));
    if (canManageProcurement(role))
      assert.doesNotThrow(() => requirePermission({ role }, 'procurement'));
    else
      assert.throws(
        () => requirePermission({ role }, 'procurement'),
        (error) => error.status === 403,
      );
  }
  for (const role of [undefined, 'unknown']) {
    assert.equal(canVisit(role, '/orders'), false);
    assert.equal(canManageProcurement(role), false);
    assert.equal(canViewAllActivity(role), false);
    assert.throws(
      () => requirePermission({ role }, 'orders'),
      (error) => error.status === 403,
    );
  }
});
