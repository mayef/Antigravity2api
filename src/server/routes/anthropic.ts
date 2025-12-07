import express, { Request, Response, Application } from 'express';
import type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  GenerationParameters,
  StreamCallbackData,
  TokenCountResult,
  AntigravityRequestBody,
  OpenAIToolCall,
  OpenAIMessage
} from '../../types/index.js';

interface Logger {
  error: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface SafeJsonParseOptions {
  strict?: boolean;
  field?: string;
}

const extractAnthropicText = (content: string | AnthropicContentBlock[] | AnthropicContentBlock | null | undefined): string => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && 'text' in block && block.text) return block.text;
        if (typeof block === 'object' && 'content' in block && block.content) return extractAnthropicText(block.content);
        return '';
      })
      .join('');
  }
  if (typeof content === 'object') {
    if ('text' in content && content.text) return content.text;
    if ('content' in content && content.content) return extractAnthropicText(content.content);
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return String(content);
};

const anthropicToTokenMessages = (messages: AnthropicMessage[] = [], system?: string | AnthropicContentBlock[]): Array<{ role: string; content: string }> => {
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
        if (block.type === 'text') {
          pieces.push(block.text || '');
        } else if (block.type === 'tool_result') {
          pieces.push(extractAnthropicText((block as AnthropicToolResultBlock).content));
        } else if (block.type === 'image') {
          pieces.push('[image]');
        }
      }
      pushIfAny('user', pieces.join('\n'));
      continue;
    }

    if (role === 'assistant') {
      const pieces = [];
      for (const block of blocks) {
        if (block.type === 'text') {
          pieces.push(block.text || '');
        } else if (block.type === 'tool_use') {
          const toolBlock = block as AnthropicToolUseBlock;
          const inputStr = toolBlock.input !== undefined
            ? JSON.stringify(toolBlock.input)
            : '';
          pieces.push(`tool:${toolBlock.name || ''}:${inputStr}`);
        } else if (block.type === 'image') {
          pieces.push('[image]');
        }
      }
      pushIfAny('assistant', pieces.join('\n'));
      continue;
    }

    if (role === 'system') {
      pushIfAny('system', extractAnthropicText(blocks as AnthropicContentBlock[]));
    }
  }

  return result;
};

interface AnthropicRouteDeps {
  generateAssistantResponse: (body: AntigravityRequestBody, callback: (data: StreamCallbackData) => void) => Promise<void>;
  generateAnthropicRequestBody: (messages: AnthropicMessage[], system: string | AnthropicContentBlock[] | undefined, model: string, params: GenerationParameters, tools: AnthropicTool[], apiKey?: string) => AntigravityRequestBody;
  countTokensSafe: (messages: OpenAIMessage[], model?: string) => TokenCountResult;
  countJsonTokensSafe: (value: unknown) => number;
  safeJsonParse: (value: string, fallback?: unknown, options?: SafeJsonParseOptions) => unknown;
  logger: Logger;
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

  router.post('/messages', async (req: Request, res: Response): Promise<any> => {
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
      const chatUsage = countTokensSafe(tokenMessages as OpenAIMessage[], model);
      const toolUsageTokens = tools?.length ? countJsonTokensSafe(tools) : 0;
      
      interface AnthropicUsage {
        input_tokens: number;
        output_tokens: number | null;
        fallback?: boolean;
      }
      
      let usage: AnthropicUsage = {
        input_tokens: chatUsage.tokens + toolUsageTokens,
        output_tokens: null,
        fallback: chatUsage.fallback
      };

      if (stream !== false) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const id = `msg_${Date.now()}`;
        let contentStarted = false;
        let accumulated = '';
        let toolCalls: OpenAIToolCall[] = [];
        let parseError: Error | undefined = undefined;

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

        await generateAssistantResponse(requestBody, (data: StreamCallbackData) => {
          if (data.content) {
            if (!contentStarted) {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
              })}\n\n`);
              contentStarted = true;
            }
            accumulated += data.content || '';
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: data.content }
            })}\n\n`);
          } else if (data.type === 'tool_calls' && data.tool_calls) {
            toolCalls = data.tool_calls;
            toolCalls.forEach((tool, idx) => {
              let parsedInput;
              try {
                parsedInput = safeJsonParse(
                  tool.function?.arguments || '{}',
                  {},
                  { strict: true, field: 'tool_use.input' }
                );
              } catch (err) {
                parseError = err as Error;
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
          const err = parseError as Error;
          if (!res.headersSent) {
            return res.status(400).json({ error: err.message || 'Parse error' });
          }
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: err.message || 'Parse error'
          })}\n\n`);
          return res.end();
        }

        if (contentStarted) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0
          })}\n\n`);
        }

        const outputMessage: OpenAIMessage = {
          role: 'assistant',
          content: accumulated,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        };
        const outputUsage = countTokensSafe([outputMessage], model);
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
          const matched = (params.stop_sequences as string[]).find((seq: string) => typeof seq === 'string' && accumulated.endsWith(seq));
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
        let toolCalls: OpenAIToolCall[] = [];
        let parseError: Error | undefined = undefined;
        await generateAssistantResponse(requestBody, (data: StreamCallbackData) => {
          if (data.type === 'tool_calls' && data.tool_calls) {
            toolCalls = data.tool_calls;
          } else if (data.content) {
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
                tool.function?.arguments || '{}',
                {},
                { strict: true, field: 'tool_use.input' }
              );
            } catch (err) {
              parseError = err as Error;
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
          const err = parseError as Error;
          return res.status(400).json({ error: err.message || 'Parse error' });
        }

        const message: OpenAIMessage = {
          role: 'assistant',
          content: fullContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        };

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
          const matched = (params.stop_sequences as string[]).find((seq: string) => typeof seq === 'string' && fullContent.endsWith(seq));
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
    } catch (error) {
      const err = error as Error;
      logger.error('Anthropic 路由处理失败:', err.message);
      if (!res.headersSent) {
        if (stream !== false) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: err.message
          })}\n\n`);
          res.end();
        } else {
          res.status(500).json({ error: err.message });
        }
      }
    }
  });

  router.post('/messages/count_tokens', (req: Request, res: Response) => {
    const { messages = [], tools = [], system } = req.body || {};
    try {
      const tokenMessages = anthropicToTokenMessages(messages, system);
      const chatResult = countTokensSafe(tokenMessages as OpenAIMessage[]);
      const toolTokens = tools?.length ? countJsonTokensSafe(tools) : 0;
      const input_tokens = chatResult.tokens + toolTokens;
      res.json({ input_tokens, model: chatResult.model, fallback: chatResult.fallback });
    } catch (error) {
      const err = error as Error;
      logger.error('count_tokens 计算失败:', err.message);
      res.status(500).json({ error: 'Failed to count tokens' });
    }
  });

  app.use('/anthropic/v1', router);
}

export default registerAnthropicRoutes;
