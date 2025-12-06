import fs from 'fs';
import log from '../utils/logger.js';

interface ConfigType {
  server: { port: number; host: string };
  api: {
    url: string;
    modelsUrl: string;
    host: string;
    userAgent: string;
  };
  oauth: {
    clientId: string | null;
    clientSecret: string | null;
  };
  defaults: { temperature: number; top_p: number; top_k: number; max_tokens: number };
  security: { maxRequestSize: string; apiKey: string | null; adminPassword?: string };
  systemInstruction: string;
}

const defaultConfig: ConfigType = {
  server: { port: 8045, host: '127.0.0.1' },
  api: {
    url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    modelsUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    host: 'daily-cloudcode-pa.sandbox.googleapis.com',
    userAgent: 'antigravity/1.11.3 windows/amd64'
  },
  oauth: {
    // 默认不再内置凭证，改为从环境变量或 config.json 提供
    clientId: process.env.OAUTH_CLIENT_ID || null,
    clientSecret: process.env.OAUTH_CLIENT_SECRET || null
  },
  defaults: { temperature: 1, top_p: 0.85, top_k: 50, max_tokens: 8096 },
  security: { maxRequestSize: '50mb', apiKey: null },
  systemInstruction: '你是聊天机器人，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演，也可以提供数学或者代码上的建议'
};

let config: ConfigType = JSON.parse(JSON.stringify(defaultConfig));

export function reloadConfig(): boolean {
  try {
    const newConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

    // 递归合并配置
    // 1. 基础合并
    Object.assign(config, newConfig);

    // 2. 深度合并关键部分
    if (newConfig.server) Object.assign(config.server, newConfig.server);
    if (newConfig.api) Object.assign(config.api, newConfig.api);
    if (newConfig.defaults) Object.assign(config.defaults, newConfig.defaults);
    if (newConfig.security) Object.assign(config.security, newConfig.security);
    if (newConfig.oauth) Object.assign(config.oauth, newConfig.oauth);

    log.info('✓ 配置文件已重载');
    return true;
  } catch (error: any) {
    log.error('⚠ 重载配置文件失败:', error.message);
    return false;
  }
}

// 初始化加载
reloadConfig();

export default config;
