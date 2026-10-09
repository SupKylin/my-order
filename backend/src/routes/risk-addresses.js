import { Router } from 'express';
import {
  listRiskAddresses,
  saveRiskAddress,
  deleteRiskAddress,
} from '../services/risk-addresses.js';

export function createRiskAddressesRouter() {
  const router = Router();
  router.get('/', async (req, res) => res.json(await listRiskAddresses()));
  router.post('/', async (req, res) =>
    res.status(201).json(await saveRiskAddress(null, req.body, req.user)),
  );
  router.put('/:id', async (req, res) =>
    res.json(await saveRiskAddress(req.params.id, req.body, req.user)),
  );
  router.delete('/:id', async (req, res) =>
    res.json(await deleteRiskAddress(req.params.id, req.body.version, req.user)),
  );
  return router;
}
