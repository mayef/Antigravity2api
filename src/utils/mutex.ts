/**
 * 一个简单的互斥锁实现，用于确保异步操作的串行执行。
 */
export class Mutex {
  private queue: Array<(release: () => void) => void> = [];
  private locked = false;

  /**
   * 获取锁。返回一个 Promise，解析为释放锁的函数。
   */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          if (next) next(release);
        } else {
          this.locked = false;
        }
      };

      if (!this.locked) {
        this.locked = true;
        resolve(release);
      } else {
        this.queue.push(resolve);
      }
    });
  }

  /**
   * 在锁的保护下执行一个函数。
   * @param callback 要执行的函数
   */
  async runExclusive<T>(callback: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await callback();
    } finally {
      release();
    }
  }
}