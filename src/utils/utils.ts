import { randomUUID } from 'crypto';
import config from '../config/config.js';
import type {
  OpenAIMessage,
  OpenAIMessageContent,
  OpenAITool,
  OpenAIToolCall,
  AntigravityMessage,
  AntigravityPart,
  AntigravityTool,
  AntigravityTextPart,
  AntigravityInlineData,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  ExtractedContent,
  GenerationConfig,
  GenerationParameters,
  CachedIds,
  AntigravityRequestBody
} from '../types/index.js';

function generateRequestId(): string {
  return `agent-${randomUUID()}`;
}

function generateSessionId(): string {
  return String(-Math.floor(Math.random() * 9e18));
}

function generateProjectId(): string {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}
function extractImagesFromContent(content: OpenAIMessageContent): ExtractedContent {
  const result: ExtractedContent = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted: ExtractedContent, antigravityMessages: AntigravityMessage[]): void {
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleAssistantMessage(message: OpenAIMessage, antigravityMessages: AntigravityMessage[]): void {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;

  let contentText = '';
  if (typeof message.content === 'string') {
    contentText = message.content;
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item.type === 'text') {
        contentText += item.text;
      }
    }
  }

  const hasContent = contentText && contentText.trim() !== '';

  const antigravityTools = hasToolCalls ? message.tool_calls!.map((toolCall: OpenAIToolCall) => ({
    functionCall: {
      id: toolCall.id,
      name: toolCall.function.name,
      args: {
        query: toolCall.function.arguments
      }
    }
  })) : [];

  if (lastMessage?.role === "model" && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...antigravityTools)
  } else {
    const parts = [];
    if (hasContent) {
      let text = contentText;
      let thoughtSignature = null;
      const signatureMatch = text.match(/<!-- thought_signature: (.+?) -->/);
      if (signatureMatch) {
        thoughtSignature = signatureMatch[1];
        text = text.replace(signatureMatch[0], '').trim();
      }

      const part: AntigravityTextPart = { text };
      if (thoughtSignature) {
        part.thought_signature = thoughtSignature;
      }
      parts.push(part);
    }
    parts.push(...antigravityTools);

    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message: OpenAIMessage, antigravityMessages: AntigravityMessage[]): void {
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if ('functionCall' in part && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse: AntigravityPart = {
    functionResponse: {
      id: message.tool_call_id || '',
      name: functionName,
      response: {
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      }
    }
  };

  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some((p: AntigravityPart) => 'functionResponse' in p)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages: OpenAIMessage[]): AntigravityMessage[] {
  const antigravityMessages: AntigravityMessage[] = [];
  for (const message of openaiMessages) {
    if (message.role === "user" || message.role === "system") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }

  return antigravityMessages;
}
function generateGenerationConfig(parameters: GenerationParameters, enableThinking: boolean, actualModelName: string): GenerationConfig {
  const generationConfig: GenerationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ]
  }

  if (enableThinking) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: 1024
    };
  }

  if (enableThinking && actualModelName.includes("claude")) {
    delete generationConfig.topP;
  }
  return generationConfig
}
const MAX_TOOLS = 32;
const MAX_TOOL_SCHEMA_SIZE = 50 * 1024; // 50KB 防止巨型 JSON

function sanitizeTool(tool: OpenAITool): AntigravityTool | null {
  if (!tool || tool.type !== 'function' || !tool.function) return null;
  const { name, description, parameters } = tool.function;
  if (typeof name !== 'string' || !name.trim()) return null;
  const safeDesc = typeof description === 'string' ? description : '';
  const safeParams = parameters && typeof parameters === 'object' ? { ...parameters } : {};
  // 删除可能被滥用的字段
  delete safeParams.$schema;
  delete safeParams.__proto__;
  delete safeParams.prototype;

  const schemaSize = Buffer.byteLength(JSON.stringify(safeParams || {}), 'utf8');
  if (schemaSize > MAX_TOOL_SCHEMA_SIZE) {
    throw new Error('工具参数过大，已拒绝');
  }

  return {
    functionDeclarations: [
      {
        name,
        description: safeDesc,
        parameters: safeParams
      }
    ]
  };
}

function convertOpenAIToolsToAntigravity(openaiTools: OpenAITool[]): AntigravityTool[] {
  if (!openaiTools || openaiTools.length === 0) return [];
  if (!Array.isArray(openaiTools)) {
    throw new Error('tools 必须是数组');
  }
  if (openaiTools.length > MAX_TOOLS) {
    throw new Error(`工具数量过多，最多支持 ${MAX_TOOLS} 个`);
  }
  const sanitized = openaiTools.map(sanitizeTool).filter((tool): tool is AntigravityTool => tool !== null);
  return sanitized;
}
function convertAnthropicToolsToAntigravity(tools: AnthropicTool[] = []): AntigravityTool[] {
  const openaiLikeTools: OpenAITool[] = Array.isArray(tools)
    ? tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool?.name || '',
          description: tool?.description,
          parameters: tool?.input_schema
        }
      }))
    : [];
  return convertOpenAIToolsToAntigravity(openaiLikeTools);
}
const idCache = new Map<string, CachedIds>();
const SESSION_ID_DURATION = 60 * 60 * 1000; // 1 hour
const PROJECT_ID_DURATION = 12 * 60 * 60 * 1000; // 12 hours

function getCachedIds(apiKey: string): CachedIds {
  const now = Date.now();
  let cache = idCache.get(apiKey);

  if (!cache) {
    cache = {
      projectId: generateProjectId(),
      projectExpiry: now + PROJECT_ID_DURATION,
      sessionId: generateSessionId(),
      sessionExpiry: now + SESSION_ID_DURATION
    };
    idCache.set(apiKey, cache);
    return cache;
  }

  if (now > cache.projectExpiry) {
    cache.projectId = generateProjectId();
    cache.projectExpiry = now + PROJECT_ID_DURATION;
  }

  if (now > cache.sessionExpiry) {
    cache.sessionId = generateSessionId();
    cache.sessionExpiry = now + SESSION_ID_DURATION;
  }

  return cache;
}

function generateRequestBody(openaiMessages: OpenAIMessage[], modelName: string, parameters: GenerationParameters, openaiTools: OpenAITool[], apiKey?: string): AntigravityRequestBody {
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName === 'gemini-2.5-pro-image' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
  const actualModelName = (modelName.endsWith('-thinking') && modelName !== 'claude-opus-4-5-thinking') ? modelName.slice(0, -9) : modelName;

  // Use a default key if none provided (though it should be provided by the server)
  const cacheKey = apiKey || 'default';
  const { projectId, sessionId } = getCachedIds(cacheKey);

  return {
    project: projectId,
    requestId: generateRequestId(),
    request: {
      contents: openaiMessageToAntigravity(openaiMessages),
      systemInstruction: {
        role: "user",
        parts: [{ text: config.systemInstruction }]
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  }
}
function extractAnthropicContent(content: string | AnthropicContentBlock[] | AnthropicContentBlock | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if ('text' in item && item.text) return item.text;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object') {
    if ('text' in content && content.text) return content.text;
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}
function anthropicBlockToInlineData(block: AnthropicImageBlock): AntigravityInlineData | null {
  const source = block?.source || {};
  const data = source.data || source.data64 || source.base64 || source.value;
  if (!data) return null;
  const mimeType = source.media_type || source.mime_type || 'image/png';
  return {
    inlineData: {
      mimeType,
      data
    }
  };
}
function anthropicBlockToFunctionResponse(block: AnthropicToolResultBlock): { functionResponse: { id: string; name: string; response: { output: string } } } | null {
  const id = block?.tool_use_id || block?.id;
  const name = block?.name || '';
  const output = extractAnthropicContent(block?.content);
  if (!id) return null;
  return {
    functionResponse: {
      id,
      name,
      response: {
        output
      }
    }
  };
}
function anthropicMessagesToAntigravity(messages: AnthropicMessage[] = [], system?: string | AnthropicContentBlock[]): AntigravityMessage[] {
  const antigravityMessages: AntigravityMessage[] = [];

  const pushUserSystem = (text: string) => {
    if (!text) return;
    antigravityMessages.push({
      role: 'user',
      parts: [{ text }]
    });
  };

  if (system) {
    pushUserSystem(extractAnthropicContent(system));
  }

  for (const message of messages) {
    const role = message?.role;
    const contentBlocks = Array.isArray(message?.content)
      ? message.content
      : message?.content
        ? [{ type: 'text', text: message.content }]
        : [];

    if (role === 'assistant') {
      const parts: AntigravityPart[] = [];
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          parts.push({ text: block.text || '' });
        } else if (block.type === 'tool_use') {
          const toolBlock = block as AnthropicToolUseBlock;
          parts.push({
            functionCall: {
              id: toolBlock.id || `tool_${Date.now()}`,
              name: toolBlock.name,
              args: {
                query: toolBlock.input ?? {}
              }
            }
          });
        } else if (block.type === 'image') {
          const inline = anthropicBlockToInlineData(block as AnthropicImageBlock);
          if (inline) parts.push(inline);
        }
      }
      if (parts.length) {
        antigravityMessages.push({
          role: 'model',
          parts
        });
      }
      continue;
    }

    if (role === 'user') {
      const parts: AntigravityPart[] = [];
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          parts.push({ text: block.text || '' });
        } else if (block.type === 'image') {
          const inline = anthropicBlockToInlineData(block as AnthropicImageBlock);
          if (inline) parts.push(inline);
        } else if (block.type === 'tool_result') {
          const fnResp = anthropicBlockToFunctionResponse(block as AnthropicToolResultBlock);
          if (fnResp) parts.push(fnResp);
        }
      }
      if (parts.length) {
        antigravityMessages.push({
          role: 'user',
          parts
        });
      }
      continue;
    }

    if (role === 'system') {
      pushUserSystem(extractAnthropicContent(contentBlocks as AnthropicContentBlock[]));
    }
  }

  return antigravityMessages;
}
function generateAnthropicRequestBody(messages: AnthropicMessage[], system: string | AnthropicContentBlock[] | undefined, modelName: string, parameters: GenerationParameters, anthropicTools: AnthropicTool[], apiKey?: string): AntigravityRequestBody {
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName === 'gemini-2.5-pro-image' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium";
  const actualModelName = (modelName.endsWith('-thinking') && modelName !== 'claude-opus-4-5-thinking') ? modelName.slice(0, -9) : modelName;

  const cacheKey = apiKey || 'default';
  const { projectId, sessionId } = getCachedIds(cacheKey);
  const contents = anthropicMessagesToAntigravity(messages, system);
  const tools = convertAnthropicToolsToAntigravity(anthropicTools);
  const systemText = extractAnthropicContent(system);

  return {
    project: projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      systemInstruction: {
        role: "user",
        parts: [{
          text: systemText
            ? `${config.systemInstruction}\n${systemText}`
            : config.systemInstruction
        }]
      },
      tools,
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  };
}
export {
  generateRequestId,
  generateSessionId,
  generateProjectId,
  generateRequestBody,
  generateAnthropicRequestBody
}
