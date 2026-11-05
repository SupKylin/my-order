import { Router } from 'express';
import {
  purchaseAfterSaleOptions,
  listPurchaseAfterSales,
  createPurchaseAfterSale,
  getPurchaseAfterSale,
  replyPurchaseAfterSale,
  changePurchaseAfterSaleStatus,
  markSupplierFeedback,
} from '../services/purchase-after-sales.js';

export function createPurchaseAfterSalesRouter() {
  const router = Router();
  router.get('/options', async (req, res) => res.json(await purchaseAfterSaleOptions(req.user)));
  router.get('/', async (req, res) => res.json(await listPurchaseAfterSales(req.query, req.user)));
  router.post('/', async (req, res) =>
    res.status(201).json(await createPurchaseAfterSale(req.body, req.user)),
  );
  router.get('/:id', async (req, res) =>
    res.json(await getPurchaseAfterSale(req.params.id, req.query, req.user)),
  );
  router.post('/:id/records', async (req, res) =>
    res.status(201).json(await replyPurchaseAfterSale(req.params.id, req.body, req.user)),
  );
  router.post('/:id/status', async (req, res) =>
    res.json(await changePurchaseAfterSaleStatus(req.params.id, req.body, req.user)),
  );
  router.post('/:id/supplier-feedback', async (req, res) =>
    res.json(await markSupplierFeedback(req.params.id, req.user)),
  );
  return router;
}
