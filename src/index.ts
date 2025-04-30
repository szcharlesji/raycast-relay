import { v4 as uuidv4 } from "uuid";
import type {
  ModelInfo,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
  RaycastChatRequest,
  RaycastMessage,
  RaycastModelsApiResponse,
  RaycastRawModelData,
  RaycastSSEData,
} from "./types";

// Configuration Constants
const RAYCAST_API_URL =
  "https://backend.raycast.com/api/v1/ai/chat_completions";
const RAYCAST_MODELS_URL = "https://backend.raycast.com/api/v1/ai/models";
const USER_AGENT = "Raycast/1.94.2 (macOS Version 15.3.2 (Build 24D81))";
const DEFAULT_MODEL_ID = "openai-gpt-4o-mini";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_INTERNAL_MODEL = "gpt-4o-mini";

// Environment variables interface
export interface Env {
  RAYCAST_BEARER_TOKEN: string;
  API_KEY?: string;
  ADVANCED?: string; // 'false' filters premium models
  INCLUDE_DEPRECATED?: string; // 'false' filters deprecated models
}

/**
 * Fetches and filters models from Raycast API based on ENV flags.
 */
async function fetchModels(env: Env): Promise<Map<string, ModelInfo>> {
  try {
    const response = await fetch(RAYCAST_MODELS_URL, {
      method: "GET",
      headers: getRaycastHeaders(env),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Raycast API error (${response.status}): ${errorText}`);
      throw new Error(`Raycast API error: ${response.status}`);
    }

    const parsedResponse = (await response.json()) as RaycastModelsApiResponse;
    if (!parsedResponse?.models) {
      console.error(
        "Invalid Raycast models API response structure:",
        parsedResponse,
      );
      throw new Error("Invalid response structure from Raycast API");
    }

    const models = new Map<string, ModelInfo>();
    const showAdvanced = env.ADVANCED?.toLowerCase() !== "false";
    const includeDeprecated = env.INCLUDE_DEPRECATED?.toLowerCase() !== "false";

    console.log(
      `Filtering flags: showAdvanced=${showAdvanced}, includeDeprecated=${includeDeprecated}`,
    );

    // Use RaycastRawModelData type here
    for (const modelData of parsedResponse.models as RaycastRawModelData[]) {
      const isPremium = modelData.requires_better_ai;
      const isDeprecated = modelData.availability === "deprecated";

      if (
        (showAdvanced || !isPremium) &&
        (includeDeprecated || !isDeprecated)
      ) {
        models.set(modelData.id, {
          provider: modelData.provider,
          model: modelData.model, // Internal Raycast model name
        });
      } else {
        console.log(
          `Filtering out model: ${modelData.id} (Premium: ${isPremium}, Deprecated: ${isDeprecated})`,
        );
      }
    }

    console.log(`Fetched and filtered ${models.size} models.`);
    if (models.size === 0)
      console.warn("Warning: No models available after filtering.");
    return models;
  } catch (error) {
    console.error("Error fetching or processing models:", error);
    return new Map(); // Return empty map on error
  }
}

/**
 * Generates standard headers for Raycast API requests.
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
 * Validates the Authorization Bearer token against the API_KEY secret.
 */
function validateApiKey(req: Request, env: Env): boolean {
  if (!env.API_KEY) return true; // No key set, validation passes
  const authHeader = req.headers.get("Authorization");
  const providedKey = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;
  return providedKey === env.API_KEY;
}

/**
 * Retrieves provider and internal model name for a given OpenAI-compatible model ID.
 */
function getProviderInfo(
  modelId: string,
  models: Map<string, ModelInfo>,
): ModelInfo {
  const info = models.get(modelId);
  if (info) return info;

  console.warn(`Model ID "${modelId}" not found. Falling back to defaults.`);
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_INTERNAL_MODEL };
}

/**
 * Converts OpenAI message format to Raycast format, extracting the first system message.
 */
function convertMessages(openaiMessages: OpenAIMessage[]): {
  raycastMessages: RaycastMessage[];
  systemInstruction: string;
} {
  let systemInstruction = "markdown"; // Default
  const raycastMessages: RaycastMessage[] = [];

  openaiMessages.forEach((msg, index) => {
    if (msg.role === "system" && index === 0) {
      systemInstruction = msg.content;
    } else if (msg.role === "user" || msg.role === "assistant") {
      raycastMessages.push({
        author: msg.role,
        content: { text: msg.content },
      });
    }
    // Ignore other roles or subsequent system messages for now
  });

  return { raycastMessages, systemInstruction };
}

/**
 * Parses Raycast SSE stream text into a single concatenated string.
 */
function parseSSEResponse(responseText: string): string {
  let fullText = "";
  for (const line of responseText.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        const jsonData: RaycastSSEData = JSON.parse(line.substring(5).trim());
        if (jsonData.text) fullText += jsonData.text;
      } catch (e) {
        console.error("Failed to parse SSE data line:", line, "Error:", e);
      }
    }
  }
  return fullText;
}

/**
 * Handles the /v1/chat/completions endpoint.
 */
async function handleChatCompletions(
  req: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = (await req.json()) as OpenAIChatRequest;
    const {
      messages,
      model: requestedModelId = DEFAULT_MODEL_ID,
      temperature = 0.5,
      stream = false,
    } = body;

    if (!messages?.length) {
      return errorResponse(
        "Missing or invalid 'messages' field",
        400,
        "invalid_request_error",
      );
    }

    const models = await fetchModels(env);
    if (models.size === 0) {
      return errorResponse(
        "No models available. Check server configuration.",
        500,
        "server_error",
      );
    }

    const { provider, model: internalModelName } = getProviderInfo(
      requestedModelId,
      models,
    );
    if (!models.has(requestedModelId)) {
      console.warn(
        `Requested model "${requestedModelId}" unavailable/filtered. Using default: ${DEFAULT_MODEL_ID}`,
      );

      return errorResponse(
        `Model "${requestedModelId}" not available. Using default: ${DEFAULT_MODEL_ID}`,
        400,
        "invalid_request_error",
      );
    }

    console.log(
      `Relaying request for ${requestedModelId} to Raycast ${provider}/${internalModelName}`,
    );

    const { raycastMessages, systemInstruction } = convertMessages(messages);

    const raycastRequest: RaycastChatRequest = {
      model: internalModelName,
      provider,
      messages: raycastMessages,
      system_instruction: systemInstruction,
      temperature,
      additional_system_instructions: "",
      debug: false,
      locale: "en-US",
      source: "ai_chat",
      thread_id: uuidv4(),
      tools: [],
    };

    const raycastResponse = await fetch(RAYCAST_API_URL, {
      method: "POST",
      headers: getRaycastHeaders(env),
      body: JSON.stringify(raycastRequest),
    });

    console.log(`Raycast API response status: ${raycastResponse.status}`);

    if (!raycastResponse.ok) {
      const errorText = await raycastResponse.text();
      console.error(`Raycast API error response body: ${errorText}`);
      // Avoid leaking Raycast internal errors directly to the client
      return errorResponse(
        `Raycast API error (${raycastResponse.status})`,
        502,
        "bad_gateway",
      );
    }

    return stream
      ? handleStreamingResponse(raycastResponse, requestedModelId)
      : handleNonStreamingResponse(raycastResponse, requestedModelId);
  } catch (error: any) {
    console.error("Error in handleChatCompletions:", error);
    return errorResponse(
      `Chat completion failed: ${error.message}`,
      500,
      "relay_error",
    );
  }
}

/**
 * Handles streaming responses by converting Raycast SSE to OpenAI chunk format.
 */
function handleStreamingResponse(
  response: Response,
  requestedModelId: string,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Process Raycast SSE stream in the background
  (async () => {
    if (!response.body) {
      console.error("No response body from Raycast for streaming.");
      await writer.close();
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamFinished = false;

    try {
      while (!streamFinished) {
        const { done, value } = await reader.read();
        if (done) {
          streamFinished = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.substring(0, newlineIndex).trim();
          buffer = buffer.substring(newlineIndex + 1);

          if (line.startsWith("data:")) {
            const dataContent = line.substring(5).trim();
            if (dataContent === "[DONE]") continue; // Raycast doesn't use this, but handle defensively

            try {
              const jsonData: RaycastSSEData = JSON.parse(dataContent);
              const chunk = {
                id: `chatcmpl-${uuidv4()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: requestedModelId,
                choices: [
                  {
                    index: 0,
                    delta: { content: jsonData.text || "" },
                    finish_reason:
                      jsonData.finish_reason === undefined
                        ? null
                        : jsonData.finish_reason,
                  },
                ],
              };
              await writer.write(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
              );
              if (
                jsonData.finish_reason !== null &&
                jsonData.finish_reason !== undefined
              ) {
                streamFinished = true; // Raycast signals end with finish_reason
              }
            } catch (e) {
              console.error(
                "Failed to parse/process SSE chunk:",
                dataContent,
                "Error:",
                e,
              );
            }
          }
        }
      }
      // Send the final OpenAI standard [DONE] marker
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (error) {
      console.error("Error processing Raycast stream:", error);
      await writer.abort(error); // Signal error downstream
    } finally {
      await writer.close();
      reader
        .cancel()
        .catch((e) => console.error("Error cancelling reader:", e));
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handles non-streaming responses by parsing the full SSE and formatting as OpenAI response.
 */
async function handleNonStreamingResponse(
  response: Response,
  requestedModelId: string,
): Promise<Response> {
  const responseText = await response.text();
  const fullText = parseSSEResponse(responseText);

  const openaiResponse: OpenAIChatResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullText,
          refusal: null,
          annotations: [],
        },
        logprobs: null,
        finish_reason: "stop", // Assume stop for non-streaming completion
      },
    ],
    // Usage data is unavailable from Raycast SSE
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    service_tier: "default",
    system_fingerprint: null,
  };

  return new Response(JSON.stringify(openaiResponse, null, 2) + "\n", {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handles the /v1/models endpoint.
 */
async function handleModels(env: Env): Promise<Response> {
  try {
    const models = await fetchModels(env);
    const openaiModels = {
      object: "list",
      data: Array.from(models.entries()).map(([id, info]) => ({
        id: id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: info.provider,
      })),
    };
    return new Response(JSON.stringify(openaiModels), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error: any) {
    console.error("Error in handleModels:", error);
    return errorResponse(
      `Failed to fetch models: ${error.message}`,
      500,
      "relay_error",
    );
  }
}

/**
 * Creates a standard JSON error response.
 */
function errorResponse(
  message: string,
  status: number = 500,
  type: string = "relay_error",
): Response {
  return new Response(
    JSON.stringify({ error: { message, type, code: null } }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Handles CORS preflight requests.
 */
function handleOptions(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400", // 24 hours
    },
  });
}

// Main Worker fetch handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Log env status (optional, remove sensitive logs in production)
    console.log(
      `Env Status: API_KEY=${env.API_KEY ? "Set" : "Not Set"}, ADVANCED=${env.ADVANCED ?? "Default(true)"}, INCLUDE_DEPRECATED=${env.INCLUDE_DEPRECATED ?? "Default(true)"}`,
    );

    if (!env.RAYCAST_BEARER_TOKEN) {
      console.error("FATAL: RAYCAST_BEARER_TOKEN is not configured.");
      return errorResponse(
        "Server configuration error: Missing Raycast credentials",
        500,
        "server_error",
      );
    }

    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    if (!validateApiKey(request, env)) {
      console.log(
        `[${new Date().toISOString()}] Failed API Key validation for ${request.method} ${request.url}`,
      );
      return errorResponse(
        "Invalid API key provided.",
        401,
        "authentication_error",
      );
    }

    const url = new URL(request.url);
    console.log(
      `[${new Date().toISOString()}] ${request.method} ${url.pathname}${url.search}`,
    );

    try {
      let response: Response;
      if (
        url.pathname === "/v1/chat/completions" &&
        request.method === "POST"
      ) {
        response = await handleChatCompletions(request, env);
      } else if (url.pathname === "/v1/models" && request.method === "GET") {
        response = await handleModels(env);
      } else if (url.pathname === "/health" && request.method === "GET") {
        response = new Response(JSON.stringify({ status: "ok" }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        response = errorResponse("Not Found", 404, "invalid_request_error");
      }

      // Ensure CORS header is present on final response (most handlers add it already)
      if (!response.headers.has("Access-Control-Allow-Origin")) {
        response.headers.set("Access-Control-Allow-Origin", "*");
      }
      return response;
    } catch (error: any) {
      console.error(`[${new Date().toISOString()}] Unhandled error:`, error);
      return errorResponse(
        "An unexpected internal server error occurred.",
        500,
        "server_error",
      );
    }
  },
} satisfies ExportedHandler<Env>;
