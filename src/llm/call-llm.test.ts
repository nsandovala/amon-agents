import { afterEach, describe, expect, it, vi } from "vitest";

import { callLLM, getOllamaNumPredict, getTimeoutMs } from "./call-llm";

describe("LLM runtime configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses 120000ms as the default timeout", () => {
    vi.stubEnv("AMON_AGENTS_LLM_TIMEOUT_MS", "");

    expect(getTimeoutMs()).toBe(120000);
  });

  it("uses a valid AMON_AGENTS_LLM_TIMEOUT_MS override", () => {
    vi.stubEnv("AMON_AGENTS_LLM_TIMEOUT_MS", "45000");

    expect(getTimeoutMs()).toBe(45000);
  });

  it("falls back to the default timeout for an invalid override", () => {
    vi.stubEnv("AMON_AGENTS_LLM_TIMEOUT_MS", "30s");

    expect(getTimeoutMs()).toBe(120000);
  });

  it("uses num_predict=1536 by default for Ollama", () => {
    vi.stubEnv("AMON_OLLAMA_NUM_PREDICT", "");

    expect(getOllamaNumPredict()).toBe(1536);
  });

  it("uses a valid AMON_OLLAMA_NUM_PREDICT override", () => {
    vi.stubEnv("AMON_OLLAMA_NUM_PREDICT", "2048");

    expect(getOllamaNumPredict()).toBe(2048);
  });

  it("falls back to num_predict=1536 for an invalid override", () => {
    vi.stubEnv("AMON_OLLAMA_NUM_PREDICT", "many");

    expect(getOllamaNumPredict()).toBe(1536);
  });

  it("sends think:false and num_predict=1536 to Ollama by default", async () => {
    vi.stubEnv("AMON_AGENTS_PROVIDER", "ollama");
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
    vi.stubEnv("OLLAMA_MODEL", "qwen3.5:9b");
    vi.stubEnv("AMON_OLLAMA_THINK", "");
    vi.stubEnv("AMON_OLLAMA_NUM_PREDICT", "");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ response: "{}", prompt_eval_count: 1, eval_count: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callLLM("prompt");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      model: "qwen3.5:9b",
      prompt: "prompt",
      think: false,
      stream: false,
      options: { temperature: 0.2, num_predict: 1536 },
    });
  });

  it("allows AMON_OLLAMA_THINK=true override", async () => {
    vi.stubEnv("AMON_AGENTS_PROVIDER", "ollama");
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
    vi.stubEnv("OLLAMA_MODEL", "qwen3.5:9b");
    vi.stubEnv("AMON_OLLAMA_THINK", "true");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ response: "{}", prompt_eval_count: 1, eval_count: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callLLM("prompt");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.think).toBe(true);
  });

  it("rejects ambiguous AMON_OLLAMA_THINK values", async () => {
    vi.stubEnv("AMON_AGENTS_PROVIDER", "ollama");
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
    vi.stubEnv("OLLAMA_MODEL", "qwen3.5:9b");
    vi.stubEnv("AMON_OLLAMA_THINK", "yes");
    vi.stubEnv("AMON_AGENTS_ALLOW_MOCK_FALLBACK", "false");

    await expect(callLLM("prompt")).rejects.toThrow("Invalid AMON_OLLAMA_THINK");
  });
});
