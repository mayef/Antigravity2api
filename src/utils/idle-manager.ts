import logger from './logger.js';

/**
 * 空闲模式管理器
 * 在没有请求时降低内存使用，减少后台活动
 */
class IdleManager {
  private lastRequestTime: number;
  private idleTimeout: number;
  private isIdle: boolean;
  private gcInterval: NodeJS.Timeout | null;
  private checkInterval: NodeJS.Timeout | null;

  constructor() {
    this.lastRequestTime = Date.now();
    this.idleTimeout = 5 * 60 * 1000; // 5分钟无请求后进入空闲模式
    this.isIdle = false;
    this.gcInterval = null;
    this.checkInterval = null;

    // 启动空闲检查
    this.startIdleCheck();

    // 10秒后立即检查是否应该进入空闲模式
    setTimeout(() => {
      const idleTime = Date.now() - this.lastRequestTime;
      if (idleTime > this.idleTimeout) {
        this.enterIdleMode();
      }
    }, 10000);
  }

  /**
   * 记录请求活动
   */
  recordActivity(): void {
    this.lastRequestTime = Date.now();

    // 如果之前是空闲状态，现在恢复活跃
    if (this.isIdle) {
      this.exitIdleMode();
    }
  }

  /**
   * 启动空闲检查
   */
  startIdleCheck(): void {
    // 每15秒检查一次是否应该进入空闲模式
    this.checkInterval = setInterval(() => {
      const idleTime = Date.now() - this.lastRequestTime;

      if (!this.isIdle && idleTime > this.idleTimeout) {
        this.enterIdleMode();
      }
    }, 15000); // 每15秒检查一次（更频繁）

    // 不阻止进程退出
    this.checkInterval.unref();
  }

  /**
   * 进入空闲模式
   */
  enterIdleMode(): void {
    if (this.isIdle) return;

    logger.info('⏸️  进入空闲模式 - 降低资源使用');
    this.isIdle = true;

    // 触发垃圾回收
    if (global.gc) {
      global.gc();
      logger.info('🗑️  已触发垃圾回收');
    } else {
      // 如果没有启用 --expose-gc，尝试通过其他方式释放内存
      logger.warn('⚠️  未启用 --expose-gc，建议使用 node --expose-gc 启动以获得更好的内存优化');
    }

    // 在空闲模式下，每2分钟进行一次垃圾回收（更频繁）
    this.gcInterval = setInterval(() => {
      if (global.gc) {
        global.gc();
        logger.info('🗑️  空闲模式：定期垃圾回收');
      }
    }, 2 * 60 * 1000); // 每2分钟一次

    // 不阻止进程退出
    this.gcInterval.unref();
  }

  /**
   * 退出空闲模式
   */
  exitIdleMode(): void {
    if (!this.isIdle) return;

    logger.info('▶️  退出空闲模式 - 恢复正常运行');
    this.isIdle = false;

    // 清除空闲模式的定时器
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /**
   * 获取当前状态
   */
  getStatus(): { isIdle: boolean; idleTimeSeconds: number; lastRequestTime: string } {
    const idleTime = Date.now() - this.lastRequestTime;
    return {
      isIdle: this.isIdle,
      idleTimeSeconds: Math.floor(idleTime / 1000),
      lastRequestTime: new Date(this.lastRequestTime).toISOString()
    };
  }

  /**
   * 清理资源
   */
  destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }
  }
}

const idleManager = new IdleManager();
export default idleManager;
