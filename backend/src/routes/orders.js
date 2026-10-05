import { Router } from 'express';
import { getItem, createItem, listOrders, editItem, assignItems } from '../services/orders.js';
import { deleteItems } from '../services/order-deletion.js';

export function createOrdersRouter() {
  const router = Router();
  router.get('/orders', async (req, res) => res.json(await listOrders(req.query)));
  router.get('/orders/:id', async (req, res) => res.json(await getItem(req.params.id)));
  router.post('/orders', async (req, res) =>
    res.status(201).json(await createItem(req.body, req.user)),
  );
  router.put('/orders/:id', async (req, res) =>
    res.json(await editItem(req.params.id, req.body, req.user)),
  );
  router.post('/assignments', async (req, res) => {
    await assignItems(req.body, req.user);
    res.json({ ok: true });
  });
  router.delete('/orders/:id', async (req, res) =>
    res.json(
      await deleteItems(
        { items: [{ id: Number(req.params.id), version: req.body?.version }] },
        req.user,
      ),
    ),
  );
  router.post('/orders/batch-delete', async (req, res) =>
    res.json(await deleteItems(req.body, req.user)),
  );
  return router;
}
