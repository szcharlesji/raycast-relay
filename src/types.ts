export type ModelInfo = {
  provider: string;
  model: string;
};

export type OpenAIMessage = {
  role: "user" | "assistant" | "system" | "tool"; // Added "tool"
  content: string | null; // Allow content to be null for tool_calls
  tool_calls?: Array<{ // Add tool_calls for OpenAI
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  // Fields for role: "tool"
  tool_call_id?: string;
  name?: string; // Function name for role "tool"

  // The following are not standard in OpenAI's base message but might be used in responses
  refusal?: string | null;
  annotations?: string[];
};

// Define how Raycast expects tool calls from an assistant in the request history
export type RaycastAssistantToolCall = {
  id: string;
  name: string; 
  arguments: string;
};

export type RaycastMessage = {
  author: "user" | "assistant";
  content: {
    text: string | null; // Allow text to be null if tool_calls are present
  };
  tool_calls?: RaycastAssistantToolCall[]; // For assistant messages that are tool calls
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
  tools: RaycastTool[]; // Use the new RaycastTool union type
  tool_choice?: string;
};

// Defines the structure of the 'function' part of an OpenAI tool
export type OpenAIFunction = {
  name: string;
  description?: string;
  parameters: object; // Typically a JSON schema object
};

// Defines an OpenAI tool, specifically for functions
export type OpenAITool = {
  type: "function";
  function: OpenAIFunction;
};

// Defines the possible structures for tools in a Raycast request
export type RaycastTool =
  | { name: string; type: "remote_tool" | string } // For named tools like web_search
  | { function: OpenAIFunction; type: "local_tool" }; // For function tools passed by definition

export type OpenAIChatRequest = {
  messages: OpenAIMessage[];
  model: string;
  temperature?: number;
  stream?: boolean;
  tools?: OpenAITool[]; // Explicitly define the tools property
  [key: string]: any; // Keep for other potential fields not strictly typed
};
export type OpenAIChatResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: OpenAIMessage; // Use the updated OpenAIMessage type
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
  tool_calls?: Array<{ // Add tool_calls for Raycast SSE data
    id?: string; // id can be empty in intermediate steps
    index?: number; // index can be present in intermediate steps
    name?: string; // name is present in the final structure
    arguments?: string; // arguments is present in the final structure
    function?: { // function object is present in intermediate steps
      name?: string;
      arguments?: string;
    };
  }>;
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
