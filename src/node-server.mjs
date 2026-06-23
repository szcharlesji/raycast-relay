#!/usr/bin/env node
import { createHmac, createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const RAYCAST_CHAT_URL =
  "https://backend.raycast.com/api/v1/ai/chat_completions";
const RAYCAST_MODELS_URL = "https://backend.raycast.com/api/v1/ai/models";
const DEFAULT_MODEL_ID = "openai-gpt-5-mini";
const DEFAULT_USER_AGENT =
  "Raycast/1.104.20 (macOS Version 26.5.1 (Build 25F80))";
const DEFAULT_EXPERIMENTAL = "chatBranching, mcpHTTPServer";

loadDevVars();

function loadDevVars() {
  if (!existsSync(".dev.vars")) return;

  const lines = readFileSync(".dev.vars", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    process.env[key] ||= value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function signingSecret() {
  const value = process.env.SIG_SECRET || process.env.RAYCAST_SIGNATURE_SECRET;
  if (!value) {
    throw new Error(
      "Missing required environment variable: SIG_SECRET",
    );
  }
  return value;
}

function getPort() {
  const portArgIndex = process.argv.indexOf("--port");
  if (portArgIndex >= 0 && process.argv[portArgIndex + 1]) {
    return Number(process.argv[portArgIndex + 1]);
  }

  return Number(process.env.PORT || 8788);
}

function getHost() {
  const hostArgIndex = process.argv.indexOf("--host");
  if (hostArgIndex >= 0 && process.argv[hostArgIndex + 1]) {
    return process.argv[hostArgIndex + 1];
  }

  return process.env.HOST || "0.0.0.0";
}

function rot13rot5(input) {
  return input.replace(/[A-Za-z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    }
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    }
    return String.fromCharCode(((code - 48 + 5) % 10) + 48);
  });
}

function signatureV2(timestamp, deviceId, payload, secret) {
  const bodyHash = createHash("sha256").update(payload).digest("hex");
  const message = [timestamp, deviceId, bodyHash].map(rot13rot5).join(".");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function raycastJwt(aid, secret) {
  const iat = Date.now() / 1000;
  const header = base64UrlJson({ typ: "JWT", alg: "HS256" });
  const payload = base64UrlJson({ aid, exp: iat + 60, iat });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function raycastHeaders(payload) {
  const bearerToken = requiredEnv("RAYCAST_BEARER_TOKEN");
  const deviceId = requiredEnv("RAYCAST_DEVICE_ID");
  const aid = requiredEnv("RAYCAST_AID");
  const secret = signingSecret();
  const timestamp = Math.floor(Date.now() / 1000).toString();

  return {
    Accept: "application/json",
    Authorization: `Bearer ${bearerToken}`,
    "X-Raycast-Timestamp": timestamp,
    "Accept-Language": "en-US,en;q=0.9",
    "X-Raycast-DeviceId": deviceId,
    "Content-Type": "application/json",
    "X-Raycast-Signature-v2": signatureV2(
      timestamp,
      deviceId,
      payload,
      secret,
    ),
    "X-Raycast-Experimental":
      process.env.RAYCAST_EXPERIMENTAL || DEFAULT_EXPERIMENTAL,
    "X-Raycast-Signature": raycastJwt(aid, secret),
    "User-Agent": process.env.RAYCAST_USER_AGENT || DEFAULT_USER_AGENT,
  };
}

function validateApiKey(req) {
  if (!process.env.API_KEY) return true;
  return req.headers.authorization === `Bearer ${process.env.API_KEY}`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function convertMessages(messages) {
  let systemInstruction = "markdown";
  const raycastMessages = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "system" && index === 0) {
      systemInstruction = contentToText(message.content);
      continue;
    }

    if (message.role === "user" || message.role === "assistant") {
      raycastMessages.push({
        author: message.role,
        content: { text: contentToText(message.content) },
      });
    }
  }

  return { raycastMessages, systemInstruction };
}

function inferProviderInfo(modelId) {
  if (modelId.startsWith("openai_o1-")) {
    return { provider: "openai", model: modelId.slice("openai_o1-".length) };
  }

  const providers = [
    "anthropic",
    "baseten",
    "google",
    "groq",
    "mistral",
    "openai",
    "perplexity",
    "raycast",
    "together",
    "xai",
  ];

  for (const provider of providers) {
    const prefix = `${provider}-`;
    if (modelId.startsWith(prefix)) {
      return { provider, model: modelId.slice(prefix.length) };
    }
  }

  if (modelId.includes("/")) return { provider: "baseten", model: modelId };
  return { provider: "openai", model: modelId || "gpt-5-mini" };
}

function envFlagEnabled(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function includePremiumModels() {
  if (process.env.INCLUDE_PREMIUM !== undefined) {
    return envFlagEnabled("INCLUDE_PREMIUM", true);
  }

  // Backward-compatible with the original Worker flag.
  return envFlagEnabled("ADVANCED", true);
}

function filterRaycastModels(models) {
  const includePremium = includePremiumModels();
  const includeDeprecated = envFlagEnabled("INCLUDE_DEPRECATED", true);

  return models.filter((model) => {
    if (!includePremium && model.requires_better_ai) return false;
    if (!includeDeprecated && model.availability === "deprecated") return false;
    return true;
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function writeError(res, status, message, type = "relay_error") {
  writeJson(res, status, { error: { message, type, code: null } });
}

function parseRaycastText(responseText) {
  let fullText = "";

  for (const line of responseText.split("\n")) {
    if (!line.startsWith("data:")) continue;

    try {
      const data = JSON.parse(line.slice(5).trim());
      if (data.text) fullText += data.text;
    } catch {
      // Ignore non-JSON SSE lines.
    }
  }

  return fullText;
}

function openAIChatResponse(model, content) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          refusal: null,
          annotations: [],
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
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
}

async function pipeStreamingResponse(raycastResponse, res, model) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const reader = raycastResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;

      try {
        const data = JSON.parse(line.slice(5).trim());
        const hasContent = typeof data.text === "string" && data.text.length > 0;
        const hasFinishReason =
          data.finish_reason !== undefined && data.finish_reason !== null;
        if (data.complete || (!hasContent && !hasFinishReason)) continue;

        const chunk = {
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: data.text || "" },
              finish_reason: hasFinishReason ? data.finish_reason : null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } catch {
        // Ignore malformed SSE data.
      }
    }
  }

  res.end("data: [DONE]\n\n");
}

async function handleChat(req, res) {
  const rawBody = await readRequestBody(req);
  const body = JSON.parse(rawBody || "{}");
  const requestedModelId = body.model || DEFAULT_MODEL_ID;
  const { provider, model } = inferProviderInfo(requestedModelId);
  const { raycastMessages, systemInstruction } = convertMessages(
    body.messages || [],
  );

  if (raycastMessages.length === 0) {
    writeError(
      res,
      400,
      "Missing or invalid 'messages' field",
      "invalid_request_error",
    );
    return;
  }

  const raycastRequest = {
    model,
    provider,
    messages: raycastMessages,
    system_instruction: systemInstruction,
    temperature: body.temperature ?? 0.5,
    additional_system_instructions: "",
    debug: false,
    locale: "en-US",
    source: "ai_chat",
    thread_id: randomUUID(),
    tools: [],
  };

  const payload = JSON.stringify(raycastRequest);
  const raycastResponse = await fetch(RAYCAST_CHAT_URL, {
    method: "POST",
    headers: raycastHeaders(payload),
    body: payload,
  });

  if (!raycastResponse.ok) {
    const errorText = await raycastResponse.text();
    console.error(`Raycast chat error ${raycastResponse.status}: ${errorText}`);
    writeError(
      res,
      502,
      `Raycast API error (${raycastResponse.status})`,
      "bad_gateway",
    );
    return;
  }

  if (body.stream) {
    await pipeStreamingResponse(raycastResponse, res, requestedModelId);
    return;
  }

  const responseText = await raycastResponse.text();
  writeJson(
    res,
    200,
    openAIChatResponse(requestedModelId, parseRaycastText(responseText)),
  );
}

async function handleModels(res) {
  const raycastResponse = await fetch(RAYCAST_MODELS_URL, {
    method: "GET",
    headers: raycastHeaders("{}"),
  });

  if (!raycastResponse.ok) {
    const errorText = await raycastResponse.text();
    console.error(
      `Raycast models error ${raycastResponse.status}: ${errorText}`,
    );
    writeError(
      res,
      502,
      `Raycast API error (${raycastResponse.status})`,
      "bad_gateway",
    );
    return;
  }

  const data = await raycastResponse.json();
  const models = filterRaycastModels(data.models || []);

  writeJson(res, 200, {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: model.provider,
    })),
  });
}

function handleOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      handleOptions(res);
      return;
    }

    if (!validateApiKey(req)) {
      writeError(res, 401, "Invalid API key provided.", "authentication_error");
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      writeJson(res, 200, {
        name: "raycast-relay",
        runtime: "node",
        endpoints: ["/health", "/v1/models", "/v1/chat/completions"],
      });
    } else if (url.pathname === "/health" && req.method === "GET") {
      writeJson(res, 200, { status: "ok" });
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      await handleModels(res);
    } else if (
      url.pathname === "/v1/chat/completions" &&
      req.method === "POST"
    ) {
      await handleChat(req, res);
    } else {
      writeError(res, 404, "Not Found", "invalid_request_error");
    }
  } catch (error) {
    console.error(error);
    writeError(
      res,
      500,
      error.message || "Internal server error",
      "server_error",
    );
  }
});

const port = getPort();
const host = getHost();
server.listen(port, host, () => {
  console.log(`Raycast Relay Node server listening on http://${host}:${port}`);
});
