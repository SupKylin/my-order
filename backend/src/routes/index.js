import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { requireCsrf } from '../middleware/security.js';
import { createAuthRouter } from './auth.js';
import { createOrdersRouter } from './orders.js';
import { createUsersRouter } from './users.js';
import { createTemplatesRouter } from './templates.js';
import { createUploadsRouter } from './uploads.js';
import { createImportsRouter } from './imports.js';
import { createDashboardRouter } from './dashboard.js';
import { createDictionariesRouter } from './dictionaries.js';
import { createStoresRouter } from './stores.js';
import { createWalmartRouter } from './walmart.js';
import { createRiskAddressesRouter } from './risk-addresses.js';
import { createManagementRouter } from './management.js';
import { authorizeApi } from '../permissions.js';
import { auditRequests, installAuditHooks } from '../services/audit.js';
import { createAuditRouter } from './audit.js';

/** 统一注册 API 边界；业务路由默认受登录和 CSRF 保护。 */
export function createApiRouter() {
  installAuditHooks();
  const router = Router();
  router.use('/auth', createAuthRouter());
  router.use(requireAuth, requireCsrf);
  router.use(auditRequests, authorizeApi);
  router.use('/audit-logs', createAuditRouter());
  router.use('/management', createManagementRouter());
  router.use(createDashboardRouter());
  router.use(createOrdersRouter());
  router.use('/users', createUsersRouter());
  router.use('/templates', createTemplatesRouter());
  router.use('/uploads', createUploadsRouter());
  router.use('/imports', createImportsRouter());
  router.use('/dictionaries', createDictionariesRouter());
  router.use('/stores', createStoresRouter());
  router.use('/risk-addresses', createRiskAddressesRouter());
  router.use('/stores/:storeId/walmart', createWalmartRouter());
  return router;
}
