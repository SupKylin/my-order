import { api } from './http';
import { ElMessage } from 'element-plus';

function upload(path, file, options) {
  const body = new FormData();
  body.append('file', file);
  return api.post(path, body, options);
}

export const uploadApi = {
  excel: (file) => {
    if (file.size > 2 * 1024 * 1024 * 1024) {
      const message = 'Excel 文件不能超过 2 GB';
      ElMessage.error(message);
      return Promise.reject(new Error(message));
    }
    return upload('/uploads/excel', file, { timeout: 2 * 60 * 60 * 1000 });
  },
  image: (file) => upload('/uploads/image', file),
  inspect: (id, sheetName, headerRow) =>
    api.get(`/uploads/excel/${id}/inspect`, { params: { sheetName, headerRow } }),
};
