import { Router } from 'express';
import { configureSync, previewOrders, startSync, syncStatus } from '../services/walmart/sync.js';
import { assert } from '../errors.js';

export function createWalmartRouter() {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    const id = Number(req.params.storeId);
    assert(Number.isSafeInteger(id) && id > 0, '店铺编号无效');
    req.walmartStoreId = id;
    next();
  });
  router.get('/', async (req, res) => res.json(await syncStatus(req.walmartStoreId)));
  router.put('/', async (req, res) => {
    await configureSync(req.walmartStoreId, req.body.enabled, req.user);
    res.json(await syncStatus(req.walmartStoreId));
  });
  router.post('/sync', async (req, res) =>
    res.status(202).json(await startSync(req.walmartStoreId)),
  );
  router.post('/preview', async (req, res) =>
    res.json(await previewOrders(req.walmartStoreId, req.body)),
  );
  return router;
}
