import { exportOrders } from '../services/order-export.js';
import { beginExport } from '../services/export-progress.js';
import { Router } from 'express';
import {
  listChannelChanges,
  channelChangeOptions,
  channelChangeExportItems,
  createChannelChange,
  getChannelChange,
  replyChannelChange,
  changeChannelTicketStatus,
  applyChannelChange,
  batchApplyChannelChanges,
} from '../services/channel-change-tickets.js';

export function createChannelChangesRouter() {
  const router = Router();
  router.get('/', async (req, res) => res.json(await listChannelChanges(req.query, req.user)));
  router.post('/', async (req, res) =>
    res.status(201).json(await createChannelChange(req.body, req.user)),
  );
  router.post('/export', async (req, res) => {
    const progress = beginExport(req.body?.exportId, req.user.id);
    try {
      const itemIds = await channelChangeExportItems(req.body?.filters || {}, req.user);
      await exportOrders({}, res, false, { user: req.user, progress, itemIds });
    } catch (error) {
      progress({ stage: 'failed' });
      throw error;
    }
  });
  router.post('/batch-apply', async (req, res) =>
    res.json(await batchApplyChannelChanges(req.body, req.user)),
  );
  router.get('/options', async (req, res) => res.json(await channelChangeOptions(req.user)));
  router.get('/:id', async (req, res) =>
    res.json(await getChannelChange(req.params.id, req.query, req.user)),
  );
  router.post('/:id/records', async (req, res) =>
    res.status(201).json(await replyChannelChange(req.params.id, req.body, req.user)),
  );
  router.post('/:id/status', async (req, res) =>
    res.json(await changeChannelTicketStatus(req.params.id, req.body, req.user)),
  );
  router.post('/:id/apply', async (req, res) =>
    res.json(await applyChannelChange(req.params.id, req.body, req.user)),
  );
  return router;
}
