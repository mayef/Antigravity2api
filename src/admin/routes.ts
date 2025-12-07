import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { createKey, loadKeys, deleteKey, updateKeyRateLimit, getKeyStats } from './key-manager.js';
import { getRecentLogs, clearLogs, addLog } from './log-manager.js';
import { getSystemStatus, getTodayRequestCount } from './monitor.js';
import { loadAccounts, deleteAccount, toggleAccount, triggerLogin, getAccountStats, addTokenFromCallback, getAccountName, importTokens } from './token-admin.js';
import { createSession, validateSession, destroySession, verifyPassword, adminAuth, checkLoginLimit, recordLoginAttempt, regenerateSession } from './session.js';
import { loadSettings, saveSettings } from './settings-manager.js';
import tokenManager from '../auth/token-manager.js';
import { checkString, checkNumberRange, checkArray } from '../utils/validators.js';

// 配置文件上传（限制文件大小和类型）
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 最大 10MB
    files: 1 // 单次只允许上传一个文件
  },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    // 只允许 ZIP 文件
    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传 ZIP 文件'));
    }
  }
});

const router: express.Router = express.Router();

// 登录接口（不需要认证）
router.post('/login', async (req: Request, res: Response) => {
  try {
    // 获取客户端 IP
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = req.ip || (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : '') || req.socket.remoteAddress || 'unknown';
    
    // 检查登录尝试限制
    const limitCheck = checkLoginLimit(ip);
    if (!limitCheck.allowed) {
      await addLog('warn', `登录尝试过多: ${ip}`);
      return res.status(429).json({
        error: `登录尝试次数过多，请 ${Math.ceil((limitCheck.waitSeconds ?? 60) / 60)} 分钟后重试`
      });
    }
    
    const { password } = req.body;
    const err = checkString({ name: '密码', value: password, min: 8, max: 128 });
    if (err) return res.status(400).json({ error: err });

    // 记录登录尝试
    recordLoginAttempt(ip);

    if (verifyPassword(password)) {
      const userAgent = req.headers['user-agent'];
      const token = createSession(ip, userAgent);
      await addLog('info', '管理员登录成功');
      return res.json({ success: true, token });
    } else {
      await addLog('warn', `管理员登录失败：密码错误 (IP: ${ip})`);
      return res.status(401).json({ error: '密码错误' });
    }
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 登出接口
router.post('/logout', (req: Request, res: Response) => {
  const token = req.headers['x-admin-token'] as string | undefined;
  if (token) {
    destroySession(token);
  }
  return res.json({ success: true });
});

// 验证会话接口
router.get('/verify', (req: Request, res: Response) => {
  const token = req.headers['x-admin-token'] as string | undefined;

  // 获取客户端 IP
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = req.ip || (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : '') || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'];

  if (validateSession(token, ip, userAgent)) {
    return res.json({ valid: true });
  } else {
    return res.status(401).json({ valid: false });
  }
});

// 以下所有路由需要认证
router.use(adminAuth);

// 会话刷新接口（重新生成 token）
router.post('/session/regenerate', async (req: Request, res: Response) => {
  try {
    const token = req.headers['x-admin-token'] as string | undefined;
    
    if (!token) {
      return res.status(401).json({ error: '缺少认证 token' });
    }

    // 获取客户端 IP
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = req.ip || (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : '') || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'];

    // 重新生成会话
    const newToken = regenerateSession(token, ip, userAgent);
    
    if (newToken) {
      await addLog('info', '管理员会话已重新生成');
      return res.json({ success: true, token: newToken });
    } else {
      await addLog('warn', '会话重新生成失败：无效的会话 token');
      return res.status(401).json({ error: '无效的会话，请重新登录' });
    }
  } catch (error) {
    const err = error as Error;
    await addLog('error', `会话重新生成失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 生成新密钥
router.post('/keys/generate', async (req: Request, res: Response) => {
  try {
    const { name, rateLimit, key } = req.body;
    const errors: string[] = [];
    const nameErr = checkString({ name: '密钥名称', value: name, min: 1, max: 64, optional: true });
    if (nameErr) errors.push(nameErr);
    const keyErr = checkString({ name: '自定义密钥', value: key, min: 16, max: 160, optional: true });
    if (keyErr) errors.push(keyErr);
    if (rateLimit) {
      const maxReqErr = checkNumberRange({ name: '最大请求数', value: rateLimit.maxRequests, min: 1, max: 100000 });
      const windowErr = checkNumberRange({ name: '窗口毫秒数', value: rateLimit.windowMs, min: 1000, max: 3600 * 1000 });
      if (maxReqErr) errors.push(maxReqErr);
      if (windowErr) errors.push(windowErr);
    }
    if (errors.length) {
      return res.status(400).json({ error: errors[0] });
    }
    const newKey = await createKey(name, rateLimit, key);
    await addLog('success', `密钥已生成: ${name || '未命名'}`);
    return res.json({ success: true, key: newKey.key, name: newKey.name, rateLimit: newKey.rateLimit });
  } catch (error) {
    const err = error as Error;
    await addLog('error', `生成密钥失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 获取所有密钥
router.get('/keys', async (_req: Request, res: Response) => {
  try {
    const keys = await loadKeys();
    // 返回密钥列表（隐藏部分字符）
    const safeKeys = keys.map((k) => ({
      ...k,
      key: k.key.substring(0, 10) + '...' + k.key.substring(k.key.length - 4)
    }));
    return res.json(safeKeys); // 隐藏部分密钥字符
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 删除密钥
router.delete('/keys/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const err = checkString({ name: '密钥', value: key, min: 16, max: 160 });
    if (err) return res.status(400).json({ error: err });
    await deleteKey(key);
    await addLog('warn', `密钥已删除: ${key.substring(0, 10)}...`);
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    await addLog('error', `删除密钥失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 更新密钥频率限制
router.patch('/keys/:key/ratelimit', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { rateLimit } = req.body;
    const keyErr = checkString({ name: '密钥', value: key, min: 16, max: 160 });
    if (keyErr) return res.status(400).json({ error: keyErr });
    const maxReqErr = checkNumberRange({ name: '最大请求数', value: rateLimit?.maxRequests, min: 1, max: 100000 });
    const windowErr = checkNumberRange({ name: '窗口毫秒数', value: rateLimit?.windowMs, min: 1000, max: 3600 * 1000 });
    if (maxReqErr) return res.status(400).json({ error: maxReqErr });
    if (windowErr) return res.status(400).json({ error: windowErr });
    await updateKeyRateLimit(key, rateLimit);
    await addLog('info', `密钥频率限制已更新: ${key.substring(0, 10)}...`);
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    await addLog('error', `更新频率限制失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 获取密钥统计
router.get('/keys/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getKeyStats();
    return res.json(stats);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 获取日志
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const limitStr = req.query.limit as string;
    let limit = 100;
    if (limitStr) {
      limit = parseInt(limitStr);
      const err = checkNumberRange({ name: '日志数量', value: limit, min: 1, max: 10000 });
      if (err) return res.status(400).json({ error: err });
    }
    const logs = await getRecentLogs(limit);
    return res.json(logs);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 清空日志
router.delete('/logs', async (_req: Request, res: Response) => {
  try {
    await clearLogs();
    await addLog('info', '日志已清空');
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 获取系统状态
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = getSystemStatus();
    return res.json(status);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});
router.get('/today-requests', async (_req: Request, res: Response) => {
  try {
    const todayRequests = getTodayRequestCount();
    return res.json({ todayRequests });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 获取所有账号
router.get('/tokens', async (_req: Request, res: Response) => {
  try {
    const accounts = await loadAccounts();
    // 隐藏敏感信息，只返回必要字段
    const safeAccounts = accounts.map((acc, index: number) => ({
      index,
      access_token: acc.access_token?.substring(0, 20) + '...',
      refresh_token: acc.refresh_token ? 'exists' : 'none',
      expires_in: acc.expires_in,
      timestamp: acc.timestamp,
      enable: acc.enable !== false,
      created: new Date(acc.timestamp).toLocaleString()
    }));
    return res.json(safeAccounts);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 删除账号
router.delete('/tokens/:index', async (req: Request, res: Response) => {
  try {
    const index = parseInt(req.params.index);
    const indexErr = checkNumberRange({ name: '账号索引', value: index, min: 0, max: 100000 });
    if (indexErr) return res.status(400).json({ error: indexErr });
    await deleteAccount(index);
    await addLog('warn', `Token 账号 ${index} 已删除`);
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    await addLog('error', `删除 Token 失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 启用/禁用账号
router.patch('/tokens/:index', async (req: Request, res: Response) => {
  try {
    const index = parseInt(req.params.index);
    const indexErr = checkNumberRange({ name: '账号索引', value: index, min: 0, max: 100000 });
    if (indexErr) return res.status(400).json({ error: indexErr });
    const { enable } = req.body;
    if (typeof enable !== 'boolean') {
      return res.status(400).json({ error: 'enable 必须为布尔值' });
    }
    await toggleAccount(index, enable);
    await addLog('info', `Token 账号 ${index} 已${enable ? '启用' : '禁用'}`);
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    await addLog('error', `切换 Token 状态失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 启用/禁用账号 (POST方法支持)
router.post('/tokens/toggle', async (req: Request, res: Response) => {
  try {
    const { index, enable } = req.body;
    const indexErr = checkNumberRange({ name: '账号索引', value: index, min: 0, max: 100000 });
    if (indexErr) return res.status(400).json({ error: indexErr });
    if (typeof enable !== 'boolean') {
      return res.status(400).json({ error: 'enable 必须为布尔值' });
    }
    await toggleAccount(index, enable);
    await addLog('info', `Token 账号 ${index} 已${enable ? '启用' : '禁用'}`);
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    await addLog('error', `切换 Token 状态失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 触发登录流程
router.post('/tokens/login', async (_req: Request, res: Response) => {
  try {
    await addLog('info', '开始 Google OAuth 登录流程');
    const result = await triggerLogin();
    return res.json(result);
  } catch (error) {
    const err = error as Error;
    await addLog('error', `登录失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 获取 Token 统计
router.get('/tokens/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getAccountStats();
    return res.json(stats);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 获取 Token 使用统计（轮询信息）
router.get('/tokens/usage', async (_req: Request, res: Response) => {
  try {
    const usageStats = tokenManager.getUsageStats();
    return res.json(usageStats);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 手动添加 Token（通过回调链接）
router.post('/tokens/callback', async (req: Request, res: Response) => {
  try {
    const { callbackUrl } = req.body;
    const err = checkString({ name: '回调链接', value: callbackUrl, min: 10, max: 2048 });
    if (err) {
      return res.status(400).json({ error: err });
    }
    await addLog('info', '正在通过回调链接添加 Token...');
    const result = await addTokenFromCallback(callbackUrl);
    await addLog('success', 'Token 已通过回调链接成功添加');
    return res.json(result);
  } catch (error) {
    const err = error as Error;
    await addLog('error', `添加 Token 失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 获取账号详细信息（包括名称）
router.post('/tokens/details', async (req: Request, res: Response) => {
  try {
    const { indices } = req.body;
    const arrErr = checkArray({ name: '索引列表', value: indices, min: 1, max: 200 });
    if (arrErr) return res.status(400).json({ error: arrErr });
    const accounts = await loadAccounts();
    const details = [];

    for (const index of indices) {
      if (index >= 0 && index < accounts.length) {
        const account = accounts[index];
        const accountInfo = await getAccountName(account.access_token);
        details.push({
          index,
          email: accountInfo.email,
          name: accountInfo.name,
          access_token: account.access_token?.substring(0, 20) + '...',
          refresh_token: account.refresh_token ? '[已隐藏]' : 'none',
          expires_in: account.expires_in,
          timestamp: account.timestamp,
          enable: account.enable !== false
        });
      }
    }

    return res.json(details);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 批量导出 Token (ZIP格式)
router.post('/tokens/export', async (req: Request, res: Response) => {
  try {
    const { indices } = req.body;
    const arrErr = checkArray({ name: '导出索引列表', value: indices, min: 1, max: 500 });
    if (arrErr) return res.status(400).json({ error: arrErr });
    const accounts = await loadAccounts();
    const exportData = [];

    for (const index of indices) {
      if (index >= 0 && index < accounts.length) {
        const account = accounts[index];
        const accountInfo = await getAccountName(account.access_token);
        exportData.push({
          email: accountInfo.email,
          name: accountInfo.name,
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          expires_in: account.expires_in,
          timestamp: account.timestamp,
          created: new Date(account.timestamp).toLocaleString(),
          enable: account.enable !== false
        });
      }
    }

    await addLog('info', `批量导出了 ${exportData.length} 个 Token 账号`);

    // 创建 ZIP 文件
    const archive = archiver('zip', { zlib: { level: 9 } });
    const timestamp = new Date().toISOString().split('T')[0];

    res.attachment(`tokens_export_${timestamp}.zip`);
    res.setHeader('Content-Type', 'application/zip');

    archive.pipe(res);

    // 添加 tokens.json 文件到 ZIP
    archive.append(JSON.stringify(exportData, null, 2), { name: 'tokens.json' });

    await archive.finalize();
    return res;
  } catch (error) {
    const err = error as Error;
    await addLog('error', `批量导出失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 批量导入 Token (ZIP格式)
router.post('/tokens/import', upload.single('file'), (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (err) {
    // Multer 错误处理
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: '文件大小超过限制（最大 10MB）' });
        return;
      }
      res.status(400).json({ error: `文件上传错误: ${err.message}` });
      return;
    }
    // 自定义验证错误（fileFilter）
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
    return;
  }
  next();
}, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请上传文件' });
      return;
    }

    await addLog('info', '正在导入 Token 账号...');
    const result = await importTokens(req.file.path);
    await addLog('success', `成功导入 ${result.count} 个 Token 账号`);
    res.json(result);
  } catch (error) {
    const err = error as Error;
    await addLog('error', `导入失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 获取系统设置
router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await loadSettings();
    return res.json(settings);
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

// 保存系统设置（带输入验证）
router.post('/settings', async (req: Request, res: Response) => {
  try {
    const { server, security, defaults, systemInstruction } = req.body || {};
    const errors: string[] = [];

    // 验证服务器配置
    if (server) {
      if (server.port !== undefined) {
        const portNum = Number(server.port);
        const portErr = checkNumberRange({ name: '端口', value: portNum, min: 1, max: 65535 });
        if (portErr) errors.push(portErr);
      }
      if (server.host !== undefined) {
        const hostErr = checkString({ name: '监听地址', value: server.host, max: 256 });
        if (hostErr) errors.push(hostErr);
      }
    }

    // 验证安全配置
    if (security) {
      if (security.apiKey !== undefined && security.apiKey !== null) {
        const keyErr = checkString({ name: 'API Key', value: security.apiKey, max: 256, optional: true });
        if (keyErr) errors.push(keyErr);
      }
      if (security.adminPassword !== undefined && security.adminPassword !== null && security.adminPassword !== '') {
        const pwdErr = checkString({ name: '管理员密码', value: security.adminPassword, min: 8, max: 256 });
        if (pwdErr) errors.push(pwdErr);
      }
      if (security.maxRequestSize !== undefined) {
        const sizePattern = /^\d+(kb|mb|gb)?$/i;
        if (!sizePattern.test(security.maxRequestSize)) {
          errors.push('请求体大小格式无效，应为如 50mb, 100kb 格式');
        }
      }
    }

    // 验证默认参数
    if (defaults) {
      if (defaults.temperature !== undefined) {
        const tempErr = checkNumberRange({ name: 'Temperature', value: Number(defaults.temperature), min: 0, max: 2 });
        if (tempErr) errors.push(tempErr);
      }
      if (defaults.top_p !== undefined) {
        const topPErr = checkNumberRange({ name: 'Top P', value: Number(defaults.top_p), min: 0, max: 1 });
        if (topPErr) errors.push(topPErr);
      }
      if (defaults.top_k !== undefined) {
        const topKErr = checkNumberRange({ name: 'Top K', value: Number(defaults.top_k), min: 1, max: 1000 });
        if (topKErr) errors.push(topKErr);
      }
      if (defaults.max_tokens !== undefined) {
        const maxTErr = checkNumberRange({ name: '最大 Token 数', value: Number(defaults.max_tokens), min: 1, max: 1000000 });
        if (maxTErr) errors.push(maxTErr);
      }
    }

    // 验证系统指令
    if (systemInstruction !== undefined) {
      const sysErr = checkString({ name: '系统指令', value: systemInstruction, max: 50000, optional: true });
      if (sysErr) errors.push(sysErr);
    }

    // 返回第一个错误
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0] });
    }

    const result = await saveSettings(req.body);
    await addLog('success', '系统设置已更新');
    return res.json(result);
  } catch (error) {
    const err = error as Error;
    await addLog('error', `保存设置失败: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
export { incrementRequestCount } from './monitor.js';
export { addLog } from './log-manager.js';
