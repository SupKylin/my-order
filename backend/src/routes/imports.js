import { Router } from 'express';
import { prepareImport, commitImport, listImports, getImportPreview } from '../services/imports.js';
import { createExclusiveTask } from '../utils/exclusive-task.js';

export function createImportsRouter() {
  const router = Router();
  const runImport = createExclusiveTask();
  router.post('/preview', async (req, res) =>
    res.json(await runImport(() => prepareImport(req.body, req.user))),
  );
  router.post('/:id/commit', async (req, res) =>
    res.json(await runImport(() => commitImport(req.params.id, req.user))),
  );
  router.get('/', async (req, res) => res.json(await listImports()));
  router.get('/:id', async (req, res) => res.json(await getImportPreview(req.params.id)));
  return router;
}
