import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';

const KEYS_FILE = path.join(process.cwd(), 'data', 'api_keys.json');
const fileMutex = new Mutex();

// 内存缓存
let keysCache: ApiKey[] | null = null;

// 自动保存定时器
let autoSaveInterval: NodeJS.Timeout | null = null;

interface RateLimit {
  enabled: boolean;
  maxRequests: number;
  windowMs: number;
}

interface KeyUsage {
  [timestamp: string]: number;
}

interface ApiKey {
  key: string;
  name: string;
  created: string;
  lastUsed: string | null;
  requests: number;
  rateLimit: RateLimit;
  usage: KeyUsage;
}

// 确保数据目录存在
async function ensureDataDir() {
  const dataDir = path.dirname(KEYS_FILE);
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// 生成随机 API 密钥
function generateApiKey() {
  return 'sk-' + crypto.randomBytes(32).toString('hex');
}

// 初始化缓存
async function ensureInitialized() {
  if (keysCache !== null) return;
  
  await fileMutex.runExclusive(async () => {
    if (keysCache !== null) return; // Double check
    
    await ensureDataDir();
    try {
      const data = await fs.readFile(KEYS_FILE, 'utf-8');
      keysCache = JSON.parse(data) as ApiKey[];
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        keysCache = [];
      } else {
        logger.error('加载密钥文件失败', error);
        throw error;
      }
    }

    // 启动自动保存，定期将统计数据（如 usage, requests）写入磁盘
    if (!autoSaveInterval) {
      autoSaveInterval = setInterval(() => {
        persistKeys().catch(err => logger.error('自动保存密钥数据失败', err));
      }, 60000); // 每分钟保存一次
    }
  });
}

// 将缓存写入磁盘
async function persistKeys() {
  if (keysCache === null) return;
  
  await fileMutex.runExclusive(async () => {
    await ensureDataDir();
    await fs.writeFile(KEYS_FILE, JSON.stringify(keysCache, null, 2), 'utf-8');
  });
}

// 加载所有密钥 (返回缓存的副本以防止外部直接修改缓存结构，但对象引用可能仍然共享，需注意)
// 这里为了简化，直接返回缓存引用，但操作需通过导出的函数进行
export async function loadKeys(): Promise<ApiKey[]> {
  await ensureInitialized();
  return keysCache || [];
}

// 创建新密钥
export async function createKey(name: string = '未命名', rateLimit: RateLimit | null = null, customKey: string | null = null) {
  await ensureInitialized();
  
  if (!keysCache) throw new Error('初始化失败');

  if (customKey) {
    if (keysCache.some((k: ApiKey) => k.key === customKey)) {
      throw new Error('密钥已存在');
    }
  }

  const newKey: ApiKey = {
    key: customKey || generateApiKey(),
    name,
    created: new Date().toISOString(),
    lastUsed: null,
    requests: 0,
    rateLimit: rateLimit || { enabled: false, maxRequests: 100, windowMs: 60000 }, // 默认 100 次/分钟
    usage: {} // 用于存储使用记录 { timestamp: count }
  };
  
  keysCache.push(newKey);
  
  // 立即同步到磁盘
  await persistKeys();
  
  logger.info(`新密钥已创建: ${name}`);
  return newKey;
}

// 删除密钥
export async function deleteKey(keyToDelete: string) {
  await ensureInitialized();
  
  if (!keysCache) throw new Error('初始化失败');

  const initialLength = keysCache.length;
  keysCache = keysCache.filter((k: ApiKey) => k.key !== keyToDelete);
  
  if (keysCache.length === initialLength) {
    throw new Error('密钥不存在');
  }
  
  // 立即同步到磁盘
  await persistKeys();
  
  logger.info(`密钥已删除: ${keyToDelete.substring(0, 10)}...`);
  return true;
}

// 验证密钥
export async function validateKey(keyToCheck: string) {
  await ensureInitialized();
  
  if (!keysCache) return false;

  const key = keysCache.find((k: ApiKey) => k.key === keyToCheck);
  if (key) {
    // 更新使用信息 (仅内存)
    key.lastUsed = new Date().toISOString();
    key.requests = (key.requests || 0) + 1;
    // 注意：此处不立即保存，依赖定期自动保存或关键操作时的保存
    return true;
  }
  return false;
}

// 获取密钥统计
export async function getKeyStats() {
  await ensureInitialized();
  
  if (!keysCache) return { total: 0, active: 0, totalRequests: 0 };

  return {
    total: keysCache.length,
    active: keysCache.filter((k: ApiKey) => k.lastUsed).length,
    totalRequests: keysCache.reduce((sum: number, k: ApiKey) => sum + (k.requests || 0), 0)
  };
}

// 更新密钥频率限制
export async function updateKeyRateLimit(keyToUpdate: string, rateLimit: RateLimit) {
  await ensureInitialized();
  
  if (!keysCache) throw new Error('初始化失败');

  const key = keysCache.find((k: ApiKey) => k.key === keyToUpdate);
  if (!key) {
    throw new Error('密钥不存在');
  }
  
  key.rateLimit = rateLimit;
  
  // 立即同步到磁盘
  await persistKeys();
  
  logger.info(`密钥频率限制已更新: ${keyToUpdate.substring(0, 10)}...`);
  return key;
}

// 检查频率限制
export async function checkRateLimit(keyToCheck: string) {
  await ensureInitialized();
  
  if (!keysCache) return { allowed: false, error: '系统错误' };

  const key = keysCache.find((k: ApiKey) => k.key === keyToCheck);

  if (!key) {
    return { allowed: false, error: '密钥不存在' };
  }

  // 如果未启用频率限制，直接允许
  if (!key.rateLimit || !key.rateLimit.enabled) {
    return { allowed: true };
  }

  const now = Date.now();
  const windowMs = key.rateLimit.windowMs || 60000;
  const maxRequests = key.rateLimit.maxRequests || 100;

  // 清理过期的使用记录 (仅内存操作)
  key.usage = key.usage || {};
  const cutoffTime = now - windowMs;

  // 计算当前时间窗口内的请求数
  let requestCount = 0;
  for (const [timestamp, count] of Object.entries(key.usage)) {
    if (parseInt(timestamp) >= cutoffTime) {
      requestCount += (count as number);
    } else {
      delete key.usage[timestamp]; // 清理过期记录
    }
  }

  // 检查是否超过限制
  if (requestCount >= maxRequests) {
    const resetTime = Math.min(...Object.keys(key.usage).map(t => parseInt(t))) + windowMs;
    const waitSeconds = Math.ceil((resetTime - now) / 1000);
    return {
      allowed: false,
      error: '请求频率超限',
      resetIn: waitSeconds,
      limit: maxRequests,
      remaining: 0
    };
  }

  // 记录本次请求 (仅内存操作)
  const minute = Math.floor(now / 10000) * 10000; // 按10秒分组
  key.usage[minute] = (key.usage[minute] || 0) + 1;

  // 注意：此处不调用 persistKeys()，完全在内存中进行

  return {
    allowed: true,
    limit: maxRequests,
    remaining: maxRequests - requestCount - 1
  };
}