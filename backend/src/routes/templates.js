import { Router } from 'express';
import { ImportTemplate } from '../models.js';
import { templatePayload } from '../services/templates.js';
import { assert } from '../errors.js';

export function createTemplatesRouter() {
  const router = Router();
  router.get('/', async (req, res) =>
    res.json(await ImportTemplate.findAll({ order: [['updatedAt', 'DESC']] })),
  );
  router.post('/', async (req, res) =>
    res.status(201).json(await ImportTemplate.create(await templatePayload(req.body))),
  );
  router.put('/:id', async (req, res) => {
    const template = await ImportTemplate.findByPk(req.params.id);
    assert(template, '模板不存在', 404);
    res.json(await template.update(await templatePayload(req.body)));
  });
  router.delete('/:id', async (req, res) => {
    await ImportTemplate.destroy({ where: { id: req.params.id } });
    res.json({ ok: true });
  });
  return router;
}
