/** 集中将数据库、上传和业务异常转换为稳定的 HTTP 错误响应。 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ message: '账号、模板名或店铺名＋订单号＋WalmartSku 已存在' });
  }
  if (error.name === 'MulterError') {
    return res.status(400).json({
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? '文件过大：Excel 上限 2 GB，图片上限 15 MB'
          : '上传格式错误',
    });
  }
  if (error.name === 'SequelizeValidationError') {
    return res.status(400).json({ message: '数据校验失败，请检查必填项和格式' });
  }
  const status = error.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, error.name, error.message);
  // 原始数据库错误仅记录在服务端，避免把连接信息或 SQL 暴露给客户端。
  res.status(status).json({
    message: status >= 500 ? '服务器处理失败，请查看后端日志' : error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}
