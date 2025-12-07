import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { encodeChat, countTokens } from 'gpt-tokenizer';
import { generateAssistantResponse, getAvailableModels } from '../api/client.js';
import { generateRequestBody, generateAnthropicRequestBody } from '../utils/utils.js';
import registerAnthropicRoutes from './routes/anthropic.js';
import registerOpenAIRoutes from './routes/openai.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import adminRoutes, { incrementRequestCount, addLog } from '../admin/routes.js';
import { validateKey, checkRateLimit } from '../admin/key-manager.js';
import idleManager from '../utils/idle-manager.js';
import { sanitizeForLog, formatRequestLog } from '../utils/validators.js';

const DISALLOWED_SPECIAL_TOKENS = ['<|endoftext|>', '<|endofprompt|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>'];

const stripDisallowedSpecialTokens = (text: string = ''): string => {
  if (!text || typeof text !== 'string') return '';
  return DISALLOWED_SPECIAL_TOKENS.reduce((acc, token) => acc.replaceAll(token, ''), text);
};

// 定义内容部分的接口
interface ContentPart {
  text?: string | number | boolean;
  content?: unknown;
  image_url?: { url: string } | string;
}

// 定义消息对象的基本结构
interface MessageShape {
  role?: unknown;
  content?: unknown;
}

const stringifyContent = (content: unknown): string => {
  let result = '';
  if (content === null || content === undefined) {
    result = '';
  } else if (typeof content === 'string') {
    result = content;
  } else if (Array.isArray(content)) {
    result = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (typeof part === 'number' || typeof part === 'boolean') return String(part);
        // 验证 part 是对象后再访问属性
        if (part && typeof part === 'object') {
          const partObj = part as ContentPart;
          if (partObj.text !== undefined) return String(partObj.text);
          if (partObj.content !== undefined) return stringifyContent(partObj.content);
          if (partObj.image_url !== undefined) return '[image]';
        }
        return '';
      })
      .join('');
  } else if (typeof content === 'object') {
    try {
      result = JSON.stringify(content);
    } catch {
      result = '';
    }
  } else {
    result = String(content);
  }

  return stripDisallowedSpecialTokens(result);
};

const normalizeMessagesForEncoding = (msgs: unknown = []): Array<{ role: string; content: string }> => {
  if (!Array.isArray(msgs)) return [];
  return msgs
    .filter(m => m && typeof m === 'object')
    .map(m => {
      const msgObj = m as MessageShape;
      return {
        role: typeof msgObj.role === 'string' ? msgObj.role : 'user',
        content: stringifyContent(msgObj.content)
      };
    });
};

const safeJsonParse = <T>(value: unknown, fallback: T, options: { strict?: boolean; field?: string } = {}): T => {
  const { strict = false, field } = options;
  try {
    if (typeof value === 'string') return JSON.parse(value) as T;
    if (value === null || value === undefined) return fallback;
    return value as T;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `${field ? `${field} ` : ''}JSON 解析失败: ${errorMessage}`;
    if (strict) {
      const err = new Error(message) as Error & { code: string };
      err.code = 'INVALID_JSON';
      throw err;
    }
    logger.warn(message);
    return fallback;
  }
};

// 统一使用 gpt-4o 进行 Token 统计，避免模型差异带来的异常
const countTokensSafe = (messages: unknown = []): { tokens: number; model: string; fallback: boolean } => {
  const calc = (msgs: unknown) => {
    const normalized = normalizeMessagesForEncoding(msgs);
    const tokens = encodeChat(normalized, 'gpt-4o');
    return Array.isArray(tokens) ? tokens.length : 0;
  };

  try {
    return { tokens: calc(messages), model: 'gpt-4o', fallback: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`Token 统计失败(gpt-4o): ${errorMessage}`);
    return { tokens: 0, model: 'gpt-4o', fallback: true };
  }
};

const countJsonTokensSafe = (value: unknown): number => {
  try {
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    return countTokens(payload);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`JSON Token 统计失败: ${errorMessage}`);
    return 0;
  }
};

// 确保必要的目录存在
const ensureDirectories = () => {
  const dirs = ['data', 'uploads'];
  dirs.forEach(dir => {
    const dirPath = path.join(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.info(`创建目录: ${dir}`);
    }
  });
};

ensureDirectories();

const app = express();

// 时间无关的字符串比较，防止时序攻击
const timingSafeEqual = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // 长度不同时仍进行比较以避免时间侧信道
    const bufPadded = Buffer.alloc(bufA.length);
    bufB.copy(bufPadded);
    crypto.timingSafeEqual(bufA, bufPadded);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

// HTTP 安全头（启用精简 CSP，限制外联）
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'", "https:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态资源
app.use(express.static(path.join(process.cwd(), 'client/dist')));

const errorHandler: ErrorRequestHandler = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
    return;
  }
  next(err);
};

app.use(errorHandler);

// ... (rest of the file)



// 请求日志中间件
app.use((req: Request, res: Response, next: NextFunction) => {
  // 记录所有请求活动，管理空闲状态（包括管理界面的请求）
  idleManager.recordActivity();

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.request(req.method, req.path, res.statusCode, duration);

    // 记录到管理日志
    if (req.path.startsWith('/v1/') || req.path.startsWith('/anthropic/v1/')) {
      incrementRequestCount();
      addLog('info', formatRequestLog(req.method, req.path, res.statusCode, duration));
    }
  });
  next();
});

// API 密钥验证和频率限制中间件
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const needsAuth = req.path.startsWith('/v1/') || req.path.startsWith('/anthropic/v1/');
  if (needsAuth) {
    const apiKey = config.security?.apiKey;
    if (!apiKey) {
      // 安全警告：未配置 API Key，拒绝所有请求
      logger.warn('安全警告: 未配置 API Key，API 请求已被拒绝');
      return res.status(401).json({ error: 'API Key not configured. Please set security.apiKey in config.json' });
    }
    if (apiKey) {
      const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    //   logger.info(`apiKeyHeader: ${apiKeyHeader}`);
      const authHeader = req.headers.authorization;
    //   logger.info(`authHeader: ${authHeader}`);
      const providedKey = apiKeyHeader
        || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader) || '';
      //  log debug infos
    //   logger.info(`API Key: ${apiKey}`);
    //   logger.info(`Provided Key: ${providedKey}`);
      // 先检查配置文件中的密钥（不受频率限制）
      if (timingSafeEqual(providedKey, apiKey)) {
        return next();
      }

      // 再检查数据库中的密钥
      const isValid = await validateKey(providedKey);
      if (!isValid) {
        logger.warn(`API Key 验证失败: ${sanitizeForLog(req.method)} ${sanitizeForLog(req.path)}`);
        await addLog('warn', `API Key 验证失败: ${formatRequestLog(req.method, req.path, 401, 0)}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }

      // 检查频率限制
      const rateLimitCheck = await checkRateLimit(providedKey);
      if (!rateLimitCheck.allowed) {
        logger.warn(`频率限制: ${sanitizeForLog(req.method)} ${sanitizeForLog(req.path)} - ${rateLimitCheck.error}`);
        await addLog('warn', `频率限制触发: ${providedKey ? providedKey.substring(0, 10) : 'unknown'}...`);

        res.setHeader('X-RateLimit-Limit', rateLimitCheck.limit || 0);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', rateLimitCheck.resetIn || 0);

        return res.status(429).json({
          error: {
            message: rateLimitCheck.error,
            type: 'rate_limit_exceeded',
            reset_in_seconds: rateLimitCheck.resetIn
          }
        });
      }

      // 设置频率限制响应头
      if (rateLimitCheck.limit !== undefined) {
        res.setHeader('X-RateLimit-Limit', rateLimitCheck.limit);
        res.setHeader('X-RateLimit-Remaining', rateLimitCheck.remaining ?? 0);
      }
    }
  }
  next();
});

// 管理路由
app.use('/admin', adminRoutes);

// 路由注册（拆分文件，便于维护）
registerAnthropicRoutes(app, {
  generateAssistantResponse,
  generateAnthropicRequestBody,
  countTokensSafe,
  countJsonTokensSafe,
  safeJsonParse,
  logger
});

registerOpenAIRoutes(app, {
  generateAssistantResponse,
  generateRequestBody,
  countTokensSafe,
  countJsonTokensSafe,
  logger,
  getAvailableModels
});

// 所有其他请求返回 index.html (SPA 支持)
app.get(/(.*)/, (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'client/dist', 'index.html'));
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');

  // 清理空闲管理器
  idleManager.destroy();

  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
