import { Router } from 'express';
import { listManagement } from '../services/management-list.js';
import { deleteManagement } from '../services/management-delete.js';

export function createManagementRouter() {
  const router = Router();
  router.get('/:resource', async (req, res) =>
    res.json(await listManagement(req.params.resource, req.query)),
  );
  router.post('/:resource/batch-delete', async (req, res) =>
    res.json(await deleteManagement(req.params.resource, req.body, req.user)),
  );
  return router;
}
