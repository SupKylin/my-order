import { Router } from 'express';
import { getTrack123Endpoint, listTrack123Endpoints } from '../services/track123-mcp.js';

export function createTrack123DocsRouter() {
  const router = Router();
  router.get('/endpoints', async (req, res) =>
    res.json(await listTrack123Endpoints(req.query.q || '')),
  );
  router.get('/endpoint', async (req, res) =>
    res.json(await getTrack123Endpoint(req.query.path, req.query.method)),
  );
  return router;
}
