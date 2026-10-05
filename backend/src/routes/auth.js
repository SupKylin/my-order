import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { User } from '../models.js';
import { requireAuth, hashPassword, checkPassword, publicUser } from '../auth.js';
import { AppError, assert } from '../errors.js';
import { requireCsrf } from '../middleware/security.js';

const saveSession = (session) =>
  new Promise((resolve, reject) => session.save((error) => (error ? reject(error) : resolve())));
const regenerateSession = (req) =>
  new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve())),
  );

/** 认证路由自行划分公开登录与受保护操作，挂载顺序不可颠倒。 */
export function createAuthRouter() {
  const router = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: '登录尝试过于频繁，请稍后重试' },
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    assert(
      typeof username === 'string' && typeof password === 'string' && password.length <= 128,
      '请输入账号和密码',
    );
    const user = await User.findOne({ where: { username: username.trim() } });
    if (!user?.active || !(await checkPassword(password, user.passwordHash))) {
      throw new AppError(401, '账号或密码错误，或账号已停用');
    }

    // 更换会话 ID，防止会话固定攻击；有效期从本次登录起固定为七天。
    await regenerateSession(req);
    Object.assign(req.session, {
      userId: user.id,
      sessionVersion: user.sessionVersion,
      authExpiresAt: Date.now() + config.sessionMs,
      csrfToken: randomBytes(32).toString('hex'),
    });
    await saveSession(req.session);
    res.json({
      user: publicUser(user),
      csrfToken: req.session.csrfToken,
      expiresAt: req.session.authExpiresAt,
    });
  });

  router.use(requireAuth, requireCsrf);
  router.get('/me', (req, res) =>
    res.json({
      user: publicUser(req.user),
      csrfToken: req.session.csrfToken,
      expiresAt: req.session.authExpiresAt,
    }),
  );
  router.post('/logout', (req, res, next) =>
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('order.sid', { httpOnly: true, sameSite: 'lax', secure: config.secure });
      res.json({ ok: true });
    }),
  );
  router.put('/password', async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    assert(
      typeof oldPassword === 'string' &&
        typeof newPassword === 'string' &&
        newPassword.length >= 8 &&
        newPassword.length <= 128,
      '新密码需要 8 至 128 个字符',
    );
    assert(await checkPassword(oldPassword, req.user.passwordHash), '原密码不正确');
    await req.user.update({
      passwordHash: await hashPassword(newPassword),
      sessionVersion: req.user.sessionVersion + 1,
    });
    // 其他会话因版本变化失效，当前改密会话继续保留。
    req.session.sessionVersion = req.user.sessionVersion;
    await saveSession(req.session);
    res.json({ ok: true });
  });
  return router;
}
