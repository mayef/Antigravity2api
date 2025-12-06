import express, { Request, Response, Application } from 'express';

const extractAnthropicText = (content: any): string => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block?.text) return block.text;
        if (block?.content) return extractAnthropicText(block.content);
        return '';
      })
      .join('');
  }
  if (typeof content === 'object') {
    if (content.text) return content.text;
    if (content.content) return extractAnthropicText(content.content);
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return String(content);
};

const anthropicToTokenMessages = (messages: any[] = [], system?: any): Array<{ role: string; content: string }> => {
  const result: Array<{ role: string; content: string }> = [];
  const pushIfAny = (role: string, text: string) => {
    if (text && String(text).trim()) {
      result.push({ role, content: text });
    }
  };

  if (system) {
    pushIfAny('system', extractAnthropicText(system));
  }

  for (const message of messages) {
    const role = message?.role;
    const blocks = Array.isArray(message?.content)
      ? message.content
      : message?.content
        ? [{ type: 'text', text: message.content }]
        : [];

    if (role === 'user') {
      const pieces = [];
      for (const block of blocks) {
        if (block?.type === 'text') {
          pieces.push(block.text || '');
        } else if (block?.type === 'tool_result') {
          pieces.push(extractAnthropicText(block.content));
        } else if (block?.type === 'image') {
          pieces.push('[image]');
        }
      }
      pushIfAny('user', pieces.join('\n'));
      continue;
    }

    if (role === 'assistant') {
      const pieces = [];
      for (const block of blocks) {
        if (block?.type === 'text') {
          pieces.push(block.text || '');
        } else if (block?.type === 'tool_use') {
          const inputStr = block.input !== undefined
            ? JSON.stringify(block.input)
            : '';
          pieces.push(`tool:${block.name || ''}:${inputStr}`);
        } else if (block?.type === 'image') {
          pieces.push('[image]');
        }
      }
      pushIfAny('assistant', pieces.join('\n'));
      continue;
    }

    if (role === 'system') {
      pushIfAny('system', extractAnthropicText(blocks));
    }
  }

  return result;
};

interface AnthropicRouteDeps {
  generateAssistantResponse: (body: any, callback: (data: any) => void) => Promise<void>;
  generateAnthropicRequestBody: (messages: any[], system: any, model: string, params: any, tools: any[], apiKey?: string) => any;
  countTokensSafe: (messages: any[], model?: string) => { tokens: number; model: string; fallback: boolean };
  countJsonTokensSafe: (value: any) => number;
  safeJsonParse: (value: any, fallback?: any, options?: any) => any;
  logger: any;
}

function registerAnthropicRoutes(app: Application, deps: AnthropicRouteDeps): void {
  const {
    generateAssistantResponse,
    generateAnthropicRequestBody,
    countTokensSafe,
    countJsonTokensSafe,
    safeJsonParse,
    logger
  } = deps;

  const router = express.Router();

  router.post('/messages', async (req: Request, res: Response) => {
    const { messages, model, system, stream = true, tools = [], ...params } = req.body || {};

    if (!messages || !Array.isArray(messages) || !model) {
      return res.status(400).json({ error: 'messages 和 model 为必填字段' });
    }

    try {
      const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
      const authHeader = req.headers.authorization;
      const apiKey = apiKeyHeader || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);

      const requestBody = generateAnthropicRequestBody(messages, system, model, params, tools, apiKey);
      const tokenMessages = anthropicToTokenMessages(messages, system);
      const chatUsage = countTokensSafe(tokenMessages, model);
      const toolUsageTokens = tools?.length ? countJsonTokensSafe(tools) : 0;
      let usage: any = {
        input_tokens: chatUsage.tokens + toolUsageTokens,
        output_tokens: null,
        fallback: chatUsage.fallback
      };

      if (stream !== false) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const id = `msg_${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let contentStarted = false;
        let accumulated = '';
        let toolCalls: any[] = [];
        let parseError: any = null;

        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage
          },
          usage
        })}\n\n`);

        await generateAssistantResponse(requestBody, (data) => {
          if (data.type === 'text') {
            if (!contentStarted) {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
              })}\n\n`);
              contentStarted = true;
            }
            accumulated += data.content;
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: data.content }
            })}\n\n`);
          } else if (data.type === 'tool_calls') {
            toolCalls = data.tool_calls || [];
            toolCalls.forEach((tool, idx) => {
              let parsedInput;
              try {
                parsedInput = safeJsonParse(
                  tool.function?.arguments,
                  {},
                  { strict: true, field: 'tool_use.input' }
                );
              } catch (err) {
                parseError = err;
                return;
              }
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: idx + 1,
                content_block: {
                  type: 'tool_use',
                  id: tool.id,
                  name: tool.function?.name,
                  input: parsedInput
                }
              })}\n\n`);
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: idx + 1
              })}\n\n`);
            });
          }
        });

        if (parseError) {
          if (!res.headersSent) {
            return res.status(400).json({ error: parseError.message });
          }
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: parseError.message
          })}\n\n`);
          return res.end();
        }

        if (contentStarted) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0
          })}\n\n`);
        }

        const outputUsage = countTokensSafe([{
          role: 'assistant',
          content: accumulated,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        }], model);
        usage = {
          input_tokens: usage.input_tokens,
          output_tokens: outputUsage.tokens,
          fallback: usage.fallback || outputUsage.fallback
        };

        let stop_reason = 'end_turn';
        let stop_sequence = null;
        if (toolCalls.length) {
          stop_reason = 'tool_use';
        } else if (params?.stop_sequences?.length && typeof accumulated === 'string') {
          const matched = params.stop_sequences.find((seq: any) => typeof seq === 'string' && accumulated.endsWith(seq));
          if (matched) {
            stop_reason = 'stop_sequence';
            stop_sequence = matched;
          }
        } else if (params?.max_tokens && usage.output_tokens !== null && usage.output_tokens >= params.max_tokens) {
          stop_reason = 'max_tokens';
        }

        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason,
            stop_sequence
          },
          usage
        })}\n\n`);

        res.write(`event: message_stop\ndata: ${JSON.stringify({
          type: 'message_stop',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason,
            stop_sequence
          },
          usage
        })}\n\n`);

        res.end();
      } else {
        let fullContent = '';
        let toolCalls: any[] = [];
        let parseError: any = null;
        await generateAssistantResponse(requestBody, (data) => {
          if (data.type === 'tool_calls') {
            toolCalls = data.tool_calls;
          } else {
            fullContent += data.content;
          }
        });

        const content = [];
        if (fullContent) {
          content.push({ type: 'text', text: fullContent });
        }
        if (toolCalls.length) {
          toolCalls.forEach(tool => {
            let parsedInput;
            try {
              parsedInput = safeJsonParse(
                tool.function?.arguments,
                {},
                { strict: true, field: 'tool_use.input' }
              );
            } catch (err) {
              parseError = err;
              return;
            }
            content.push({
              type: 'tool_use',
              id: tool.id,
              name: tool.function?.name,
              input: parsedInput
            });
          });
        }

        if (parseError) {
          return res.status(400).json({ error: parseError.message });
        }

        const message: any = { role: 'assistant', content: fullContent };
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }

        const outputUsage = countTokensSafe([message], model);
        usage = {
          input_tokens: usage.input_tokens,
          output_tokens: outputUsage.tokens,
          fallback: usage.fallback || outputUsage.fallback
        };

        let stop_reason = 'end_turn';
        let stop_sequence = null;
        if (toolCalls.length) {
          stop_reason = 'tool_use';
        } else if (params?.stop_sequences?.length && typeof fullContent === 'string') {
          const matched = params.stop_sequences.find((seq: any) => typeof seq === 'string' && fullContent.endsWith(seq));
          if (matched) {
            stop_reason = 'stop_sequence';
            stop_sequence = matched;
          }
        } else if (params?.max_tokens && usage.output_tokens !== null && usage.output_tokens >= params.max_tokens) {
          stop_reason = 'max_tokens';
        }

        res.json({
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason,
          stop_sequence,
          usage,
          created_at: Date.now()
        });
      }
    } catch (error: any) {
      logger.error('Anthropic 路由处理失败:', error.message);
      if (!res.headersSent) {
        if (stream !== false) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: error.message
          })}\n\n`);
          res.end();
        } else {
          res.status(500).json({ error: error.message });
        }
      }
    }
  });

  router.post('/messages/count_tokens', (req: Request, res: Response) => {
    const { messages = [], tools = [], system } = req.body || {};
    try {
      const tokenMessages = anthropicToTokenMessages(messages, system);
      const chatResult = countTokensSafe(tokenMessages);
      const toolTokens = tools?.length ? countJsonTokensSafe(tools) : 0;
      const input_tokens = chatResult.tokens + toolTokens;
      res.json({ input_tokens, model: chatResult.model, fallback: chatResult.fallback });
    } catch (error: any) {
      logger.error('count_tokens 计算失败:', error.message);
      res.status(500).json({ error: 'Failed to count tokens' });
    }
  });

  app.use('/anthropic/v1', router);
}

export default registerAnthropicRoutes;
