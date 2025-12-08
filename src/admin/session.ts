import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import config from '../config/config.js';

// 时间无关的字符串比较，防止时序攻击
function timingSafeEqual(a: string, b: string): boolean {
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

// 存储有效的会话 token，增加安全信息
interface SessionInfo {
  created: number;
  lastAccess: number;
  ip?: string;
  userAgent?: string;
  regenerationCount: number;  // 会话重生成总次数（保留用于统计）
  regenerationHistory: number[];  // 最近重生成的时间戳列表，用于时间窗口检测
}

const sessions = new Map<string, SessionInfo>();

// 会话过期时间（24小时）
const SESSION_EXPIRY = 24 * 60 * 60 * 1000;

// 登录尝试限制存储 { ip -> { count, firstAttempt } }
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const LOGIN_LIMIT = 10; // 每 IP 每小时最多尝试次数
const LOGIN_WINDOW = 60 * 60 * 1000; // 1小时
const MAX_TRACKED_IPS = 10000; // 最多跟踪 IP 数，防止内存耗尽

// 生成会话 token，支持安全信息记录
export function createSession(ip?: string, userAgent?: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    created: Date.now(),
    lastAccess: Date.now(),
    ip,
    userAgent,
    regenerationCount: 0,
    regenerationHistory: []
  });
  return token;
}

// 验证会话，增加安全检查
export function validateSession(token: string | undefined, ip?: string, userAgent?: string): boolean {
  if (!token) return false;

  const session = sessions.get(token);
  if (!session) return false;

  // 检查是否过期
  if (Date.now() - session.created > SESSION_EXPIRY) {
    sessions.delete(token);
    return false;
  }

  // 会话劫持检测：检查IP地址变化（可选，根据部署环境决定）
  if (session.ip && ip && session.ip !== ip) {
    // IP地址发生变化，可能存在会话劫持风险
    // 在生产环境中可能需要更复杂的逻辑来处理合法的IP变化
    console.warn(`会话安全警告: IP地址变化 ${session.ip} -> ${ip}`);
  }

  // User-Agent变化检测
  if (session.userAgent && userAgent && session.userAgent !== userAgent) {
    console.warn(`会话安全警告: User-Agent变化`);
  }

  // 更新最后访问时间
  session.lastAccess = Date.now();
  return true;
}

// 删除会话
export function destroySession(token: string): void {
  sessions.delete(token);
}

// 会话重生成（防止会话固定攻击）
export function regenerateSession(oldToken: string, ip?: string, userAgent?: string): string | null {
  const session = sessions.get(oldToken);
  if (!session) return null;

  const now = Date.now();
  const DETECTION_WINDOW_MS = 5 * 60 * 1000; // 5分钟检测窗口
  const MAX_REGENERATIONS_IN_WINDOW = 10;  // 5分钟内最多允许10次重生成

  // 清理5分钟之前的历史记录
  const recentHistory = (session.regenerationHistory || []).filter(
    timestamp => now - timestamp < DETECTION_WINDOW_MS
  );

  // 添加当前重生成时间戳
  recentHistory.push(now);

  // 检测异常重生成行为：短时间内频繁刷新
  if (recentHistory.length > MAX_REGENERATIONS_IN_WINDOW) {
    console.warn(
      `会话安全警告: 异常的会话重生成次数 ${recentHistory.length} 次（5分钟内），总计 ${session.regenerationCount + 1} 次`
    );
  }

  // 删除旧会话
  sessions.delete(oldToken);
  
  // 创建新会话，保留部分信息
  const newToken = crypto.randomBytes(32).toString('hex');
  sessions.set(newToken, {
    created: session.created,  // 保持原始创建时间
    lastAccess: now,
    ip: ip || session.ip,
    userAgent: userAgent || session.userAgent,
    regenerationCount: session.regenerationCount + 1,
    regenerationHistory: recentHistory
  });

  return newToken;
}

// 验证密码
export function verifyPassword(password: string): boolean {
  const adminPassword = config.security?.adminPassword;
  if (!adminPassword) {
    // 未设置管理员密码时，拒绝所有登录尝试
    return false;
  }
  // 使用时间无关比较防止时序攻击
  return timingSafeEqual(password, adminPassword);
}

// 获取管理密码
export function getAdminPassword(): string | null {
  return config.security?.adminPassword || null;
}

// 清理过期会话和登录尝试记录
function cleanupSessions(): void {
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
export function checkLoginLimit(ip: string): { allowed: boolean; waitSeconds?: number } {
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
export function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const data = loginAttempts.get(ip);
  
  if (!data || now - data.firstAttempt > LOGIN_WINDOW) {
    // 新窗口或时间窗口已过
    // 防止内存耗尽：使用更高效的清理策略
    if (loginAttempts.size >= MAX_TRACKED_IPS) {
      // 批量清理过期记录，避免逐一查找
      const cutoffTime = now - LOGIN_WINDOW;
      const toDelete: string[] = [];
      
      for (const [existingIp, existingData] of loginAttempts.entries()) {
        if (existingData.firstAttempt < cutoffTime) {
          toDelete.push(existingIp);
        }
      }
      
      // 如果过期记录不够清理，删除一些较早的记录
      if (toDelete.length === 0) {
        const entries = Array.from(loginAttempts.entries());
        entries.sort((a, b) => a[1].firstAttempt - b[1].firstAttempt);
        // 删除最早的25%记录
        const deleteCount = Math.max(1, Math.floor(entries.length * 0.25));
        for (let i = 0; i < deleteCount; i++) {
          toDelete.push(entries[i][0]);
        }
      }
      
      // 批量删除
      toDelete.forEach(ipToDelete => loginAttempts.delete(ipToDelete));
    }
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    data.count++;
  }
}

// 管理员认证中间件
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // 仅从 Header 读取 Token，避免 URL 参数被记录到日志
  const token = req.headers['x-admin-token'] as string | undefined;

  // 获取客户端 IP
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = req.ip || (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : '') || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'];

  if (validateSession(token, ip, userAgent)) {
    next();
  } else {
    res.status(401).json({ error: '未授权，请先登录' });
  }
}
