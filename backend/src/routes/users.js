import { Router } from 'express';
import { listUsers, createUser, updateUser } from '../services/users.js';

export function createUsersRouter() {
  const router = Router();
  router.get('/', async (req, res) => res.json(await listUsers()));
  router.post('/', async (req, res) => res.status(201).json(await createUser(req.body, req.user)));
  router.put('/:id', async (req, res) =>
    res.json(await updateUser(req.params.id, req.body, req.user)),
  );
  return router;
}
