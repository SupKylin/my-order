import helmet from 'helmet';
import { config } from '../config.js';
import { AppError } from '../errors.js';

/** 开发和生产共用安全头；仅在 HTTPS 环境启用强制 HTTPS。 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', config.publicBase],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: config.secure ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: config.secure ? undefined : false,
  });
}

/** 校验写请求来源，同时禁止浏览器缓存带用户数据的 API 响应。 */
export function validateRequestOrigin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.get('origin') && !config.origins.includes(req.get('origin'))) {
      throw new AppError(403, '请求来源不被允许');
    }
    if (req.get('x-requested-with') !== 'XMLHttpRequest') {
      throw new AppError(403, '缺少请求校验头');
    }
  }
  next();
}

/** 登录成功后的写请求必须绑定到当前服务端会话，不能只依赖 Cookie。 */
export function requireCsrf(req, res, next) {
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== req.session.csrfToken) {
    throw new AppError(403, '请求校验已过期，请刷新页面');
  }
  next();
}
