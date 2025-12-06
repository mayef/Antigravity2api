import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token-manager.js';

interface Account {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  timestamp: number;
  enable: boolean;
  email?: string;
  name?: string;
}

// 读取所有账号
export async function loadAccounts(): Promise<Account[]> {
  return await tokenManager.getAccounts();
}

// 删除账号
export async function deleteAccount(index: number) {
  await tokenManager.deleteAccount(index);
  logger.info(`账号 ${index} 已删除`);
  return true;
}

// 启用/禁用账号
export async function toggleAccount(index: number, enable: boolean) {
  await tokenManager.toggleAccount(index, enable);
  logger.info(`账号 ${index} 已${enable ? '启用' : '禁用'}`);
  return true;
}

// 触发登录流程
export async function triggerLogin() {
  return new Promise((resolve, reject) => {
    logger.info('启动登录流程...');

    const loginScript = path.join(process.cwd(), 'scripts', 'oauth-server.js');
    const child = spawn('node', [loginScript], {
      stdio: 'pipe'
    });

    let authUrl = '';
    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;

      // 提取授权 URL
      const urlMatch = text.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+)/);
      if (urlMatch) {
        authUrl = urlMatch[1];
      }

      logger.info(text.trim());
    });

    child.stderr.on('data', (data) => {
      logger.error(data.toString().trim());
    });

    child.on('close', (code) => {
      if (code === 0) {
        logger.info('登录流程完成');
        resolve({ success: true, authUrl, message: '登录成功' });
      } else {
        reject(new Error('登录流程失败'));
      }
    });

    // 5 秒后返回授权 URL，不等待完成
    setTimeout(() => {
      if (authUrl) {
        resolve({ success: true, authUrl, message: '请在浏览器中完成授权' });
      }
    }, 5000);

    child.on('error', (error) => {
      reject(error);
    });
  });
}

// 获取账号统计信息
export async function getAccountStats() {
  const accounts = await tokenManager.getAccounts();
  return {
    total: accounts.length,
    enabled: accounts.filter((a: Account) => a.enable !== false).length,
    disabled: accounts.filter((a: Account) => a.enable === false).length
  };
}

// 从回调链接手动添加 Token

// OAuth 凭证从配置文件读取
const getClientId = () => config.oauth?.clientId;
const getClientSecret = () => config.oauth?.clientSecret;

// 获取 Google 账号信息
export async function getAccountName(accessToken: string) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: '/oauth2/v2/userinfo',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const data = JSON.parse(body);
          resolve({
            email: data.email,
            name: data.name || data.email
          });
        } else {
          resolve({ email: 'Unknown', name: 'Unknown' });
        }
      });
    });

    req.on('error', () => resolve({ email: 'Unknown', name: 'Unknown' }));
    req.end();
  });
}

export async function addTokenFromCallback(callbackUrl: string) {
  // 解析回调链接
  const url = new URL(callbackUrl);
  
  // SSRF 防护：只允许 localhost 回调（白名单模式）
  const hostname = url.hostname.toLowerCase();
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (!allowedHosts.includes(hostname)) {
    throw new Error('回调链接必须是 localhost 地址');
  }
  
  const code = url.searchParams.get('code');

  if (!code) {
    throw new Error('回调链接中没有找到授权码 (code)');
  }

  logger.info(`正在使用授权码换取 Token...`);

  // 使用授权码换取 Token
  const tokenData: any = await exchangeCodeForToken(code, url.origin);

  // 保存账号
  const account: Account = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    timestamp: Date.now(),
    enable: true
  };

  await tokenManager.addAccount(account);

  logger.info('Token 已成功保存');
  return { success: true, message: 'Token 已成功添加' };
}

function exchangeCodeForToken(code: string, origin: string) {
  return new Promise((resolve, reject) => {
    const redirectUri = `${origin}/oauth-callback`;

    const postData = new URLSearchParams({
      code: code,
      client_id: getClientId() || '',
      client_secret: getClientSecret() || '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          logger.error(`Token 交换失败: ${body}`);
          reject(new Error(`Token 交换失败: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const MAX_IMPORT_ITEMS = 500;
const MAX_TOKENS_JSON_SIZE = 5 * 1024 * 1024; // 5MB 防止巨型文件

function validateImportedToken(token: any) {
  if (!token || typeof token !== 'object') return false;
  const hasAccess = typeof token.access_token === 'string' && token.access_token.length > 0;
  const hasRefresh = typeof token.refresh_token === 'string' && token.refresh_token.length > 0;
  if (!hasAccess || !hasRefresh) return false;
  if (token.expires_in && typeof token.expires_in !== 'number') return false;
  return true;
}

// 批量导入 Token
export async function importTokens(filePath: string) {
  try {
    logger.info('开始导入 Token...');

    // 文件大小上限检查
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_TOKENS_JSON_SIZE * 2) {
        throw new Error('上传文件过大');
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    // 尝试作为 ZIP 文件读取（multer 保存的临时文件可能没有扩展名）
    let zip;
    try {
      zip = new AdmZip(filePath);
    } catch (zipError) {
      throw new Error('无法解析上传文件，请确保上传的是有效的 ZIP 文件');
    }
    const zipEntries = zip.getEntries();

    // 查找 tokens.json（使用 basename 防止路径遍历）
    const tokensEntry = zipEntries.find(entry => path.basename(entry.entryName) === 'tokens.json');
    if (!tokensEntry) {
      throw new Error('ZIP 文件中没有找到 tokens.json');
    }

    const tokensBuffer = tokensEntry.getData();
    if (tokensBuffer.length > MAX_TOKENS_JSON_SIZE) {
      throw new Error('tokens.json 体积过大');
    }

    const tokensContent = tokensBuffer.toString('utf8');
    const importedTokens = JSON.parse(tokensContent);

    // 验证数据格式
    if (!Array.isArray(importedTokens)) {
      throw new Error('tokens.json 格式错误：应该是一个数组');
    }
    if (importedTokens.length > MAX_IMPORT_ITEMS) {
      throw new Error(`一次最多导入 ${MAX_IMPORT_ITEMS} 个账号`);
    }

    // 构建待添加账号列表
    const newAccounts: any[] = [];
    
    for (const token of importedTokens) {
        if (!validateImportedToken(token)) {
             throw new Error('tokens.json 含无效字段或缺少必要字段');
        }
        
        newAccounts.push({
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_in: token.expires_in,
            timestamp: token.timestamp || Date.now(),
            enable: token.enable !== false
        });
    }

    // 批量添加并获取实际添加数量
    const addedCount = await tokenManager.addAccounts(newAccounts);

    logger.info(`成功导入 ${addedCount} 个 Token 账号`);
    return {
      success: true,
      count: addedCount,
      total: importedTokens.length,
      skipped: importedTokens.length - addedCount,
      message: `成功导入 ${addedCount} 个 Token 账号${importedTokens.length - addedCount > 0 ? `，跳过 ${importedTokens.length - addedCount} 个重复账号` : ''}`
    };
  } catch (error) {
    logger.error('导入 Token 失败:', error);
    throw error;
  } finally {
    // 清理上传的文件
    try {
      await fs.unlink(filePath);
    } catch (e) {}
  }
}
