import { Router } from 'express';
import { db, ImportTemplate } from '../models.js';
import { templatePayload } from '../services/templates.js';
import { assert } from '../errors.js';

export function createTemplatesRouter() {
  const router = Router();
  router.get('/', async (req, res) =>
    res.json(await ImportTemplate.findAll({ order: [['updatedAt', 'DESC']] })),
  );
  router.post('/', async (req, res) =>
    res
      .status(201)
      .json(
        await db.transaction(async (transaction) =>
          ImportTemplate.create(await templatePayload(req.body, transaction), { transaction }),
        ),
      ),
  );
  router.put('/:id', async (req, res) => {
    res.json(
      await db.transaction(async (transaction) => {
        const payload = await templatePayload(req.body, transaction);
        const template = await ImportTemplate.findByPk(req.params.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        assert(template, '模板不存在', 404);
        return template.update(payload, { transaction });
      }),
    );
  });
  router.delete('/:id', async (req, res) => {
    await ImportTemplate.destroy({ where: { id: req.params.id } });
    res.json({ ok: true });
  });
  return router;
}
