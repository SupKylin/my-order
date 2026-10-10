import { Router } from 'express';
import fs from 'node:fs/promises';
import { imageUpload, excelUpload } from '../middleware/upload.js';
import { saveImage, saveExcel } from '../services/storage.js';
import { inspectExcel, getExcelUpload } from '../services/imports.js';
import { assert } from '../errors.js';

export function createUploadsRouter() {
  const router = Router();
  router.post('/image', imageUpload, async (req, res) => {
    assert(req.file, '请选择图片');
    res.status(201).json(await saveImage(req.file.buffer, req.user.id, req.file.originalname));
  });
  router.post('/excel', excelUpload, async (req, res) => {
    try {
      const file = await saveExcel(req.file, req.user.id);
      res
        .status(201)
        .json({ id: file.id, name: file.originalName, ...(await inspectExcel(file.id)) });
    } finally {
      if (req.file?.path) await fs.rm(req.file.path, { force: true });
    }
  });
  router.get('/excel/:id/inspect', async (req, res) => {
    const upload = await getExcelUpload(req.params.id);
    assert(
      req.user.role === 'admin' || upload.uploadedBy === req.user.id,
      '无权查看该上传文件',
      403,
    );
    res.json(await inspectExcel(req.params.id, req.query.sheetName, req.query.headerRow));
  });
  return router;
}
