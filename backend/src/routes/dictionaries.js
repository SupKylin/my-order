import { Router } from 'express';
import { listDictionary, saveDictionaryOption } from '../services/dictionaries.js';

export function createDictionariesRouter() {
  const router = Router();
  router.get('/:kind', async (req, res) => res.json(await listDictionary(req.params.kind)));
  router.post('/:kind', async (req, res) =>
    res.status(201).json(await saveDictionaryOption(req.params.kind, null, req.body)),
  );
  router.put('/:kind/:id', async (req, res) =>
    res.json(await saveDictionaryOption(req.params.kind, req.params.id, req.body)),
  );
  return router;
}
