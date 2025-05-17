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
 * Parses Raycast SSE stream text and extracts relevant data.
 */
function parseSSEResponse(responseText: string): {
  fullText: string;
  finishReason: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null;
} {
  let fullText = "";
  let finishReason: string | null = null;
  let toolCalls: Array<{ id: string; name: string; arguments: string }> | null = null;

  const lines = responseText.trim().split("\n");
  for (const line of lines) {
    if (line.startsWith("data:")) {
      try {
        const jsonDataString = line.substring(5).trim();
        if (jsonDataString === "[DONE]") continue;

        const jsonData = JSON.parse(jsonDataString) as RaycastSSEData;

        if (jsonData.text) {
          fullText += jsonData.text;
        }
        if (jsonData.finish_reason !== undefined && jsonData.finish_reason !== null) {
          finishReason = jsonData.finish_reason;
        }
        if (jsonData.finish_reason === "tool_calls" && jsonData.tool_calls && jsonData.tool_calls.length > 0) {
          // Extract final tool_calls structure: {name, arguments, id}
          const parsedToolCalls = jsonData.tool_calls.map(tc => ({
            id: tc.id!,
            name: tc.name || (tc.function && tc.function.name),
            arguments: tc.arguments || (tc.function && tc.function.arguments),
          })).filter(tc => tc.id && tc.name && tc.arguments !== undefined) as Array<{ id: string; name: string; arguments: string }>;

          if (parsedToolCalls.length > 0) {
            toolCalls = parsedToolCalls;
          } else if (jsonData.tool_calls.length > 0) {
             console.warn("Tool calls present in SSE but could not be fully parsed into {id, name, arguments} structure from final message part:", jsonData.tool_calls);
          }
        }
      } catch (e) {
        console.error("Failed to parse SSE data line in parseSSEResponse:", line, "Error:", e);
      }
    }
  }
  return { fullText, finishReason, toolCalls };
}

/**
 * Handles the /v1/chat/completions endpoint.
 */
async function handleChatCompletions(
  req: Request,
  env: Env,
): Promise<Response> {
  try {
    const b = (await req.json());
    console.log(b);

    //const body = (await req.json()) as OpenAIChatRequest;
    const body = b as OpenAIChatRequest;
    const {
      messages,
      tools,
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

    const convertedTools = [];
    if (tools) {
      tools.forEach((tool) => {
        const convertedTool = {function: tool, type: "local_tool"};
        convertedTools.push(convertedTool);
      });
    }

    // const native_tool = {
    //   "function": {
    //     "description": "Gets weather for a specific location.\n\nFormat the weather in a nice and user-friendly way. Add emojis when appropriate. Don't overwhelm the user with detailed information if they don't need it.",
    //     "name": "weather-get-weather",
    //     "parameters": {
    //       "properties": {
    //         "location": {
    //           "description": "Location to get the weather from",
    //           "type": "string"
    //         },
    //         "query": {
    //           "description": "Type of weather query",
    //           "enum": ["current", "hourly", "daily"],
    //           "type": "string"
    //         }
    //       },
    //       "required": ["location", "query"],
    //       "type": "object"
    //     }
    //   },
    //   "type": "local_tool"
    // };
    // convertedTools.push(native_tool);
    
    console.log(`These are the tools:`, convertedTools);

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
      tools: convertedTools,
    };

    if (convertedTools.length > 0) {
      raycastRequest.tool_choice = "auto";
    }

    console.log("Sending to Raycast API:", JSON.stringify(raycastRequest, null, 2)); // Log the request payload

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
    let hasSentRoleAssistant = false; // Track if the initial assistant role has been sent

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
            if (dataContent === "[DONE]") continue;

            try {
              console.log("Received Raycast SSE data chunk:", dataContent); // Log raw Raycast SSE data chunk
              const jsonData: RaycastSSEData = JSON.parse(dataContent);
              const delta: any = {}; // Delta for the current OpenAI chunk

              // Handle role: send 'assistant' role only for the first data-bearing chunk
              if (!hasSentRoleAssistant && (jsonData.text !== undefined || (jsonData.tool_calls && jsonData.tool_calls.length > 0))) {
                delta.role = "assistant";
                hasSentRoleAssistant = true;
              }

              // Handle tool_calls from Raycast SSE
              // Do not process jsonData.tool_calls if finish_reason is 'tool_calls', as that's a final summary, not a delta for streaming.
              if (jsonData.tool_calls && jsonData.tool_calls.length > 0 && jsonData.finish_reason !== "tool_calls") {
                const mappedToolCalls = jsonData.tool_calls.map(tc => {
                  // For streaming, a tool_call delta needs an index and the function object.
                  if (tc.index === undefined || tc.function === undefined) {
                    console.warn("SSE: Skipping tool_call in stream delta due to missing index or function sub-object:", tc);
                    return null;
                  }

                  const toolCallDelta: any = { index: tc.index, type: "function" };
                  if (tc.id && tc.id !== "") toolCallDelta.id = tc.id; // Include ID if Raycast provides it (usually first event for the call)
                  
                  const funcDelta: { name?: string; arguments?: string } = {};
                  let hasFuncDeltaContent = false;

                  if (tc.function.name !== undefined) {
                    funcDelta.name = tc.function.name;
                    hasFuncDeltaContent = true;
                  }
                  if (tc.function.arguments !== undefined) {
                    funcDelta.arguments = tc.function.arguments;
                    hasFuncDeltaContent = true;
                  }

                  if (hasFuncDeltaContent) {
                    toolCallDelta.function = funcDelta;
                  } else if (tc.id && tc.id !== "") {
                    // First event for this tool call (has an ID), ensure function object shell.
                    toolCallDelta.function = {};
                  }
                  return toolCallDelta;
                }).filter(tc => tc !== null);

                if (mappedToolCalls.length > 0) {
                  delta.tool_calls = mappedToolCalls;
                }
              }

              // Handle content: mutually exclusive with tool_calls in the same delta for OpenAI.
              if (delta.tool_calls && delta.tool_calls.length > 0) {
                // If tool_calls are present, content must be null in the first chunk with role,
                // or absent in subsequent chunks.
                if (delta.role) {
                  delta.content = null;
                }
              } else if (jsonData.text !== undefined) {
                // Set content if no tool_calls in this delta.
                // If it's a final message (e.g., finish_reason is set) and text is empty,
                // avoid sending delta.content = "" to make the delta an empty object {}.
                if (jsonData.finish_reason && jsonData.text === "") {
                  // Do not set delta.content if it's a final message with empty text
                } else {
                  delta.content = jsonData.text;
                }
              }

              const finishReasonForChunk = (jsonData.finish_reason === undefined) ? null : jsonData.finish_reason;

              // Send chunk if delta has any properties, or if there's a finish_reason.
              if (Object.keys(delta).length > 0 || finishReasonForChunk !== null) {
                const choice = {
                  index: 0,
                  delta: delta,
                  finish_reason: finishReasonForChunk,
                };
                const chunkPayload = {
                  id: `chatcmpl-${uuidv4()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: requestedModelId,
                  choices: [choice],
                };
                await writer.write(
                  encoder.encode(`data: ${JSON.stringify(chunkPayload)}\n\n`),
                );
              }
              
              if (finishReasonForChunk !== null) {
                streamFinished = true; // Raycast signals end with finish_reason
              }
            } catch (e) {
              console.error("Failed to parse/process SSE chunk:", dataContent, "Error:", e);
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
      reader.cancel().catch((e) => console.error("Error cancelling reader:", e));
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
  const { fullText, finishReason, toolCalls: raycastToolCalls } = parseSSEResponse(responseText);

  console.log(responseText); // Keep original logging

  const message: OpenAIMessage = { // Use OpenAIMessage type
    role: "assistant",
    content: fullText,
    // refusal and annotations are not part of OpenAIMessage by default,
    // but OpenAIChatResponse.choices[].message expects them.
    // We'll add them directly to the choice object later if needed, or adjust types.
    // For now, let's assume OpenAIMessage can be extended or they are added later.
  };

  let finalFinishReason = finishReason || "stop";

  if (finalFinishReason === "tool_calls") {
    message.content = null;
    if (raycastToolCalls && raycastToolCalls.length > 0) {
      message.tool_calls = raycastToolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    } else {
      message.tool_calls = []; // OpenAI expects tool_calls if finish_reason is tool_calls
      console.warn("Finish reason is 'tool_calls' but no tool_calls were parsed. Sending empty tool_calls array.");
    }
  } else if (raycastToolCalls && raycastToolCalls.length > 0) {
      // Tool calls are present, but finish_reason is not "tool_calls".
      // This might be unexpected by the client.
      // Set content to null and include tool_calls.
      message.content = null;
      message.tool_calls = raycastToolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
      console.warn(`Parsed tool_calls but finish_reason is '${finalFinishReason}'. Setting content to null and including tool_calls.`);
  }

  const openaiResponse: OpenAIChatResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModelId,
    choices: [
      {
        index: 0,
        message: {
          ...message, // Spread the prepared message
          // Add fields expected by OpenAIChatResponse.choices[].message if not in OpenAIMessage
          refusal: null, // Example, adjust as per actual OpenAIMessage vs OpenAIChatResponse.choices[].message needs
          annotations: [], // Example
        },
        logprobs: null,
        finish_reason: finalFinishReason,
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
