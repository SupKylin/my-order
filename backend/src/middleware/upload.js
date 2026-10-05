import multer from 'multer';

const MEGABYTE = 1024 * 1024;

/** 文件只暂存在内存，格式验证成功后由 storage 服务写入正式目录。 */
function createSingleFileUpload(maxBytes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5 },
  }).single('file');
}

export const imageUpload = createSingleFileUpload(15 * MEGABYTE);
export const excelUpload = createSingleFileUpload(50 * MEGABYTE);
