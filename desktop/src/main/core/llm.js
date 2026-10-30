// Optional LLM explanations. Same prompts as server/src/LLMs/llm.js, but the
// providers are configured in the app's Settings instead of environment variables.

const parseList = (s) =>
  (Array.isArray(s) ? s : String(s || "").split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);

/** Models the user enabled in Settings, as [{ id: "openai:gpt-4o-mini", provider, model }]. */
export function listModels(llm = {}) {
  const out = [];
  if (llm.openai?.apiKey) {
    for (const model of parseList(llm.openai.models)) out.push({ id: `openai:${model}`, provider: "openai", model });
  }
  if (llm.ollama?.url) {
    for (const model of parseList(llm.ollama.models)) out.push({ id: `ollama:${model}`, provider: "ollama", model });
  }
  return out;
}

/** Returns ({word, sentence, signal}) => Promise<markdown> for the chosen model id. */
export function createExplainer(llm, modelId) {
  const entry = listModels(llm).find((m) => m.id === modelId);
  if (!entry) throw new Error(`LLM model "${modelId}" is not configured in Settings.`);
  const system = getSystemPrompt();
  return async ({ word, sentence, signal }) => {
    const user = buildExplanationPrompt(word || "", sentence || "");
    if (entry.provider === "openai") {
      return runOpenAI({ apiKey: llm.openai.apiKey, model: entry.model, system, prompt: user, signal });
    }
    return runOllama({ url: llm.ollama.url, model: entry.model, prompt: `SYSTEM:\n${system}\n\nUSER:\n${user}`, signal });
  };
}

function getSystemPrompt() {
  return `
You are a British English lexical coach. Explain the target item **as used in the given sentence**, favouring British usage, spelling, and register notes.

Guidelines:
- Output **Markdown only** (no links, no images, no tables, no code fences).
- Be accurate and helpful; if unsure about a fact, **omit it** rather than guessing.
- Prefer BrE spellings and labels (informal / neutral / formal).
- Use natural paragraphs; bullets only when they genuinely improve clarity.
- Aim to teach: meaning-in-context first, then nuance, usage patterns, and memorable cues.
- Finish with **one final line**: \`CZ: <Czech> | SK: <Slovak>\` (brief, idiomatic).

Audience: very advanced learners building Anki cards who value depth.
`.trim();
}

function buildExplanationPrompt(word = "", sentence = "") {
  return `
You will receive a target WORD and a source SENTENCE taken from reading context.

1) If the highlighted token is part of a **multi-word expression** (phrasal verb, fixed collocation), treat the **whole expression** as the headword; otherwise, use the best **lemma** of WORD.
2) Write a flowing, **thorough** explanation in British English.
Then respond in **exactly** this Markdown template (no extra sections, no preamble):

Cover, as naturally as possible:
- The **meaning in this sentence** (the exact sense and nuance), plus typical grammar/patterns (e.g., verb + prep, count/uncount, transitivity).
- **Collocations & patterns** learners will meet (up to a handful; keep them relevant).
- **Idioms / set phrases** that feature the item (brief gloss + when to use).
- **Register/pragmatics** (formal/informal/neutral), common pitfalls or false friends.
- A few **natural UK examples** (short lines) and one **mini-scene** that uses the item in context.
- Optionally: closely related **forms** (e.g., noun/verb/adjective) if useful to understanding.

Keep it compact but substantial (quality over quantity). Do not add links or images.

DATA
WORD: "${word}"
SENTENCE: "${sentence}"
`;
}

async function runOllama({ url, model, prompt, signal }) {
  const endpoint = String(url).replace(/\/$/, "") + "/api/generate";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status} ${text || ""}`.trim());
  }
  const data = await res.json();
  return (data.response || "").trim() || "_empty response_";
}

async function runOpenAI({ apiKey, model, system, prompt, signal }) {
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ]
  };
  // gpt-5 family only accepts the default temperature.
  if (!/^gpt-5\b/i.test(model)) payload.temperature = 0.2;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status} ${text || ""}`.trim());
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || "").trim() || "_empty response_";
}
