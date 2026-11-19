import { Router } from 'express';
import { readPurchaseStatistics } from '../services/purchase-statistics/index.js';

export function createPurchaseStatisticsRouter() {
  const router = Router();
  router.get('/', async (req, res) => res.json(await readPurchaseStatistics(req.query, req.user)));
  return router;
}
