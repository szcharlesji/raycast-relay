// src/index.ts
import { v4 as uuidv4 } from "uuid";
import type {
  OpenAIMessage,
  RaycastMessage,
  RaycastSSEData,
  OpenAIChatRequest,
  RaycastChatRequest,
  OpenAIChatResponse,
  ModelInfo, // Use the updated type name
  RaycastModelsApiResponse, // Use the new API response type
  // RaycastRawModelData, // Use the raw model data type
} from "./types";

// Configuration
const RAYCAST_API_URL =
  "https://backend.raycast.com/api/v1/ai/chat_completions";
const RAYCAST_MODELS_URL = "https://backend.raycast.com/api/v1/ai/models";
const USER_AGENT = "Raycast/1.94.2 (macOS Version 15.3.2 (Build 24D81))"; // Consider updating this if needed
const DEFAULT_MODEL_ID = "openai-gpt-4o-mini"; // Use the ID field as the default identifier
const DEFAULT_PROVIDER = "openai"; // Default provider if lookup fails
const DEFAULT_INTERNAL_MODEL = "gpt-4o-mini"; // Default internal model name if lookup fails

/**
 * Environment variables interface for Cloudflare Workers
 */
export interface Env {
  RAYCAST_BEARER_TOKEN: string;
  API_KEY?: string;
  ADVANCED?: string; // Add the new ADVANCED flag (string from secrets)
}

/**
 * Fetches model information from Raycast API and filters based on ADVANCED flag
 * @returns Promise with a map of available models (key: model ID, value: { provider, model })
 */
async function fetchModels(env: Env): Promise<Map<string, ModelInfo>> {
  try {
    console.log("Fetching models from Raycast API...");

    const response = await fetch(RAYCAST_MODELS_URL, {
      method: "GET",
      headers: getRaycastHeaders(env),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Raycast API error response: ${errorText}`);
      throw new Error(`Raycast API error: ${response.status} ${errorText}`);
    }

    const responseText = await response.text();
    if (!responseText || responseText.trim() === "") {
      console.error("Empty response received from Raycast models API.");
      throw new Error("Empty response from Raycast API");
    }

    let parsedResponse: RaycastModelsApiResponse;
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse Raycast models API response:", e);
      console.error("Raw response text:", responseText);
      throw new Error("Failed to parse JSON response from Raycast API");
    }

    if (!parsedResponse || !Array.isArray(parsedResponse.models)) {
      console.error(
        "Invalid structure in Raycast models API response:",
        parsedResponse,
      );
      throw new Error("Invalid response structure from Raycast API");
    }

    const models = new Map<string, ModelInfo>();
    // Determine if advanced models should be shown. Default to true if ADVANCED is not 'false'.
    const showAdvanced = env.ADVANCED?.toLowerCase() !== "false";
    console.log(
      `ADVANCED flag set to: ${env.ADVANCED}, showAdvanced: ${showAdvanced}`,
    );

    for (const modelData of parsedResponse.models) {
      // Filter based on the ADVANCED flag and requires_better_ai field
      if (showAdvanced || !modelData.requires_better_ai) {
        // Use modelData.id as the key for the map (OpenAI compatible ID)
        // Store provider and modelData.model (internal Raycast name)
        models.set(modelData.id, {
          provider: modelData.provider,
          model: modelData.model, // Store the internal model name
        });
      } else {
        console.log(
          `Filtering out premium model: ${modelData.id} (requires_better_ai: true)`,
        );
      }
    }

    console.log(`Fetched and filtered ${models.size} models from Raycast API`);
    if (models.size === 0) {
      console.warn(
        "Warning: No models available after filtering. Check ADVANCED flag and API response.",
      );
    }
    return models;
  } catch (error) {
    console.error("Error fetching or processing models:", error);
    // Return empty map on error, will use defaults
    return new Map();
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
    Connection: "close", // Consider 'keep-alive' if making frequent requests, but 'close' is safer for Workers
  };
}

/**
 * Validate API key from request
 */
function validateApiKey(req: Request, env: Env): boolean {
  if (!env.API_KEY) return true; // If no API key is set, allow all requests

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const providedKey = authHeader.substring(7); // Extract key after "Bearer "
  return providedKey === env.API_KEY;
}

/**
 * Get provider info and internal model name for a given model ID
 * @param modelId The model ID from the OpenAI request (e.g., "openai-gpt-4o-mini")
 * @param models Map of available models
 * @returns Object with provider and the internal modelName Raycast expects
 */
function getProviderInfo(
  modelId: string,
  models: Map<string, ModelInfo>,
): { provider: string; modelName: string } {
  const modelInfo = models.get(modelId);

  if (modelInfo) {
    return {
      provider: modelInfo.provider,
      modelName: modelInfo.model, // Return the internal model name
    };
  } else {
    // Fallback to defaults if modelId not found (e.g., after filtering)
    console.warn(
      `Model ID "${modelId}" not found in available models. Falling back to defaults.`,
    );
    return {
      provider: DEFAULT_PROVIDER,
      modelName: DEFAULT_INTERNAL_MODEL,
    };
  }
}

/**
 * Convert OpenAI messages format to Raycast format
 */
function convertMessages(openaiMessages: OpenAIMessage[]): RaycastMessage[] {
  // Filter out system messages if the first message is a system message,
  // as Raycast uses a dedicated field for system instructions.
  // Keep system messages if they appear later in the conversation.
  let systemInstruction = "markdown"; // Default system instruction
  const filteredMessages = openaiMessages.filter((msg, index) => {
    if (msg.role === "system" && index === 0) {
      systemInstruction = msg.content; // Use the content of the first system message
      return false; // Exclude it from the main messages array
    }
    return true;
  });

  return filteredMessages.map((msg) => ({
    // Map 'user' to 'user', 'assistant' to 'assistant'. Handle other roles if necessary.
    author: msg.role === "assistant" ? "assistant" : "user",
    content: {
      text: msg.content,
    },
  }));
}

/**
 * Parse SSE response from Raycast into a single text
 */
function parseSSEResponse(responseText: string): string {
  const lines = responseText.split("\n");
  let fullText = "";
  let finishReason: string | null = null; // Store finish reason if available

  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.startsWith("data:")) {
      try {
        const jsonData: RaycastSSEData = JSON.parse(line.substring(5).trim());
        if (jsonData.text) {
          fullText += jsonData.text;
        }
        // Capture the finish reason from the last relevant data chunk
        if (jsonData.finish_reason !== undefined) {
          finishReason = jsonData.finish_reason;
        }
      } catch (e) {
        console.error("Failed to parse SSE data line:", line, "Error:", e);
      }
    }
  }

  // Note: finish_reason is parsed but not currently used in the non-streaming response object structure.
  // It could be added to the OpenAIChatResponse if needed.
  return fullText;
}

/**
 * Handle OpenAI chat completions endpoint
 */
async function handleChatCompletions(
  req: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = (await req.json()) as OpenAIChatRequest;
    const {
      messages,
      model: requestedModelId = DEFAULT_MODEL_ID, // Use the ID from the request
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

    // Fetch models directly before each request to ensure freshness and apply filtering
    const models = await fetchModels(env);
    if (models.size === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "No models available. Check server configuration or Raycast API status.",
            type: "server_error",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Get provider info and the correct internal model name using the requestedModelId
    const { provider, modelName } = getProviderInfo(requestedModelId, models);

    console.log(
      `Request for model ID: ${requestedModelId}. Using Raycast provider: ${provider}, internal model: ${modelName}`,
    );

    // Create a unique thread ID for this conversation
    const threadId = uuidv4();

    // Convert messages and extract system instruction
    let systemInstruction = "markdown"; // Default
    const raycastMessages = convertMessages(messages);
    if (messages.length > 0 && messages[0].role === "system") {
      systemInstruction = messages[0].content;
    }

    // Prepare Raycast request
    const raycastRequest: RaycastChatRequest = {
      additional_system_instructions: "", // Or potentially map from later system messages if needed
      debug: false,
      locale: "en-US",
      messages: raycastMessages, // Use the filtered messages
      model: modelName, // Use the internal model name here
      provider: provider,
      source: "ai_chat", // Or determine dynamically if needed
      system_instruction: systemInstruction, // Use extracted or default system instruction
      temperature: temperature,
      thread_id: threadId,
      tools: [
        // Example tools - keep commented unless specifically needed/supported
        // { name: "web_search", type: "remote_tool" },
        // { name: "search_images", type: "remote_tool" },
      ],
    };

    const requestBody = JSON.stringify(raycastRequest);
    console.log("Sending request to Raycast:", requestBody);

    const response = await fetch(RAYCAST_API_URL, {
      method: "POST",
      headers: getRaycastHeaders(env),
      body: requestBody,
    });

    console.log(`Raycast API response status: ${response.status}`);

    if (!response.ok) {
      let errorText = await response.text();
      try {
        // Try to parse error as JSON for better logging
        const errorJson = JSON.parse(errorText);
        errorText = JSON.stringify(errorJson, null, 2); // Pretty print JSON error
      } catch {
        // Keep as text if not parseable
      }
      console.error(`Raycast API error response body: ${errorText}`);
      throw new Error(`Raycast API error: ${response.status}`); // Don't include full body in user-facing error
    }

    // Handle streaming response
    if (stream) {
      // Pass the original requestedModelId to the streaming handler
      return handleStreamingResponse(response, requestedModelId);
    } else {
      // Pass the original requestedModelId to the non-streaming handler
      return handleNonStreamingResponse(response, requestedModelId);
    }
  } catch (error: any) {
    console.error("Error in handleChatCompletions:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: `An error occurred processing the chat completion request: ${error.message}`,
          type: "relay_error",
          // Avoid exposing full stack in production responses
          // details: error.stack,
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
 */
function handleStreamingResponse(
  response: Response,
  requestedModelId: string, // Use the ID requested by the client
): Response {
  const readableStream = new ReadableStream({
    async start(controller) {
      if (!response.body) {
        controller.error(new Error("No response body from Raycast"));
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
            // Process any remaining buffer content if the stream ends unexpectedly
            if (buffer.trim()) {
              console.warn("Stream ended with unprocessed buffer:", buffer);
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process buffer line by line for SSE messages
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.substring(0, newlineIndex).trim();
            buffer = buffer.substring(newlineIndex + 1);

            if (line === "") continue; // Skip empty lines between messages

            if (line.startsWith("data:")) {
              const dataContent = line.substring(5).trim();
              if (dataContent === "[DONE]") {
                // Raycast doesn't use [DONE], but we might encounter it or handle stream end differently
                console.log("Received [DONE] marker (or similar end signal).");
                streamFinished = true;
                break; // Exit inner loop
              }

              try {
                const jsonData: RaycastSSEData = JSON.parse(dataContent);

                // Create OpenAI-compatible streaming chunk
                const chunk = {
                  id: `chatcmpl-${uuidv4()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: requestedModelId, // Use the ID the client requested
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: jsonData.text || "", // Send empty string if no text
                      },
                      finish_reason:
                        jsonData.finish_reason === undefined
                          ? null
                          : jsonData.finish_reason, // Map undefined to null
                    },
                  ],
                };

                // Send the chunk
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(chunk)}\n\n`,
                  ),
                );

                // Check if this chunk indicates the end of the stream
                if (
                  jsonData.finish_reason !== null &&
                  jsonData.finish_reason !== undefined
                ) {
                  console.log(
                    `Stream finished with reason: ${jsonData.finish_reason}`,
                  );
                  streamFinished = true;
                  // break; // Don't break here, let the outer loop check `done`
                }
              } catch (e) {
                console.error(
                  "Failed to parse SSE data JSON:",
                  dataContent,
                  "Error:",
                  e,
                );
                // Decide how to handle parse errors: skip chunk, error stream, etc.
                // For now, just log and continue.
              }
            } else {
              console.warn("Received non-data line in SSE stream:", line);
            }
          } // end while loop for processing lines
        } // end while loop for reading stream

        // Ensure the final OpenAI spec [DONE] marker is sent when the stream truly ends
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        console.error("Error processing Raycast stream:", error);
        controller.error(error);
      } finally {
        // Ensure reader is cancelled if controller closes prematurely or an error occurs
        reader
          .cancel()
          .catch((e) => console.error("Error cancelling reader:", e));
      }
    },
    cancel(reason) {
      console.log("Streaming request cancelled:", reason);
      // Clean up resources if necessary
    },
  });

  // Return streaming response
  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*", // Add CORS header for streaming
    },
  });
}

/**
 * Handle non-streaming response from Raycast
 */
async function handleNonStreamingResponse(
  response: Response,
  requestedModelId: string, // Use the ID requested by the client
): Promise<Response> {
  const responseText = await response.text();
  console.log("Raw non-streaming response from Raycast:", responseText); // Log the raw SSE data

  // Parse the SSE format to extract the full text and finish reason
  const fullText = parseSSEResponse(responseText);
  // Note: parseSSEResponse currently doesn't return finish_reason,
  // but it could be modified if needed. For non-streaming, 'stop' is typical.
  const finishReason = "stop"; // Assume 'stop' for completed non-streaming responses

  // Convert to OpenAI format
  const openaiResponse: OpenAIChatResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModelId, // Use the ID the client requested
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullText,
          refusal: null, // Assuming no refusal info available
          annotations: [], // Assuming no annotation info available
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    // Usage data is not provided by Raycast SSE, so provide dummy values or estimate if possible.
    usage: {
      prompt_tokens: 0, // Placeholder
      completion_tokens: 0, // Placeholder
      total_tokens: 0, // Placeholder
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    service_tier: "default", // Placeholder
    system_fingerprint: null, // Placeholder
  };

  return new Response(JSON.stringify(openaiResponse, null, 2) + "\n", {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // Add CORS header
    },
  });
}

/**
 * Handle models endpoint
 */
async function handleModels(env: Env): Promise<Response> {
  try {
    // Fetch models with filtering based on ADVANCED flag
    const models = await fetchModels(env);

    // Convert models map to OpenAI format list
    const openaiModels = {
      object: "list",
      // Map entries: [id, { provider, model }]
      data: Array.from(models.entries()).map(([id, info]) => ({
        id: id, // Use the map key (the model ID)
        object: "model",
        created: Math.floor(Date.now() / 1000), // Or use a fixed timestamp
        owned_by: info.provider, // Use the provider from the map value
      })),
    };

    return new Response(JSON.stringify(openaiModels), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Add CORS header
      },
    });
  } catch (error: any) {
    console.error("Error in handleModels:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: `An error occurred while fetching models: ${error.message}`,
          type: "relay_error",
          // details: error.stack, // Avoid exposing stack
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
    // Log environment variables status (be careful with logging secrets in production)
    console.log(
      "RAYCAST_BEARER_TOKEN:",
      env.RAYCAST_BEARER_TOKEN ? "Set" : "Not set",
    );
    console.log("API_KEY:", env.API_KEY ? "Set" : "Not set");
    console.log(
      "ADVANCED:",
      env.ADVANCED ? env.ADVANCED : "Not set (defaults to true)",
    );

    // Validate required environment variables
    if (!env.RAYCAST_BEARER_TOKEN) {
      console.error("FATAL: RAYCAST_BEARER_TOKEN is not configured.");
      return new Response(
        JSON.stringify({
          error: {
            message: "Server configuration error: Missing Raycast credentials",
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
    const timestamp = new Date().toISOString();

    // Handle CORS preflight requests globally
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*", // Allow any origin
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization", // Allow necessary headers
          "Access-Control-Max-Age": "86400", // Cache preflight response for 1 day
        },
      });
    }

    // Add CORS headers to all actual responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
    };

    // Validate API key (if set) for non-OPTIONS requests
    if (!validateApiKey(request, env)) {
      console.log(
        `[${timestamp}] Failed API Key validation for ${request.method} ${url.pathname}`,
      );
      return new Response(
        JSON.stringify({
          error: {
            message: "Invalid API key provided.",
            type: "authentication_error",
          },
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Log request after validation
    console.log(
      `[${timestamp}] ${request.method} ${url.pathname}${url.search}`,
    );

    try {
      let response: Response;
      // Route requests
      if (
        url.pathname === "/v1/chat/completions" &&
        request.method === "POST"
      ) {
        response = await handleChatCompletions(request, env);
      } else if (url.pathname === "/v1/models" && request.method === "GET") {
        response = await handleModels(env);
      } else if (url.pathname === "/health" && request.method === "GET") {
        response = new Response(JSON.stringify({ status: "ok" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else {
        // Handle unknown routes
        response = new Response("Not Found", {
          status: 404,
          headers: corsHeaders,
        });
      }

      // Ensure CORS headers are on the final response if not already added by handlers
      // (Most handlers add them now, but this is a fallback)
      Object.entries(corsHeaders).forEach(([key, value]) => {
        if (!response.headers.has(key)) {
          response.headers.set(key, value);
        }
      });
      return response;
    } catch (error: any) {
      console.error(
        `[${timestamp}] Unhandled error processing ${request.method} ${url.pathname}:`,
        error,
      );
      return new Response(
        JSON.stringify({
          error: {
            message: "An unexpected internal server error occurred.",
            type: "server_error",
            // details: error.message, // Avoid exposing internal details
          },
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
