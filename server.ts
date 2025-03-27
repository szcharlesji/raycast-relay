import { serve } from "bun";
import { v4 as uuidv4 } from "uuid";

// Configuration
const PORT = 3000;
const RAYCAST_API_URL =
  "https://backend.raycast.com/api/v1/ai/chat_completions";
const RAYCAST_MODELS_URL = "https://backend.raycast.com/api/v1/ai/models";
const USER_AGENT = "Raycast/1.94.2 (macOS Version 15.3.2 (Build 24D81))";

// Hardcoded credentials
const RAYCAST_BEARER_TOKEN = process.env.RAYCAST_BEARER_TOKEN;
const RAYCAST_SIGNATURE = process.env.RAYCAST_SIGNATURE;

console.log("RAYCAST_BEARER_TOKEN:", RAYCAST_BEARER_TOKEN);
console.log("RAYCAST_SIGNATURE:", RAYCAST_SIGNATURE);

// Raycast headers
const RAYCAST_HEADERS = {
  Host: "backend.raycast.com",
  "X-Raycast-Signature": RAYCAST_SIGNATURE,
  Accept: "application/json",
  "User-Agent": USER_AGENT,
  Authorization: `Bearer ${RAYCAST_BEARER_TOKEN}`,
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
  Connection: "close",
};

// Convert OpenAI messages format to Raycast format
function convertMessages(openaiMessages) {
  return openaiMessages.map((msg) => ({
    author: msg.role === "assistant" ? "assistant" : "user",
    content: {
      text: msg.content,
    },
  }));
}

// Parse SSE response from Raycast
function parseSSEResponse(responseText) {
  const lines = responseText.split("\n\n");
  let fullText = "";

  for (const line of lines) {
    if (line.trim() === "") continue;

    // Extract the JSON data from the SSE format
    const match = line.match(/^data: (.+)$/);
    if (match) {
      try {
        const jsonData = JSON.parse(match[1]);
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

// Handle OpenAI chat completions endpoint with streaming support
async function handleChatCompletions(req) {
  try {
    const body = await req.json();
    const {
      messages,
      model = "claude-3-7-sonnet-latest",
      temperature = 0.5,
      stream = false,
    } = body;

    // Prepare Raycast request
    const raycastRequest = {
      additional_system_instructions: "",
      debug: false,
      locale: "en-US",
      messages: convertMessages(messages),
      model: model,
      provider: "anthropic", // Default to anthropic for claude models
      source: "ai_chat",
      system_instruction: "markdown",
      temperature: temperature,
      thread_id: uuidv4(),
      tools: [
        { name: "web_search", type: "remote_tool" },
        { name: "search_images", type: "remote_tool" },
      ],
    };

    const requestBody = JSON.stringify(raycastRequest);
    console.log("Sending request to Raycast:", requestBody);

    // Make request to Raycast
    const response = await fetch(RAYCAST_API_URL, {
      method: "POST",
      headers: RAYCAST_HEADERS,
      body: requestBody,
    });

    console.log("Response status:", response.status);
    console.log(
      "Response headers:",
      Object.fromEntries(response.headers.entries()),
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Raycast API error: ${response.status} ${errorText}`);
    }

    // Handle streaming response
    if (stream) {
      // Create a ReadableStream that will process the SSE data
      const readableStream = new ReadableStream({
        async start(controller) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });

              // Process any complete SSE messages in the buffer
              const lines = buffer.split("\n\n");
              buffer = lines.pop() || ""; // Keep the last incomplete chunk

              for (const line of lines) {
                if (line.trim() === "") continue;

                const match = line.match(/^data: (.+)$/);
                if (match) {
                  try {
                    const jsonData = JSON.parse(match[1]);

                    // Create an OpenAI-compatible streaming chunk
                    const chunk = {
                      id: `chatcmpl-${uuidv4()}`,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
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

                    // Encode and send the chunk
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

            // Send the final [DONE] marker
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });

      // Return the streaming response
      return new Response(readableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      // For non-streaming, collect the entire response
      const responseText = await response.text();
      console.log("Raw response:", responseText);

      // Parse the SSE format to extract the full text
      const fullText = parseSSEResponse(responseText);

      // Convert to OpenAI format
      const openaiResponse = {
        id: `chatcmpl-${uuidv4()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
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
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: "An error occurred during the request to Raycast",
          type: "relay_error",
          details: error.message,
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// Handle models endpoint
async function handleModels() {
  try {
    // Make request to Raycast models endpoint
    const response = await fetch(RAYCAST_MODELS_URL, {
      method: "GET",
      headers: RAYCAST_HEADERS,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Raycast API error: ${response.status} ${errorText}`);
    }

    const responseText = await response.text();
    if (!responseText || responseText.trim() === "") {
      throw new Error("Empty response from Raycast API");
    }

    let raycastModels;
    try {
      raycastModels = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse JSON response:", e);
      throw new Error(`Failed to parse JSON response: ${e.message}`);
    }

    // Convert Raycast models to OpenAI format
    const openaiModels = {
      object: "list",
      data: raycastModels.models.map((model) => ({
        id: model.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: model.provider_name,
      })),
    };

    return new Response(JSON.stringify(openaiModels), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching models:", error);
    return new Response(
      JSON.stringify({
        error: {
          message: "An error occurred while fetching models",
          type: "relay_error",
          details: error.message,
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// Create the server
serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    console.log(`${req.method} ${url.pathname}`);

    // Route requests
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req);
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      return handleModels();
    }

    // Handle unknown routes
    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `Raycast to OpenAI relay server running on http://localhost:${PORT}`,
);
console.log(
  `Use this as your OpenAI API base URL: http://localhost:${PORT}/v1`,
);
