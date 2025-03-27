import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "dummy-key", // The key doesn't matter as we're bypassing authentication
});

const response = await openai.chat.completions.create({
  model: "claude-3-7-sonnet-latest",
  messages: [{ role: "user", content: "Hello, how are you?" }],
});

console.log(response.choices[0].message.content);
