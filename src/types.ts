export type ModelInfo = {
  provider: string;
  model: string;
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
  [key: string]: any;
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
      refusal: string | null;
      annotations: string[];
    };
    logprobs: string | null;
    finish_reason: string | null;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: {
      cached_tokens: number;
      audio_tokens: number;
    };
    completion_tokens_details: {
      reasoning_tokens: number;
      audio_tokens: number;
      accepted_prediction_tokens: number;
      rejected_prediction_tokens: number;
    };
  };
  service_tier: string;
  system_fingerprint: string;
};
export type RaycastSSEData = {
  text?: string;
  finish_reason?: string | null;
};

export type RaycastRawModelData = {
  id: string;
  model: string;
  name: string;
  provider: string;
  requires_better_ai: boolean;
  availability: string;
  [key: string]: any;
};

export type RaycastModelsApiResponse = {
  models: RaycastRawModelData[];
  default_models: Record<string, string>;
};
