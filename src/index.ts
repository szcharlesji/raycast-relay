import { v4 as uuidv4 } from "uuid";
import type {
  ModelCache,
  ModelCacheEntry,
  RaycastModelsResponse,
  OpenAIMessage,
  RaycastMessage,
  RaycastSSEData,
  OpenAIChatRequest,
  RaycastChatRequest,
  OpenAIChatResponse,
} from "./types";

// Configuration
const RAYCAST_API_URL =
  "https://backend.raycast.com/api/v1/ai/chat_completions";
const RAYCAST_MODELS_URL = "https://backend.raycast.com/api/v1/ai/models";
const USER_AGENT = "Raycast/1.94.2 (macOS Version 15.3.2 (Build 24D81))";
const DEFAULT_MODEL = "anthropic-claude-3-7-sonnet-latest";
const CACHE_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

// Cache for model mappings
const modelCache: ModelCache = {
  models: new Map<string, ModelCacheEntry>(),
  lastFetched: 0,
};

/**
 * Environment variables interface for Cloudflare Workers
 */
export interface Env {
  RAYCAST_BEARER_TOKEN: string;
  API_KEY?: string;
}

/**
 * Fetches model information from Raycast API and updates the cache
 * @returns Promise<boolean> true if successful, false otherwise
 */
async function fetchAndCacheModels(env: Env): Promise<boolean> {
  try {
    console.log("Fetching models from Raycast API...");

    const response = await fetch(RAYCAST_MODELS_URL, {
      method: "GET",
      headers: getRaycastHeaders(env),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Raycast API error: ${response.status} ${errorText}`);
    }

    const responseText = await response.text();
    if (!responseText || responseText.trim() === "") {
      throw new Error("Empty response from Raycast API");
    }

    let raycastModels: RaycastModelsResponse;
    try {
      raycastModels = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse models response:", e);
      throw new Error(`Failed to parse models response: ${e}`);
    }

    if (!raycastModels.models || !Array.isArray(raycastModels.models)) {
      throw new Error("Invalid models response format from Raycast API");
    }

    // Clear the current cache
    modelCache.models.clear();

    // Populate the cache with model info
    for (const model of raycastModels.models) {
      modelCache.models.set(model.id, {
        provider: model.provider,
        modelName: model.model,
        displayName: model.name,
        ownedBy: model.provider_name,
      });
    }

    modelCache.lastFetched = Date.now();
    console.log(`Cached ${modelCache.models.size} models from Raycast API`);

    return true;
  } catch (error) {
    console.error("Error fetching models:", error);
    return false;
  }
}

/**
 * Get Raycast headers with authentication
 */
function getRaycastHeaders(env: Env) {
  return {
    Host: "backend.raycast.com",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${env.RAYCAST_BEARER_TOKEN}`,
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Connection: "close",
  };
}

/**
 * Validate API key from request
 */
function validateApiKey(req: Request, env: Env): boolean {
  if (!env.API_KEY) return true; // If no API key is set, allow all requests

  const apiKey = req.headers.get("Authorization");
  return apiKey === `Bearer ${env.API_KEY}`;
}

/**
 * Get provider info for a model from the cache
 * @param modelId The model ID to look up
 * @returns Object with provider and modelName
 */
function getProviderInfo(modelId: string): {
  provider: string;
  modelName: string;
} {
  // Get the model info from cache
  const modelInfo = modelCache.models.get(modelId);

  if (modelInfo) {
    return {
      provider: modelInfo.provider,
      modelName: modelInfo.modelName,
    };
  }

  // Default if model not found
  console.warn(
    `Model ${modelId} not found in cache. Defaulting to anthropic provider.`,
  );
  return {
    provider: "anthropic",
    modelName: modelId,
  };
}

/**
 * Convert OpenAI messages format to Raycast format
 * @param openaiMessages Array of OpenAI message objects
 * @returns Array of Raycast message objects
 */
function convertMessages(openaiMessages: OpenAIMessage[]): RaycastMessage[] {
  return openaiMessages.map((msg) => ({
    author: msg.role === "assistant" ? "assistant" : "user",
    content: {
      text: msg.content,
    },
  }));
}

/**
 * Parse SSE response from Raycast into a single text
 * @param responseText The raw SSE response from Raycast
 * @returns The combined text from all SSE chunks
 */
function parseSSEResponse(responseText: string): string {
  const lines = responseText.split("\n");
  let fullText = "";

  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.startsWith("data:")) {
      try {
        const jsonData: RaycastSSEData = JSON.parse(line.substring(5).trim());
        if (jsonData.text) {
          fullText += jsonData.text;
        }
      } catch (e) {
        console.error("Failed to parse SSE data:", e);
      }
    }
  }

  return fullText;
}

/**
 * Handle OpenAI chat completions endpoint
 * @param req The HTTP request
 * @returns HTTP response
 */
async function handleChatCompletions(
  req: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = (await req.json()) as OpenAIChatRequest;
    const {
      messages,
      model = DEFAULT_MODEL,
      temperature = 0.5,
      stream = false,
    } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Missing or invalid 'messages' field",
            type: "invalid_request_error",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Get provider info from the model cache
    const { provider, modelName } = getProviderInfo(model);

    console.log(`Using provider: ${provider}, model: ${modelName}`);

    // Create a unique thread ID for this conversation
    const threadId = uuidv4();

    // Prepare Raycast request
    const raycastRequest: RaycastChatRequest = {
      additional_system_instructions: "",
      debug: false,
      locale: "en-US",
      messages: convertMessages(messages),
      model: modelName,
      provider: provider,
      source: "ai_chat",
      system_instruction: "markdown",
      temperature: temperature,
      thread_id: threadId,
      tools: [
        { name: "web_search", type: "remote_tool" },
        { name: "search_images", type: "remote_tool" },
      ],
    };

    const requestBody = JSON.stringify(raycastRequest);
    console.log("Sending request to Raycast:", requestBody);

    const response = await fetch(RAYCAST_API_URL, {
      method: "POST",
      headers: getRaycastHeaders(env),
      body: requestBody,
    });

    console.log("Response status:", response.status);

    if (!response.ok) {
      let errorText = await response.text();
      try {
        // Try to parse error as JSON
        const errorJson = JSON.parse(errorText);
        errorText = JSON.stringify(errorJson);
      } catch {
        // Keep as text if not parseable
      }
      throw new Error(`Raycast API error: ${response.status} ${errorText}`);
    }

    // Handle streaming response
    if (stream) {
      return handleStreamingResponse(response, model);
    } else {
      return handleNonStreamingResponse(response, model);
    }
  } catch (error: any) {
    console.error("Error in chat completions:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: `An error occurred during the request to Raycast: ${error.message}`,
          type: "relay_error",
          details: error.stack,
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Handle streaming response from Raycast
 * @param response The Raycast API response
 * @param modelId The original model ID requested
 * @returns Streaming response in OpenAI format
 */
function handleStreamingResponse(
  response: Response,
  modelId: string,
): Response {
  // Create a ReadableStream that processes the SSE data
  const readableStream = new ReadableStream({
    async start(controller) {
      if (!response.body) {
        controller.error(new Error("No response body"));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE messages in the buffer
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || ""; // Keep the last incomplete chunk

          for (const line of lines) {
            if (line.trim() === "") continue;

            const match = line.match(/^data: (.+)$/);
            if (match) {
              try {
                const jsonData: RaycastSSEData = JSON.parse(match[1]);

                // Create OpenAI-compatible streaming chunk
                const chunk = {
                  id: `chatcmpl-${uuidv4()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: jsonData.text || "",
                      },
                      finish_reason: jsonData.finish_reason || null,
                    },
                  ],
                };

                // Send the chunk
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(chunk)}\n\n`,
                  ),
                );
              } catch (e) {
                console.error("Failed to parse SSE data:", e);
              }
            }
          }
        }

        // Send final [DONE] marker
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        console.error("Error in streaming response:", error);
        controller.error(error);
      }
    },
  });

  // Return streaming response
  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Handle non-streaming response from Raycast
 * @param response The Raycast API response
 * @param modelId The original model ID requested
 * @returns Response in OpenAI format
 */
async function handleNonStreamingResponse(
  response: Response,
  modelId: string,
): Promise<Response> {
  // Collect the entire response
  const responseText = await response.text();
  console.log("Raw response:", responseText);

  // Parse the SSE format to extract the full text
  const fullText = parseSSEResponse(responseText);

  // Convert to OpenAI format
  const openaiResponse: OpenAIChatResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullText,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(openaiResponse), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle models endpoint
 * @returns HTTP response with available models
 */
async function handleModels(env: Env): Promise<Response> {
  try {
    // Check if we need to refresh the model cache
    if (
      modelCache.models.size === 0 ||
      Date.now() - modelCache.lastFetched > CACHE_REFRESH_INTERVAL
    ) {
      const success = await fetchAndCacheModels(env);
      if (!success) {
        throw new Error("Failed to fetch models from Raycast API");
      }
    }

    // Convert cached models to OpenAI format
    const openaiModels = {
      object: "list",
      data: Array.from(modelCache.models.entries()).map(([id, info]) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: info.ownedBy,
      })),
    };

    return new Response(JSON.stringify(openaiModels), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error in models endpoint:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: `An error occurred while fetching models: ${error.message}`,
          type: "relay_error",
          details: error.stack,
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// Main Worker export
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Log environment variables status
    console.log(
      "RAYCAST_BEARER_TOKEN:",
      env.RAYCAST_BEARER_TOKEN ? "Set" : "Not set",
    );
    console.log("API_KEY:", env.API_KEY ? "Set" : "Not set");

    // Validate required environment variables
    if (!env.RAYCAST_BEARER_TOKEN) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Server configuration error: Missing required credentials",
            type: "server_error",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Validate API key
    if (!validateApiKey(request, env)) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Invalid API key",
            type: "authentication_error",
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Log request
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${request.method} ${url.pathname}`);

    try {
      // Initialize model cache if needed
      if (modelCache.models.size === 0) {
        ctx.waitUntil(fetchAndCacheModels(env));
      }

      // Route requests
      if (
        url.pathname === "/v1/chat/completions" &&
        request.method === "POST"
      ) {
        return await handleChatCompletions(request, env);
      } else if (url.pathname === "/v1/models" && request.method === "GET") {
        return await handleModels(env);
      } else if (url.pathname === "/health" && request.method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Handle unknown routes
      return new Response("Not Found", { status: 404 });
    } catch (error: any) {
      console.error(`[${timestamp}] Unhandled error:`, error);
      return new Response(
        JSON.stringify({
          error: {
            message: "An unexpected error occurred",
            type: "server_error",
            details: error.message,
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
