import express, { Request, Response, Application } from 'express';

interface OpenAIRouteDeps {
  generateAssistantResponse: (body: any, callback: (data: any) => void) => Promise<void>;
  generateRequestBody: (messages: any[], model: string, params: any, tools: any[], apiKey?: string) => any;
  countTokensSafe: (messages: any[], model?: string) => { tokens: number; model: string; fallback: boolean };
  countJsonTokensSafe: (value: any) => number;
  logger: any;
  getAvailableModels: () => Promise<any>;
}

function registerOpenAIRoutes(app: Application, deps: OpenAIRouteDeps): void {
  const {
    generateAssistantResponse,
    generateRequestBody,
    countTokensSafe,
    countJsonTokensSafe,
    logger,
    getAvailableModels
  } = deps;

  const router = express.Router();

  router.post('/chat/completions/count_tokens', (req: Request, res: Response) => {
    const { messages = [], tools = [] } = req.body || {};
    try {
      const chatResult = countTokensSafe(messages);
      const prompt_tokens = chatResult.tokens + (tools?.length ? countJsonTokensSafe(tools) : 0);
      const completion_tokens = 0;
      const total_tokens = prompt_tokens + completion_tokens;

      res.json({
        object: 'tokens',
        model: chatResult.model,
        fallback: chatResult.fallback,
        prompt_tokens,
        completion_tokens,
        total_tokens
      });
    } catch (error: any) {
      logger.error('chat completions count_tokens 计算失败:', error.message);
      res.status(500).json({ error: 'Failed to count tokens' });
    }
  });

  router.get('/models', async (_req: Request, res: Response) => {
    try {
      const models = await getAvailableModels();
      res.json(models);
    } catch (error: any) {
      logger.error('获取模型列表失败:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/chat/completions', async (req: Request, res: Response): Promise<any> => {
    let { messages, model, stream = true, tools = [], ...params } = req.body;
    try {
      if (!messages) {
        return res.status(400).json({ error: 'messages is required' });
      }

      // 智能检测：NewAPI 测速请求通常消息很简单，强制使用非流式响应
      const isSingleShortMessage = messages.length === 1 &&
        messages[0].content &&
        messages[0].content.length < 20;
      if (isSingleShortMessage && req.body.stream === undefined) {
        stream = false;
      }

      const authHeader = req.headers.authorization;
      const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

      const requestBody = generateRequestBody(messages, model, params, tools, apiKey);
      const promptUsage = countTokensSafe(messages);
      const toolUsageTokens = tools?.length ? countJsonTokensSafe(tools) : 0;

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let hasToolCall = false;
        let contentAcc = '';
        let toolCallsAcc: any[] = [];

        await generateAssistantResponse(requestBody, (data) => {
          if (data.type === 'tool_calls') {
            hasToolCall = true;
            toolCallsAcc = data.tool_calls || [];
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { tool_calls: data.tool_calls }, finish_reason: null }]
            })}\n\n`);
          } else {
            contentAcc += data.content;
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
            })}\n\n`);
          }
        });

        const outputUsage = countTokensSafe([{
          role: 'assistant',
          content: contentAcc,
          ...(toolCallsAcc.length ? { tool_calls: toolCallsAcc } : {})
        }], model);
        const usage = {
          prompt_tokens: promptUsage.tokens + toolUsageTokens,
          completion_tokens: outputUsage.tokens,
          total_tokens: (promptUsage.tokens + toolUsageTokens) + outputUsage.tokens,
          fallback: promptUsage.fallback || outputUsage.fallback
        };

        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }]
        })}\n\n`);

        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          usage,
          choices: []
        })}\n\n`);

        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        let fullContent = '';
        let toolCalls: any[] = [];
        await generateAssistantResponse(requestBody, (data) => {
          if (data.type === 'tool_calls') {
            toolCalls = data.tool_calls;
          } else {
            fullContent += data.content;
          }
        });

        const message: any = { role: 'assistant', content: fullContent };
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }

        const outputUsage = countTokensSafe([message], model);
        const usage = {
          prompt_tokens: promptUsage.tokens + toolUsageTokens,
          completion_tokens: outputUsage.tokens,
          total_tokens: (promptUsage.tokens + toolUsageTokens) + outputUsage.tokens,
          fallback: promptUsage.fallback || outputUsage.fallback
        };

        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
          }],
          usage
        });
      }
    } catch (error: any) {
      logger.error('生成响应失败:', error.message);
      if (!res.headersSent) {
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const id = `chatcmpl-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: `错误: ${error.message}` }, finish_reason: null }]
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.status(500).json({ error: error.message });
        }
      }
    }
  });

  app.use('/v1', router);
}

export default registerOpenAIRoutes;
