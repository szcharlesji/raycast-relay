# Raycast Relay for Cloudflare Workers

- [Setup](#setup)
- [Usage](#usage)
- [Use with Cursor](#use-with-cursor)
- [Available Models](#available-models)

This project provides a relay server that allows you to use Raycast AI models through an OpenAI-compatible API interface, deployed as a Cloudflare Worker.

## Deployment

### One-Click Deployment (Recommended)

1. Get your Raycast AI Token in the step 1 below
2. Deploy
3. Add `RAYCAST_BEARER_TOKEN` in Settings -> Domain & Routes -> Variables and Secrets. You can optionally add a `API_KEY`, `ADVANCED`, `INCLUDE_DEPRECATED`. Follow the guide below

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/szcharlesji/raycast-relay)

### Prerequisites

- [Node.js](https://nodejs.org/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- Raycast API credential (Bearer token)
- HTTP Debug Tool like Proxyman or Charles on macOS

### Setup

1. Get your Raycast AI Token

Proxyman: Add raycast to your SSL proxying list, resend a request to AI. You will see a request like in the photo below: Copy the API key after Authorization Bearer.

![proxyman](/img/proxyman.jpeg)

2. Clone this repository

```bash
git clone https://github.com/szcharlesji/raycast-relay
cd raycast-relay
```

3. Install dependencies:

```bash
npm install
```

3. Configure your environment variables:

```bash
# Install wrangler
npm install -g wrangler

# Set your Raycast credentials as secrets
wrangler secret put RAYCAST_BEARER_TOKEN

# Optionally set an API key for authentication, if you want to use it with cursor, follow the cursor setup
wrangler secret put API_KEY

# Optionally set to filter out the advanced AI options if you don't have the subscription.
wrangler secret put ADVANCED

# Optionall set to include deprecated models
wrangler secret put INCLUDE_DEPRECATED
```

4. Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## Usage

Once deployed, you can use the worker as an OpenAI-compatible API endpoint:

```
https://your-worker-name.your-account.workers.dev/v1
```

### API Endpoints

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Create a chat completion
- `GET /health` - Health check endpoint

### Authentication

If you've set an API_KEY, include it in your requests:

```
Authorization: Bearer your-api-key
```

## Use with Cursor

Raycast-relay supports Cursor, but a workaround is needed since Cursor has a [known issue](https://github.com/getcursor/cursor/issues/2871) with custom AI endpoints other than OpenAI. Thanks to [Vincent](https://github.com/missuo)'s suggestions

In order to use your relayed API endpoint in cursor:

1. Generate an API key in [OpenAI Platform](https://platform.openai.com/settings/organization/api-keys), you just need to use it to verify it
2. Verify this key in Cursor by putting it in `Cursor Settings > Models > OpenAI API Key` with the default OpenAI endpoint
3. Upload your wrangler secret `API_KEY` by `wrangler secret put API_KEY`, this needs to be the same key as the OpenAI key
4. Override your OpenAI Base URL with your wrangler endpoint
5. Save it
6. Add a custom model that you can find in the `/v1/models` endpoint or check out [Available Models](#available-models)
7. Done!

![cursor_edit](img/cursor_edit.png)

## Available Models

Here's a list of all the model IDs:

- gpt-4.1
- gpt-4.1-mini
- gpt-4.1-nano
- gpt-4
- gpt-4-turbo
- gpt-4o
- gpt-4o-mini
- o3
- o4-mini
- o1-preview
- o1-mini
- o1-2024-12-17
- o3-mini
- claude-3-5-haiku-latest
- claude-3-5-sonnet-latest
- claude-3-7-sonnet-latest
- claude-3-7-sonnet-latest-reasoning
- claude-3-opus-20240229
- sonar
- sonar-pro
- sonar-reasoning
- sonar-reasoning-pro
- meta-llama/llama-4-scout-17b-16e-instruct
- llama-3.3-70b-versatile
- llama-3.1-8b-instant
- llama3-70b-8192
- meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo
- open-mistral-nemo
- mistral-large-latest
- mistral-small-latest
- codestral-latest
- deepseek-r1-distill-llama-70b
- qwen-2.5-32b
- gemini-2.5-pro-preview-03-25
- gemini-1.5-flash
- gemini-1.5-pro
- gemini-2.0-flash
- gemini-2.0-flash-thinking-exp-01-21
- deepseek-ai/DeepSeek-R1
- deepseek-ai/DeepSeek-V3
- grok-3-fast-beta
- grok-3-mini-fast-beta
- grok-2-latest

## License

MIT
