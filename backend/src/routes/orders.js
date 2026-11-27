import { purchaseAssignmentSummary } from '../services/purchase-assignment-summary.js';
import { updateLossMark } from '../services/order-loss.js';
import { Router } from 'express';
import {
  getItem,
  createItem,
  listOrders,
  editItem,
  assignItems,
  updateOrderStatus,
  updatePurchaseStatus,
  updateFollowupNote,
} from '../services/orders.js';
import { deleteItems } from '../services/order-deletion.js';
import { exportOrders } from '../services/order-export.js';
import { beginExport, exportProgress } from '../services/export-progress.js';
import { getTracking, listTrackingItems, registerTracking } from '../services/track123.js';

export function createOrdersRouter() {
  const router = Router();
  router.get('/orders', async (req, res) => res.json(await listOrders(req.query, req.user)));
  router.get('/orders/export-progress/:id', (req, res) =>
    res.json(exportProgress(req.params.id, req.user.id)),
  );
  for (const [route, purchaseTemplate] of [
    ['/orders/export', false],
    ['/orders/export-purchases', true],
  ]) {
    router.post(route, async (req, res) => {
      const progress = beginExport(req.body?.exportId, req.user.id);
      try {
        await exportOrders(req.body || {}, res, purchaseTemplate, { progress, user: req.user });
      } catch (error) {
        progress({ stage: 'failed' });
        throw error;
      }
    });
  }
  router.post('/orders/batch-status', async (req, res) =>
    res.json(await updateOrderStatus(req.body, req.user)),
  );
  router.post('/orders/batch-loss-mark', async (req, res) =>
    res.json(await updateLossMark(req.body, req.user)),
  );
  router.post('/orders/batch-purchase-status', async (req, res) =>
    res.json(await updatePurchaseStatus(req.body, req.user)),
  );
  router.post('/orders/batch-followup-note', async (req, res) =>
    res.json(await updateFollowupNote(req.body, req.user)),
  );
  router.get('/orders/purchase-assignment-summary', async (req, res) =>
    res.json(await purchaseAssignmentSummary(req.user)),
  );
  router.get('/orders/tracking-items', async (req, res) =>
    res.json(await listTrackingItems(req.query, req.user)),
  );
  router.get('/orders/:id/tracking', async (req, res) =>
    res.json(await getTracking(req.params.id, req.user)),
  );
  router.post('/orders/:id/tracking/register', async (req, res) =>
    res.json(await registerTracking(req.params.id, req.user)),
  );
  router.get('/orders/:id', async (req, res) => res.json(await getItem(req.params.id, req.user)));
  router.post('/orders', async (req, res) =>
    res.status(201).json(await createItem(req.body, req.user)),
  );
  router.put('/orders/:id', async (req, res) =>
    res.json(await editItem(req.params.id, req.body, req.user)),
  );
  router.post('/assignments', async (req, res) => {
    await assignItems(req.body, req.user);
    res.json({ ok: true });
  });
  router.delete('/orders/:id', async (req, res) =>
    res.json(
      await deleteItems(
        { items: [{ id: Number(req.params.id), version: req.body?.version }] },
        req.user,
      ),
    ),
  );
  router.post('/orders/batch-delete', async (req, res) =>
    res.json(await deleteItems(req.body, req.user)),
  );
  return router;
}
