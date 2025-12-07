import fs from 'fs/promises';
import path from 'path';
import { Mutex } from '../utils/mutex.js';

const LOGS_FILE = path.join(process.cwd(), 'data', 'app_logs.json');
const MAX_LOGS = 200; // 最多保存 200 条日志（降低内存使用）
const FLUSH_INTERVAL = 42; // 42秒写入一次
const MAX_BUFFER_SIZE = 50; // 缓冲区最大条数

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

const fileMutex = new Mutex();
let logBuffer: LogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;

// 确保数据目录存在
async function ensureDataDir() {
  const dataDir = path.dirname(LOGS_FILE);
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// 加载日志
export async function loadLogs(): Promise<LogEntry[]> {
  await fileMutex.runExclusive(async () => {
      await ensureDataDir();
  });
  
  try {
    const data = await fs.readFile(LOGS_FILE, 'utf-8');
    return JSON.parse(data) as LogEntry[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// 将缓冲区日志写入文件
async function flushLogs() {
  if (logBuffer.length === 0) return;

  // 取出并清空缓冲区
  const logsToSave = [...logBuffer];
  logBuffer = [];

  await fileMutex.runExclusive(async () => {
    try {
      await ensureDataDir();
      
      let currentLogs: LogEntry[] = [];
      try {
        const data = await fs.readFile(LOGS_FILE, 'utf-8');
        currentLogs = JSON.parse(data) as LogEntry[];
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw error;
      }

      // 合并并截断
      const newLogs = currentLogs.concat(logsToSave).slice(-MAX_LOGS);
      await fs.writeFile(LOGS_FILE, JSON.stringify(newLogs, null, 2), 'utf-8');
    } catch (err) {
      // 如果写入失败，尝试将日志放回缓冲区前面（可选，视重要性而定）
      // 这里简单记录错误
      console.error('Failed to flush logs:', err);
    }
  });
}

// 启动定期刷新
function startFlushTimer() {
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushLogs().catch(err => console.error('Auto flush failed:', err));
    }, FLUSH_INTERVAL);
  }
}

// 添加日志
export async function addLog(level: string, message: string) {
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });

  // 如果缓冲区满了，立即刷新
  if (logBuffer.length >= MAX_BUFFER_SIZE) {
    // 异步触发，不阻塞当前请求
    flushLogs().catch(err => console.error('Buffer full flush failed:', err));
  } else {
    // 确保存储定时器已启动
    startFlushTimer();
  }
}

// 清空日志
export async function clearLogs() {
  logBuffer = []; // 清空缓冲区
  await fileMutex.runExclusive(async () => {
    await ensureDataDir();
    await fs.writeFile(LOGS_FILE, JSON.stringify([], null, 2), 'utf-8');
  });
}

// 获取最近的日志 (包含缓冲区中的未写入日志)
export async function getRecentLogs(limit = 100) {
  // 读取磁盘日志
  let diskLogs: LogEntry[] = [];
  try {
    const data = await fs.readFile(LOGS_FILE, 'utf-8');
    diskLogs = JSON.parse(data) as LogEntry[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
  }

  // 合并磁盘日志和内存缓冲区日志
  const allLogs = diskLogs.concat(logBuffer);
  return allLogs.slice(-limit).reverse();
}