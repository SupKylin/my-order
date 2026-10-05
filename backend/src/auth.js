import session from 'express-session';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Session, User } from './models.js';
import { config } from './config.js';
import { AppError } from './errors.js';
const scrypt = promisify(scryptCb);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function checkPassword(password, hash) {
  const [salt, key] = hash.split(':');
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return expected.length === derived.length && timingSafeEqual(derived, expected);
}
export class MysqlSessionStore extends session.Store {
  get(sid, callback) {
    Session.findByPk(sid)
      .then((row) =>
        callback(null, row && new Date(row.expiresAt) > new Date() ? JSON.parse(row.data) : null),
      )
      .catch(callback);
  }
  set(sid, data, callback) {
    Session.upsert({
      sid,
      data: JSON.stringify(data),
      expiresAt: new Date(data.authExpiresAt || data.cookie.expires),
    })
      .then(() => callback?.())
      .catch((e) => callback?.(e));
  }
  destroy(sid, callback) {
    Session.destroy({ where: { sid } })
      .then(() => callback?.())
      .catch((e) => callback?.(e));
  }
  touch(sid, data, callback) {
    this.set(sid, data, callback);
  }
}
export const sessionMiddleware = () =>
  session({
    name: 'order.sid',
    secret: config.secret,
    store: new MysqlSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: { maxAge: config.sessionMs, httpOnly: true, sameSite: 'lax', secure: config.secure },
  });
export const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  role: u.role,
  active: u.active,
  createdAt: u.createdAt,
});
export async function requireAuth(req, res, next) {
  if (!req.session?.userId || req.session.authExpiresAt <= Date.now())
    throw new AppError(401, '请先登录');
  const user = await User.findByPk(req.session.userId);
  if (!user?.active || user.sessionVersion !== req.session.sessionVersion) {
    req.session.destroy(() => {});
    throw new AppError(401, '登录已失效，请重新登录');
  }
  req.user = user;
  next();
}
