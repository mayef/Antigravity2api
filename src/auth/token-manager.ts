import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import config from '../config/config.js';
import { Mutex } from '../utils/mutex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// OAuth 凭证从配置文件读取
const getClientId = () => config.oauth?.clientId;
const getClientSecret = () => config.oauth?.clientSecret;

class TokenManager {
  private filePath: string;
  private tokens: any[];
  private currentIndex: number;
  private lastLoadTime: number;
  private loadInterval: number;
  private cachedData: any;
  private usageStats: Map<string, { requests: number; lastUsed: number | null }>;
  private fileMutex: Mutex;

  constructor(filePath: string = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    this.lastLoadTime = 0;
    this.loadInterval = 60000; // 1分钟内不重复加载
    this.cachedData = null; // 缓存文件数据，减少磁盘读取
    this.usageStats = new Map(); // Token 使用统计 { refresh_token -> { requests, lastUsed } }
    this.fileMutex = new Mutex();
    // 构造函数中不再同步加载，改为懒加载或异步初始化
    // 但为了保持兼容性，这里暂时保留同步读取尝试，或者留空等待第一次调用
    try {
       const data = fs.readFileSync(this.filePath, 'utf8');
       this.cachedData = JSON.parse(data);
       this.tokens = this.cachedData.filter((token: any) => token.enable !== false);
    } catch (e) {
       this.tokens = [];
    }
  }

  async loadTokens(): Promise<void> {
    // 避免频繁加载，1分钟内使用缓存
    if (Date.now() - this.lastLoadTime < this.loadInterval && this.tokens.length > 0) {
      return;
    }

    await this.fileMutex.runExclusive(async () => {
        // Double check inside lock
        if (Date.now() - this.lastLoadTime < this.loadInterval && this.tokens.length > 0) {
            return;
        }

        try {
            log.info('正在加载token...');
            const data = await fs.promises.readFile(this.filePath, 'utf8');
            const tokenArray = JSON.parse(data);
            this.cachedData = tokenArray; // 缓存原始数据
            this.tokens = tokenArray.filter((token: any) => token.enable !== false);
            // 只有当 currentIndex 超出范围时重置，或者保持原样？
            // 原逻辑重置为0，这可能导致轮询不均匀，但在重新加载时也许是合理的
            if (this.currentIndex >= this.tokens.length) {
                this.currentIndex = 0;
            }
            this.lastLoadTime = Date.now();
            log.info(`成功加载 ${this.tokens.length} 个可用token`);

            // 触发垃圾回收（如果可用）
            if (global.gc) {
                global.gc();
            }
        } catch (error: any) {
            log.error('加载token失败:', error.message);
            // 如果读取失败，不要清空现有tokens，除非是文件不存在
            if (error.code === 'ENOENT') {
                 this.tokens = [];
                 this.cachedData = [];
            }
        }
    });
  }

  isExpired(token: any): boolean {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - 300000;
  }

  async refreshToken(token: any): Promise<any> {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: getClientId() || '',
      client_secret: getClientSecret() || '',
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Host': 'oauth2.googleapis.com',
        'User-Agent': 'Go-http-client/1.1',
        'Content-Length': body.toString().length.toString(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Encoding': 'gzip'
      },
      body: body.toString()
    });

    if (response.ok) {
      const data: any = await response.json();
      token.access_token = data.access_token;
      token.expires_in = data.expires_in;
      token.timestamp = Date.now();
      await this.saveToFile();
      return token;
    } else {
      throw { statusCode: response.status, message: await response.text() };
    }
  }

  async saveToFile(): Promise<void> {
    await this.fileMutex.runExclusive(async () => {
        try {
            // 确保 cachedData 是最新的
            if (!this.cachedData) {
                try {
                    const data = await fs.promises.readFile(this.filePath, 'utf8');
                    this.cachedData = JSON.parse(data);
                } catch (e) {
                    this.cachedData = [];
                }
            }
            
            let allTokens = this.cachedData || [];

            // 将内存中的 token 状态同步回 allTokens
            // 注意：this.tokens 只是 enabled 的 token 子集
            // 这里我们需要小心，不要覆盖掉 disabled 的 token，也不要丢失新增的
            
            // 更安全的做法是：如果是更新操作，我们应该明确更新哪一个。
            // 但在这里，this.tokens 中的对象引用可能直接修改了（例如 refreshToken 中）
            // 所以我们需要把 this.tokens 中的变更反映到 cachedData 中
            
            this.tokens.forEach((memToken: any) => {
                const index = allTokens.findIndex((t: any) => t.refresh_token === memToken.refresh_token);
                if (index !== -1) {
                    allTokens[index] = memToken;
                } else {
                    // 如果内存中有但缓存中没有，可能是新加的？或者逻辑错误？
                    // 暂时假设是同步更新
                    allTokens.push(memToken);
                }
            });

            await fs.promises.writeFile(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
            // this.cachedData 已经在上面更新了引用，或者 push 了
        } catch (error: any) {
            log.error('保存文件失败:', error.message);
        }
    });
  }

  async disableToken(token: any): Promise<void> {
    log.warn(`禁用token`)
    token.enable = false;
    await this.saveToFile();
    await this.loadTokens();
  }

  async getToken(): Promise<any> {
    await this.loadTokens();
    if (this.tokens.length === 0) return null;

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[this.currentIndex];
      const tokenIndex = this.currentIndex;

      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;

        // 记录使用统计
        this.recordUsage(token);
        log.info(`🔄 轮询使用 Token #${tokenIndex} (总请求: ${this.getTokenRequests(token)})`);

        return token;
      } catch (error: any) {
        if (error.statusCode === 403) {
          log.warn(`Token ${this.currentIndex} 刷新失败(403)，禁用并尝试下一个`);
          await this.disableToken(token);
        } else {
          log.error(`Token ${this.currentIndex} 刷新失败:`, error.message);
        }
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        if (this.tokens.length === 0) return null;
      }
    }

    return null;
  }

  // 记录 Token 使用
  recordUsage(token: any): void {
    const key = token.refresh_token;
    if (!this.usageStats.has(key)) {
      this.usageStats.set(key, { requests: 0, lastUsed: null });
    }
    const stats = this.usageStats.get(key);
    if (stats) {
      stats.requests++;
      stats.lastUsed = Date.now();
    }
  }

  // 获取单个 Token 的请求次数
  getTokenRequests(token: any): number {
    const stats = this.usageStats.get(token.refresh_token);
    return stats ? stats.requests : 0;
  }

  // 获取所有 Token 的使用统计
  getUsageStats(): any {
    const stats: any[] = [];
    this.tokens.forEach((token: any, index: number) => {
      const usage = this.usageStats.get(token.refresh_token) || { requests: 0, lastUsed: null };
      stats.push({
        index,
        requests: usage.requests,
        lastUsed: usage.lastUsed ? new Date(usage.lastUsed).toISOString() : null,
        isCurrent: index === this.currentIndex
      });
    });
    return {
      totalTokens: this.tokens.length,
      currentIndex: this.currentIndex,
      totalRequests: Array.from(this.usageStats.values()).reduce((sum: number, s: any) => sum + s.requests, 0),
      tokens: stats
    };
  }

  async disableCurrentToken(token: any): Promise<void> {
    const found = this.tokens.find((t: any) => t.access_token === token.access_token);
    if (found) {
      await this.disableToken(found);
    }
  }

  async handleRequestError(error: any, currentAccessToken: any): Promise<any> {
    if (error.statusCode === 403) {
      log.warn('请求遇到403错误，尝试刷新token');
      const currentToken = this.tokens[this.currentIndex];
      if (currentToken && currentToken.access_token === currentAccessToken) {
        try {
          await this.refreshToken(currentToken);
          log.info('Token刷新成功，返回新token');
          return currentToken;
        } catch (refreshError: any) {
          if (refreshError.statusCode === 403) {
            log.warn('刷新token也遇到403，禁用并切换到下一个');
            await this.disableToken(currentToken);
            return await this.getToken();
          }
          log.error('刷新token失败:', refreshError.message);
        }
      }
      return await this.getToken();
    }
    return null;
  }

  // --- CRUD Methods for Admin ---

  async getAccounts(): Promise<any[]> {
      return await this.fileMutex.runExclusive(async () => {
          try {
              const data = await fs.promises.readFile(this.filePath, 'utf8');
              this.cachedData = JSON.parse(data);
              return this.cachedData;
          } catch (e: any) {
              if (e.code === 'ENOENT') return [];
              throw e;
          }
      });
  }

  async addAccount(account: any): Promise<void> {
      await this.fileMutex.runExclusive(async () => {
          await this._reloadCache();
          // 检查 access_token 是否已存在
          const exists = this.cachedData.some((t: any) => t.access_token === account.access_token);
          if (!exists) {
              this.cachedData.push(account);
              await this._writeCache();
          }
      });
      // 重新加载以更新内存中的 tokens
      await this.loadTokens();
  }

  async addAccounts(accounts: any[]): Promise<number> {
      let addedCount = 0;
      await this.fileMutex.runExclusive(async () => {
          await this._reloadCache();
          
          for (const account of accounts) {
              // 简单去重：检查 access_token
              const exists = this.cachedData.some((t: any) => t.access_token === account.access_token);
              if (!exists) {
                  this.cachedData.push(account);
                  addedCount++;
              }
          }

          if (addedCount > 0) {
              await this._writeCache();
          }
      });

      if (addedCount > 0) {
          await this.loadTokens();
      }
      return addedCount;
  }

  async deleteAccount(index: number): Promise<void> {
      await this.fileMutex.runExclusive(async () => {
          await this._reloadCache();
          if (index >= 0 && index < this.cachedData.length) {
              this.cachedData.splice(index, 1);
              await this._writeCache();
          } else {
              throw new Error('无效的账号索引');
          }
      });
      await this.loadTokens();
  }

  async toggleAccount(index: number, enable: boolean): Promise<void> {
      await this.fileMutex.runExclusive(async () => {
          await this._reloadCache();
          if (index >= 0 && index < this.cachedData.length) {
              this.cachedData[index].enable = enable;
              await this._writeCache();
          } else {
               throw new Error('无效的账号索引');
          }
      });
      // 强制刷新
      this.lastLoadTime = 0;
      await this.loadTokens();
  }
  
  async updateAccount(index: number, updates: any): Promise<void> {
      await this.fileMutex.runExclusive(async () => {
          await this._reloadCache();
          if (index >= 0 && index < this.cachedData.length) {
              this.cachedData[index] = { ...this.cachedData[index], ...updates };
              await this._writeCache();
          }
      });
      this.lastLoadTime = 0;
      await this.loadTokens();
  }

  // Helper to reload cache from disk inside lock
  private async _reloadCache() {
      try {
          const data = await fs.promises.readFile(this.filePath, 'utf8');
          this.cachedData = JSON.parse(data);
      } catch (e: any) {
          if (e.code === 'ENOENT') {
              this.cachedData = [];
          } else {
              throw e;
          }
      }
  }

  // Helper to write cache to disk inside lock
  private async _writeCache() {
      await fs.promises.writeFile(this.filePath, JSON.stringify(this.cachedData, null, 2), 'utf8');
  }
}
const tokenManager = new TokenManager();
export default tokenManager;
