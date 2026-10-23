import { Router } from 'express';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createExcelUpload } from '../middleware/upload.js';
import { AppError } from '../errors.js';
import { RISK_ADDRESS_IMPORT_MAX_BYTES } from '../lib/risk-address-fields.js';
import { importRiskAddresses } from '../services/risk-address-import.js';
import {
  listRiskAddresses,
  saveRiskAddress,
  deleteRiskAddress,
} from '../services/risk-addresses.js';

export function createRiskAddressesRouter() {
  const router = Router();
  const upload = createExcelUpload({ maxBytes: RISK_ADDRESS_IMPORT_MAX_BYTES });
  router.get('/import-template', (req, res) =>
    res.download(
      fileURLToPath(new URL('../assets/risk-address-import.xlsx', import.meta.url)),
      '风险地址导入模板.xlsx',
    ),
  );
  router.post(
    '/import',
    (req, res, next) => {
      upload(req, res, (error) =>
        next(
          error?.code === 'LIMIT_FILE_SIZE'
            ? new AppError(400, '风险地址 Excel 文件不能超过 10 MB')
            : error,
        ),
      );
    },
    async (req, res) => {
      try {
        res.json(await importRiskAddresses(req.file, req.user));
      } finally {
        if (req.file?.path) await fs.rm(req.file.path, { force: true });
      }
    },
  );
  router.get('/', async (req, res) => res.json(await listRiskAddresses()));
  router.post('/', async (req, res) =>
    res.status(201).json(await saveRiskAddress(null, req.body, req.user)),
  );
  router.put('/:id', async (req, res) =>
    res.json(await saveRiskAddress(req.params.id, req.body, req.user)),
  );
  router.delete('/:id', async (req, res) =>
    res.json(await deleteRiskAddress(req.params.id, req.body.version, req.user)),
  );
  return router;
}
