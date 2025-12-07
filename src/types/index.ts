// ==================== Token 相关类型 ====================

export interface Token {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  timestamp: number;
  enable?: boolean;
  email?: string;
  name?: string;
}

export interface TokenUsageStats {
  requests: number;
  lastUsed: number | null;
}

export interface TokenStats {
  index: number;
  requests: number;
  lastUsed: string | null;
  isCurrent: boolean;
}

export interface UsageStats {
  totalTokens: number;
  currentIndex: number;
  totalRequests: number;
  tokens: TokenStats[];
}

export interface AccountStats {
  total: number;
  enabled: number;
  disabled: number;
}

// ==================== 配置相关类型 ====================

export interface ServerConfig {
  port: number;
  host: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface APIConfig {
  url: string;
  modelsUrl: string;
  host: string;
  userAgent: string;
}

export interface DefaultsConfig {
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
}

export interface SecurityConfig {
  maxRequestSize: string;
  apiKey: string;
  adminPassword: string;
}

export interface Config {
  server: ServerConfig;
  oauth: OAuthConfig;
  api: APIConfig;
  defaults: DefaultsConfig;
  security: SecurityConfig;
  systemInstruction: string;
}

// ==================== OpenAI 消息格式 ====================

export interface OpenAITextContent {
  type: 'text';
  text: string;
}

export interface OpenAIImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type OpenAIMessageContent = string | (OpenAITextContent | OpenAIImageContent)[];

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAIMessageContent;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: 'function';
  function: OpenAIFunctionDeclaration;
}

// ==================== Antigravity 消息格式 ====================

export interface AntigravityTextPart {
  text: string;
  thought_signature?: string;
}

export interface AntigravityInlineData {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface AntigravityFunctionCall {
  functionCall: {
    id: string;
    name: string;
    args: {
      query: string | Record<string, unknown>;
    };
  };
}

export interface AntigravityFunctionResponse {
  functionResponse: {
    id: string;
    name: string;
    response: {
      output: string;
    };
  };
}

export type AntigravityPart = 
  | AntigravityTextPart 
  | AntigravityInlineData 
  | AntigravityFunctionCall 
  | AntigravityFunctionResponse;

export interface AntigravityMessage {
  role: 'user' | 'model';
  parts: AntigravityPart[];
}

export interface AntigravityFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AntigravityTool {
  functionDeclarations: AntigravityFunctionDeclaration[];
}

// ==================== Anthropic 消息格式 ====================

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type?: string;
    mime_type?: string;
    data?: string;
    data64?: string;
    base64?: string;
    value?: string;
  };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  id?: string;
  name?: string;
  content: string | AnthropicTextBlock[];
}

export type AnthropicContentBlock = 
  | AnthropicTextBlock 
  | AnthropicImageBlock 
  | AnthropicToolUseBlock 
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

// ==================== 生成配置 ====================

export interface ThinkingConfig {
  includeThoughts: boolean;
  thinkingBudget: number;
}

export interface GenerationConfig {
  topP?: number;
  topK?: number;
  temperature: number;
  candidateCount: number;
  maxOutputTokens: number;
  stopSequences: string[];
  thinkingConfig?: ThinkingConfig;
}

export interface ToolConfig {
  functionCallingConfig: {
    mode: string;
  };
}

// ==================== 请求体 ====================

export interface AntigravityRequestBody {
  project: string;
  requestId: string;
  request: {
    contents: AntigravityMessage[];
    systemInstruction: {
      role: 'user';
      parts: AntigravityTextPart[];
    };
    tools: AntigravityTool[];
    toolConfig: ToolConfig;
    generationConfig: GenerationConfig;
    sessionId: string;
  };
  model: string;
  userAgent: string;
}

// ==================== 响应相关 ====================

export interface StreamCallbackData {
  type?: 'tool_calls' | 'content';
  content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  fallback?: boolean;
}

export interface TokenCountResult {
  tokens: number;
  model: string;
  fallback: boolean;
}

// ==================== 辅助类型 ====================

export interface ExtractedContent {
  text: string;
  images: AntigravityInlineData[];
}

export interface CachedIds {
  projectId: string;
  projectExpiry: number;
  sessionId: string;
  sessionExpiry: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface GoogleUserInfo {
  email: string;
  name: string;
}

export interface LoginResult {
  success: boolean;
  authUrl?: string;
  message: string;
}

export interface ImportResult {
  success: boolean;
  count: number;
  total: number;
  skipped: number;
  message: string;
}

// ==================== 错误类型 ====================

export interface APIError {
  statusCode: number;
  message: string;
}

// ==================== 参数类型 ====================

export interface GenerationParameters {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
}

export interface ChatCompletionRequest {
  messages: OpenAIMessage[];
  model: string;
  stream?: boolean;
  tools?: OpenAITool[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
}

export interface AnthropicCompletionRequest {
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  model: string;
  stream?: boolean;
  tools?: AnthropicTool[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
}