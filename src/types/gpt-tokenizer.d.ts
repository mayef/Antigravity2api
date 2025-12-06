declare module 'gpt-tokenizer' {
  export interface Message {
    role: string;
    content: string;
  }

  export function encodeChat(messages: Message[], model?: string): number[];
  export function countTokens(text: string): number;
}