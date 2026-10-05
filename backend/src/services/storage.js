import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { Upload } from '../models.js';
import { AppError } from '../errors.js';
export const imageDir = path.join(config.storage, 'images');
export const excelDir = path.join(config.storage, 'excel');
export async function ensureStorage() {
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(excelDir, { recursive: true });
}
export function uploadPath(upload) {
  return path.join(upload.kind === 'excel' ? excelDir : imageDir, upload.filename);
}
export async function saveImage(buffer, userId, originalName = '嵌入图片') {
  if (buffer.length > 15 * 1024 * 1024) throw new AppError(400, '单张图片不能超过 15 MB');
  const id = randomUUID(),
    filename = `${id}.webp`;
  let full, thumb;
  try {
    // sharp 只在真正处理图片时加载，普通订单查询无需初始化原生图像库。
    const { default: sharp } = await import('sharp');
    const source = sharp(buffer, { limitInputPixels: 40000000, failOn: 'error' }).rotate();
    full = await source
      .clone()
      .resize(2200, 2200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toBuffer();
    thumb = await source
      .clone()
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new AppError(400, '图片无法解码或像素过大，请使用 PNG、JPG、GIF 或 WebP');
  }
  await fs.writeFile(path.join(imageDir, filename), full);
  await fs.writeFile(path.join(imageDir, `${id}.thumb.webp`), thumb);
  try {
    await Upload.create({
      id,
      filename,
      originalName: String(originalName).slice(0, 255),
      kind: 'image',
      size: full.length,
      mime: 'image/webp',
      uploadedBy: userId,
    });
  } catch (e) {
    await fs.rm(path.join(imageDir, filename), { force: true });
    await fs.rm(path.join(imageDir, `${id}.thumb.webp`), { force: true });
    throw e;
  }
  const relativePath = `/uploads/images/${filename}`;
  return {
    id,
    path: relativePath,
    url: config.publicBase + relativePath,
    thumbnailUrl: `${config.publicBase}/uploads/images/${id}.thumb.webp`,
  };
}
export async function saveExcel(file, userId) {
  if (!file || !/\.xlsx$/i.test(file.originalname))
    throw new AppError(400, '请上传 .xlsx 文件；旧版 .xls 请先另存为 .xlsx');
  if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b)
    throw new AppError(400, '文件不是有效的 XLSX 工作簿');
  const id = randomUUID(),
    filename = `${id}.xlsx`;
  await fs.writeFile(path.join(excelDir, filename), file.buffer);
  try {
    return await Upload.create({
      id,
      filename,
      originalName: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255),
      kind: 'excel',
      size: file.size,
      mime: file.mimetype,
      uploadedBy: userId,
    });
  } catch (e) {
    await fs.rm(path.join(excelDir, filename), { force: true });
    throw e;
  }
}
