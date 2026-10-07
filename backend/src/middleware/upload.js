import multer from 'multer';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

const MEGABYTE = 1024 * 1024;

/** 文件只暂存在内存，格式验证成功后由 storage 服务写入正式目录。 */
function createSingleFileUpload(maxBytes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5 },
  }).single('file');
}

export const imageUpload = createSingleFileUpload(15 * MEGABYTE);
export const EXCEL_MAX_BYTES = 2 * 1024 * MEGABYTE;

/** Excel 流直接落盘；中断和写入失败时关闭流并删除不完整文件。 */
export function createExcelUpload({
  maxBytes = EXCEL_MAX_BYTES,
  directory = path.join(config.storage, '.tmp-uploads'),
} = {}) {
  const storage = {
    _handleFile(req, file, callback) {
      const target = path.join(directory, randomUUID());
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      if (req.aborted) abort();
      (async () => {
        try {
          await fs.mkdir(directory, { recursive: true });
          const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
          await pipeline(file.stream, output, { signal: controller.signal });
          if (output.bytesWritten > maxBytes) throw new multer.MulterError('LIMIT_FILE_SIZE');
          return { path: target, size: output.bytesWritten };
        } catch (error) {
          await fs.rm(target, { force: true });
          throw error;
        } finally {
          req.removeListener('aborted', abort);
        }
      })().then((result) => callback(null, result), callback);
    },
    _removeFile(req, file, callback) {
      fs.rm(file.path, { force: true }).then(() => callback(null), callback);
    },
  };
  return multer({
    storage,
    // 留一字节兼容 Multer 的边界判断，并在落盘结束时严格检查实际大小。
    limits: { fileSize: maxBytes + 1, files: 1, fields: 5 },
  }).single('file');
}

export const excelUpload = createExcelUpload();
