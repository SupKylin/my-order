import { Router } from 'express';
import { listStores, saveStore } from '../services/stores.js';

export function createStoresRouter() {
  const router = Router();
  router.get('/', async (req, res) => res.json(await listStores()));
  router.post('/', async (req, res) =>
    res.status(201).json(await saveStore(null, req.body, req.user)),
  );
  router.put('/:id', async (req, res) =>
    res.json(await saveStore(req.params.id, req.body, req.user)),
  );
  return router;
}
