import { api } from './http';
import { ElMessage } from 'element-plus';

function upload(path, file) {
  const body = new FormData();
  body.append('file', file);
  return api.post(path, body);
}

export const uploadApi = {
  excel: (file) => {
    if (file.size > 50 * 1024 * 1024) {
      const message = 'Excel 文件不能超过 50 MB';
      ElMessage.error(message);
      return Promise.reject(new Error(message));
    }
    return upload('/uploads/excel', file);
  },
  image: (file) => upload('/uploads/image', file),
  inspect: (id, sheetName, headerRow) =>
    api.get(`/uploads/excel/${id}/inspect`, { params: { sheetName, headerRow } }),
};
