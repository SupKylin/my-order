import { Router } from 'express';
import { listAudit, getAudit } from '../services/audit.js';
export function createAuditRouter() {
  const router = Router();
  router.get('/', async (req, res) => res.json(await listAudit(req.query, req.user)));
  router.get('/:id', async (req, res) => res.json(await getAudit(req.params.id, req.user)));
  return router;
}
