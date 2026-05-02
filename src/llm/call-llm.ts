/**
 * Capa de conexión real a providers LLM.
 * Soporta: ollama, lmstudio, openai, gemini, openrouter.
 * El mock solo se usa como fallback si AMON_AGENTS_ALLOW_MOCK_FALLBACK=true.
 */
import { info, warn, error } from "../utils/logger";

export type Provider = "ollama" | "lmstudio" | "openai" | "gemini" | "openrouter" | "mock";

export interface LLMResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LLMCallOptions {
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

/* ──────────────────── Utilidades de entorno ──────────────────── */

function env(key: string): string | undefined {
  return process.env[key];
}

const DEFAULT_TIMEOUT_MS = 30000;

function getTimeoutMs(): number {
  const raw = env("AMON_AGENTS_LLM_TIMEOUT_MS");
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_TIMEOUT_MS : parsed;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      error(`[LLM] Timeout after ${timeoutMs}ms to ${url}`);
      throw new Error("LLM timeout");
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

function requireEnv(key: string): string {
  const value = env(key);
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function getProvider(): Provider {
  const p = (env("AMON_AGENTS_PROVIDER") || "ollama").toLowerCase() as Provider;
  const allowed: Provider[] = ["ollama", "lmstudio", "openai", "gemini", "openrouter", "mock"];
  if (!allowed.includes(p)) {
    throw new Error(`Invalid AMON_AGENTS_PROVIDER: ${p}. Allowed: ${allowed.join(", ")}`);
  }
  return p;
}

function getModel(provider: Provider): string {
  switch (provider) {
    case "ollama":
      return env("OLLAMA_MODEL") || env("AMON_AGENTS_MODEL") || "llama3";
    case "lmstudio":
      return env("LMSTUDIO_MODEL") || env("AMON_AGENTS_MODEL") || "local-model";
    case "openai":
      return env("OPENAI_MODEL") || env("AMON_AGENTS_MODEL") || "gpt-4o-mini";
    case "gemini":
      return env("GEMINI_MODEL") || env("AMON_AGENTS_MODEL") || "gemini-1.5-flash";
    case "openrouter":
      return env("OPENROUTER_MODEL") || env("AMON_AGENTS_MODEL") || "meta-llama/llama-3-8b-instruct";
    case "mock":
      return "mock";
  }
}

/* ──────────────────── Clientes por provider ──────────────────── */

async function callOllama(prompt: string, model: string): Promise<LLMResponse> {
  const baseUrl = (env("OLLAMA_BASE_URL") || "http://localhost:11434").replace(/\/$/, "");
  const url = `${baseUrl}/api/generate`;
  const body = {
    model,
    prompt,
    stream: false,
    options: { temperature: 0.2 },
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`Ollama HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    response?: string;
    done?: boolean;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  if (!data.response) {
    throw new Error("Ollama response missing 'response' field");
  }

  return {
    content: data.response,
    usage: {
      prompt_tokens: data.prompt_eval_count ?? 0,
      completion_tokens: data.eval_count ?? 0,
      total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    },
  };
}

async function callLMStudio(prompt: string, model: string): Promise<LLMResponse> {
  const baseUrl = (env("LMSTUDIO_BASE_URL") || "http://localhost:1234").replace(/\/$/, "");
  const url = `${baseUrl}/v1/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    stream: false,
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`LM Studio HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LM Studio response missing content");
  }

  return {
    content,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
  };
}

async function callOpenAI(prompt: string, model: string): Promise<LLMResponse> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response missing content");
  }

  return {
    content,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
  };
}

async function callGemini(prompt: string, model: string): Promise<LLMResponse> {
  const apiKey = requireEnv("GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`Gemini HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    throw new Error("Gemini response missing content");
  }

  return {
    content,
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

async function callOpenRouter(prompt: string, model: string): Promise<LLMResponse> {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": env("OPENROUTER_HTTP_REFERER") || "https://amon-agents.local",
      "X-Title": "AMON Agents",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`OpenRouter HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter response missing content");
  }

  return {
    content,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    },
  };
}

async function callMock(prompt: string): Promise<LLMResponse> {
  warn("[LLM] Usando MockLLMClient como fallback explícito.");
  const fallback = {
    goal: "Mock goal generado para desarrollo",
    scope: "Mock scope: se usó cliente mock",
    files_to_touch: ["src/core/run-agent.ts"],
    plan: ["Paso 1: Revisar prompt", "Paso 2: Implementar cambio", "Paso 3: Validar output"],
    risks: ["Cliente mock no ejecuta lógica real de LLM"],
    validations: ["Revisar que el JSON sea válido"],
    done_when: ["JSON parseado correctamente"],
  };
  return {
    content: JSON.stringify(fallback, null, 2),
    usage: { prompt_tokens: prompt.length, completion_tokens: 200, total_tokens: prompt.length + 200 },
  };
}

/* ──────────────────── API pública ──────────────────── */

export function getActiveProvider(): Provider {
  return getProvider();
}

export function getActiveModel(): string {
  return getModel(getProvider());
}

export function validateLLMConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const provider = getProvider();

  try {
    switch (provider) {
      case "ollama": {
        const ollamaBase = env("OLLAMA_BASE_URL");
        const ollamaModel = env("OLLAMA_MODEL") || env("AMON_AGENTS_MODEL");
        if (!ollamaBase || ollamaBase.trim().length === 0) {
          errors.push("Ollama: OLLAMA_BASE_URL no está definida");
        }
        if (!ollamaModel || ollamaModel.trim().length === 0) {
          errors.push("Ollama: OLLAMA_MODEL / AMON_AGENTS_MODEL no está definido");
        }
        break;
      }
      case "lmstudio": {
        const lmBase = env("LMSTUDIO_BASE_URL");
        const lmModel = env("LMSTUDIO_MODEL") || env("AMON_AGENTS_MODEL");
        if (!lmBase || lmBase.trim().length === 0) {
          errors.push("LM Studio: LMSTUDIO_BASE_URL no está definida");
        }
        if (!lmModel || lmModel.trim().length === 0) {
          errors.push("LM Studio: LMSTUDIO_MODEL / AMON_AGENTS_MODEL no está definido");
        }
        break;
      }
      case "openai": {
        const openaiKey = env("OPENAI_API_KEY");
        const openaiModel = env("OPENAI_MODEL") || env("AMON_AGENTS_MODEL");
        if (!openaiKey || openaiKey.trim().length === 0) {
          errors.push("OpenAI: OPENAI_API_KEY no está definida");
        }
        if (!openaiModel || openaiModel.trim().length === 0) {
          errors.push("OpenAI: OPENAI_MODEL / AMON_AGENTS_MODEL no está definido");
        }
        break;
      }
      case "gemini": {
        const geminiKey = env("GEMINI_API_KEY");
        const geminiModel = env("GEMINI_MODEL") || env("AMON_AGENTS_MODEL");
        if (!geminiKey || geminiKey.trim().length === 0) {
          errors.push("Gemini: GEMINI_API_KEY no está definida");
        }
        if (!geminiModel || geminiModel.trim().length === 0) {
          errors.push("Gemini: GEMINI_MODEL / AMON_AGENTS_MODEL no está definido");
        }
        break;
      }
      case "openrouter": {
        const orKey = env("OPENROUTER_API_KEY");
        const orModel = env("OPENROUTER_MODEL") || env("AMON_AGENTS_MODEL");
        if (!orKey || orKey.trim().length === 0) {
          errors.push("OpenRouter: OPENROUTER_API_KEY no está definida");
        }
        if (!orModel || orModel.trim().length === 0) {
          errors.push("OpenRouter: OPENROUTER_MODEL / AMON_AGENTS_MODEL no está definido");
        }
        break;
      }
      case "mock":
        break;
    }
  } catch (e) {
    errors.push(`Unexpected validation error: ${(e as Error).message}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Llama al LLM configurado con un prompt.
 * Si el provider falla y AMON_AGENTS_ALLOW_MOCK_FALLBACK=true, usa mock.
 * De lo contrario, lanza error descriptivo sin exponer API keys.
 */
export async function callLLM(prompt: string, options?: LLMCallOptions): Promise<string> {
  const provider = getProvider();
  const model = getModel(provider);

  info(`[LLM] Provider: ${provider}, Model: ${model}`);

  // Validar configuración antes de llamar
  const validation = validateLLMConfig();
  if (!validation.valid) {
    const msg = `LLM provider fail - provider=${provider}, model=${model}, cause=Config invalid: ${validation.errors.join("; ")}`;
    error(msg);
    throw new Error(msg);
  }

  try {
    let response: LLMResponse;

    switch (provider) {
      case "ollama":
        response = await callOllama(prompt, model);
        break;
      case "lmstudio":
        response = await callLMStudio(prompt, model);
        break;
      case "openai":
        response = await callOpenAI(prompt, model);
        break;
      case "gemini":
        response = await callGemini(prompt, model);
        break;
      case "openrouter":
        response = await callOpenRouter(prompt, model);
        break;
      case "mock":
        response = await callMock(prompt);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    info("[LLM] Respuesta recibida", { usage: response.usage });
    return response.content;
  } catch (err) {
    const cause = (err as Error).message;
    const allowMock = env("AMON_AGENTS_ALLOW_MOCK_FALLBACK") === "true";

    if (allowMock && provider !== "mock") {
      warn(`[LLM] Provider ${provider} falló (${cause}). Fallback a mock permitido.`);
      const mockResponse = await callMock(prompt);
      info("[LLM] Respuesta recibida (mock fallback)", { usage: mockResponse.usage });
      return mockResponse.content;
    }

    const safeCause = cause.replace(/\b[A-Za-z0-9_-]{20,}\b/g, "<redacted>");
    const msg = `LLM provider fail - provider=${provider}, model=${model}, cause=${safeCause}`;
    error(msg);
    throw new Error(msg);
  }
}
