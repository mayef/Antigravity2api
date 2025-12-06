import crypto from 'crypto';
import config from '../config/config.js';

// 时间无关的字符串比较，防止时序攻击
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // 长度不同时，仍然执行比较以保持时间一致
    const bufPadded = Buffer.alloc(bufA.length);
    bufB.copy(bufPadded);
    crypto.timingSafeEqual(bufA, bufPadded);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// 存储有效的会话 token
const sessions = new Map();

// 会话过期时间（24小时）
const SESSION_EXPIRY = 24 * 60 * 60 * 1000;

// 登录尝试限制存储 { ip -> { count, firstAttempt } }
const loginAttempts = new Map();
const LOGIN_LIMIT = 10; // 每 IP 每小时最多尝试次数
const LOGIN_WINDOW = 60 * 60 * 1000; // 1小时
const MAX_TRACKED_IPS = 10000; // 最多跟踪 IP 数，防止内存耗尽

// 生成会话 token
export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    created: Date.now(),
    lastAccess: Date.now()
  });
  return token;
}

// 验证会话
export function validateSession(token) {
  if (!token) return false;

  const session = sessions.get(token);
  if (!session) return false;

  // 检查是否过期
  if (Date.now() - session.created > SESSION_EXPIRY) {
    sessions.delete(token);
    return false;
  }

  // 更新最后访问时间
  session.lastAccess = Date.now();
  return true;
}

// 删除会话
export function destroySession(token) {
  sessions.delete(token);
}

// 验证密码
export function verifyPassword(password) {
  const adminPassword = config.security?.adminPassword;
  if (!adminPassword) {
    // 未设置管理员密码时，拒绝所有登录尝试
    return false;
  }
  // 使用时间无关比较防止时序攻击
  return timingSafeEqual(password, adminPassword);
}

// 获取管理密码
export function getAdminPassword() {
  return config.security?.adminPassword || null;
}

// 清理过期会话和登录尝试记录
function cleanupSessions() {
  const now = Date.now();
  
  // 清理过期会话
  for (const [token, session] of sessions.entries()) {
    if (now - session.created > SESSION_EXPIRY) {
      sessions.delete(token);
    }
  }
  
  // 清理过期登录尝试记录
  for (const [ip, data] of loginAttempts.entries()) {
    if (now - data.firstAttempt > LOGIN_WINDOW) {
      loginAttempts.delete(ip);
    }
  }
}

// 每 10 分钟清理一次
setInterval(cleanupSessions, 10 * 60 * 1000);

// 检查登录尝试限制
export function checkLoginLimit(ip) {
  const now = Date.now();
  const data = loginAttempts.get(ip);
  
  if (!data) {
    return { allowed: true };
  }
  
  // 时间窗口已过，重置记录
  if (now - data.firstAttempt > LOGIN_WINDOW) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  
  if (data.count >= LOGIN_LIMIT) {
    const waitSeconds = Math.ceil((data.firstAttempt + LOGIN_WINDOW - now) / 1000);
    return { allowed: false, waitSeconds };
  }
  
  return { allowed: true };
}

// 记录登录尝试
export function recordLoginAttempt(ip) {
  const now = Date.now();
  const data = loginAttempts.get(ip);
  
  if (!data || now - data.firstAttempt > LOGIN_WINDOW) {
    // 新窗口或时间窗口已过
    // 防止内存耗尽：如果跟踪 IP 数超限，先清理最早的记录
    if (loginAttempts.size >= MAX_TRACKED_IPS) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [existingIp, existingData] of loginAttempts.entries()) {
        if (existingData.firstAttempt < oldestTime) {
          oldest = existingIp;
          oldestTime = existingData.firstAttempt;
        }
      }
      if (oldest) loginAttempts.delete(oldest);
    }
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    data.count++;
  }
}

// 管理员认证中间件
export function adminAuth(req, res, next) {
  // 仅从 Header 读取 Token，避免 URL 参数被记录到日志
  const token = req.headers['x-admin-token'];

  if (validateSession(token)) {
    next();
  } else {
    res.status(401).json({ error: '未授权，请先登录' });
  }
}
