type RaycastModelInfo = {
  id: string;
  model: string;
  provider: string;
};
export type RaycastModelsResponse = {
  models: RaycastModelInfo[];
};
export type ModelCacheEntry = {
  model: string;
  provider: string;
};
export type ModelCache = {
  models: Map<string, ModelCacheEntry>;
  lastFetched: number;
};
export type OpenAIMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};
export type RaycastMessage = {
  author: "user" | "assistant";
  content: {
    text: string;
  };
};
export type RaycastChatRequest = {
  additional_system_instructions: string;
  debug: boolean;
  locale: string;
  messages: RaycastMessage[];
  model: string;
  provider: string;
  source: string;
  system_instruction: string;
  temperature: number;
  thread_id: string;
  tools: { name: string; type: string }[];
};
export type OpenAIChatRequest = {
  messages: OpenAIMessage[];
  model: string;
  temperature?: number;
  stream?: boolean;
  [key: string]: any; // For other parameters
};
export type OpenAIChatResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string | null;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};
export type RaycastSSEData = {
  text?: string;
  finish_reason?: string | null;
};
