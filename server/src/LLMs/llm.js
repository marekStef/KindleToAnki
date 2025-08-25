// server/src/llm.js
import { spawn } from "node:child_process";

/** utils */
const parseList = (s = "") =>
    String(s || "")
        .split(/[,;\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);

const parseJson = (s = "{}", fallback = {}) => {
    try { return JSON.parse(s); } catch { return fallback; }
};

/** env */
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "").trim();
const HAVE_OPENAI = !!process.env.OPENAI_API_KEY;
const OLLAMA_MODELS = parseList(process.env.OLLAMA_MODELS);
const OPENAI_MODELS_INPUT = parseList(process.env.OPENAI_MODELS);
const OPENAI_MODELS = HAVE_OPENAI ? OPENAI_MODELS_INPUT : []; // hide if key missing

const OLLAMA_MODELS_INFO = parseJson(process.env.OLLAMA_MODELS_INFO || "{}", {});
const OPENAI_MODELS_INFO = parseJson(process.env.OPENAI_MODELS_INFO || "{}", {});

/** registry */
export const ALLOWED_MODELS = [...new Set([...OLLAMA_MODELS, ...OPENAI_MODELS])];
export const MODELS_ENABLED = ALLOWED_MODELS.length > 0;

const MODEL_PROVIDER = new Map([
    ...OLLAMA_MODELS.map((m) => [m, "ollama"]),
    ...OPENAI_MODELS.map((m) => [m, "openai"])
]);

const MODEL_INFO = { ...OLLAMA_MODELS_INFO, ...OPENAI_MODELS_INFO };

/** helpers exposed to server.js */
export function isModelAllowed(id) {
    return ALLOWED_MODELS.includes(id);
}

export function listAvailableModels() {
    return ALLOWED_MODELS.map((id) => ({
        id,
        provider: MODEL_PROVIDER.get(id) || "unknown",
        ...(MODEL_INFO[id] || { name: id, quality: "", notes: "" })
    }));
}

/** prompt builder kept central so convert.js stays dumb */

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


/** Local (Ollama) runner */
async function runOllama({ model, prompt }) {
    // Prefer HTTP if OLLAMA_URL is provided
    if (OLLAMA_URL && /^https?:\/\//i.test(OLLAMA_URL)) {
        const url = OLLAMA_URL.replace(/\/$/, "") + "/api/generate";
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Ollama HTTP ${res.status} ${text || ""}`.trim());
        }
        const data = await res.json();
        return (data.response || "").trim() || "_empty response_";
    }

    // Fallback to CLI
    return await new Promise((resolve) => {
        try {
            const child = spawn("ollama", ["run", model], { stdio: ["pipe", "pipe", "pipe"] });
            let out = "", err = "";
            child.stdout.on("data", (d) => (out += d.toString()));
            child.stderr.on("data", (d) => (err += d.toString()));
            child.on("close", () => {
                resolve(out.trim() || `_LLM error (${model}): ${String(err).trim().slice(0, 300)}_`);
            });
            child.stdin.write(prompt);
            child.stdin.end();
        } catch (e) {
            resolve(`_LLM not available: ${e.message}_`);
        }
    });
}

/** OpenAI runner (no SDK dependency) */
async function runOpenAI({ model, prompt, system }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system || "You are an English explainer." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status} ${text || ""}`.trim());
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return content.trim() || "_empty response_";
}

/**
 * Main entry point: decide where to route based on .env lists.
 * Returns Markdown string.
 */
export async function getLlmResponse({ model, word, sentence }) {
  if (!isModelAllowed(model)) throw new Error(`Model "${model}" is not allowed.`);
  const provider = MODEL_PROVIDER.get(model);

  const system = getSystemPrompt().trim();
  const user   = buildExplanationPrompt(word || "", sentence || "");

  if (provider === "openai") {
    return await runOpenAI({ model, prompt: user, system });
  }
  if (provider === "ollama") {
    // Inline the system guidance for single-prompt providers
    const merged = `SYSTEM:\n${system}\n\nUSER:\n${user}`;
    return await runOllama({ model, prompt: merged });
  }
  throw new Error(`Unknown provider for model "${model}".`);
}
