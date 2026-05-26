/**
 * llm-client.js — Thin LLM wrapper for skill library modules
 *
 * Provides a simple callLlm() interface that works in-process using Google Vertex AI (Gemini)
 * via native Node fetch. No external SDKs or subprocesses required.
 */

async function callLlm({ prompt, model = 'gemini-3.1-pro-preview', maxTokens = 2000, temperature = 0.7 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is missing.");
  
  const modelName = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  const finalModel = modelName.includes('claude') || modelName.includes('gpt') ? 'gemini-3.1-pro-preview' : modelName;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${finalModel}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: temperature
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google LLM API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  let text = '';
  
  if (candidate?.content?.parts) {
    text = candidate.content.parts.map(p => p.text).join('');
    if (candidate.finishReason === 'MAX_TOKENS') {
      console.warn(`[llm-client] Warning: Response reached MAX_TOKENS (${maxTokens}) and may be truncated.`);
    }
    return text;
  } else if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error(`Google LLM API error: Response hit MAX_TOKENS (${maxTokens}) immediately.`);
  }
  
  throw new Error("Unexpected response format from Google LLM API: " + JSON.stringify(data));
}

module.exports = { callLlm };
