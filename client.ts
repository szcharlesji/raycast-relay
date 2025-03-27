import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "dummy-key", // The key doesn't matter as we're bypassing authentication
});

async function streamChatCompletion() {
  const response = await openai.chat.completions.create({
    model: "claude-3-7-sonnet-latest",
    messages: [{ role: "user", content: "Hello, how are you?" }],
    stream: true,
  });

  for await (const chunk of response) {
    // Process each chunk of data here
    console.log(chunk);
  }
}

streamChatCompletion().catch(console.error);
