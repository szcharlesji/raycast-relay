# Tools

```bash
ENDPOINT="http://localhost:8787/v1/chat/completions"
MODEL="anthropic-claude-3-7-sonnet-latest"

ENDPOINT="http://localhost:11434/v1/chat/completions"
MODEL="qwen3:14b"

curl -X POST $ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-3-7-sonnet-latest",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "What is the weather in Munich?"
      }
    ],
    "tools": [
      {
        "name": "get_current_weather",
        "description": "Get the current weather in a given location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "The city and state, e.g. San Francisco, CA"
            },
            "unit": {
              "type": "string",
              "enum": ["celsius", "fahrenheit"]
            }
          },
          "required": ["location"]
        }
      }
    ]
  }'
```