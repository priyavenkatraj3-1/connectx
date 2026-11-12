import { beforeEach, describe, expect, it, vi } from "vitest";

// The real SDK is never constructed or called: GoogleGenAI is replaced by a mock whose
// `models.generateContent` returns scripted responses. Enums and ApiError stay real.
const { generateContent, constructorArgs } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  constructorArgs: [] as unknown[],
}));

vi.mock("@google/genai", async () => {
  const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
  class MockGoogleGenAI {
    readonly models = { generateContent };
    constructor(options: unknown) {
      constructorArgs.push(options);
    }
  }
  return { ...actual, GoogleGenAI: MockGoogleGenAI };
});

import { ApiError } from "@google/genai";
import { GeminiProvider, toGeminiJsonSchema } from "../../src/modules/ai/providers/gemini.provider";
import { ProviderCallError } from "../../src/modules/ai/interfaces/ai-provider.interface";

const KEY = "test-gemini-key-not-real";
const MODEL = "gemini-test-model";

function textResponse(text: string, overrides: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    modelVersion: "gemini-test-model-001",
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<GeminiProvider["generate"]>[0]> = {}) {
  return { system: "SYSTEM RULES", input: "USER INPUT", maxOutputTokens: 500, signal: new AbortController().signal, ...overrides };
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderCallError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ProviderCallError);
  return err as ProviderCallError;
}

describe("GeminiProvider", () => {
  beforeEach(() => {
    generateContent.mockReset();
    constructorArgs.length = 0;
  });

  it("constructs the SDK client with the explicit key, Developer API only, and SDK retries off", () => {
    const provider = new GeminiProvider({ apiKey: KEY, model: MODEL });
    expect(provider).toMatchObject({ name: "gemini", isConfigured: true, model: MODEL });
    expect(constructorArgs).toEqual([{ apiKey: KEY, vertexai: false, httpOptions: { retryOptions: { attempts: 1 } } }]);
  });

  it("sends system instructions separately from the user turn, with the token cap and abort signal", async () => {
    generateContent.mockResolvedValue(textResponse("Hello"));
    const signal = new AbortController().signal;
    const result = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request({ signal }));

    expect(generateContent).toHaveBeenCalledTimes(1);
    const params = generateContent.mock.calls[0][0];
    expect(params.model).toBe(MODEL);
    expect(params.contents).toEqual([{ role: "user", parts: [{ text: "USER INPUT" }] }]);
    expect(params.config).toEqual({ systemInstruction: "SYSTEM RULES", maxOutputTokens: 500, abortSignal: signal });
    expect(JSON.stringify(params)).not.toContain(KEY);

    expect(result).toEqual({ text: "Hello", model: "gemini-test-model-001", inputTokens: 12, outputTokens: 34, truncated: false });
  });

  it("requests JSON output with the (Gemini-compatible) schema only when one is given", async () => {
    generateContent.mockResolvedValue(textResponse('{"translated_text":"Hola","detected_source_language":null}'));
    const schema = {
      type: "object",
      properties: { translated_text: { type: "string" }, detected_source_language: { type: ["string", "null"] } },
      required: ["translated_text", "detected_source_language"],
      additionalProperties: false,
    };
    const result = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request({ jsonSchema: schema }));

    const config = generateContent.mock.calls[0][0].config;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toEqual({
      type: "object",
      properties: { translated_text: { type: "string" }, detected_source_language: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["translated_text", "detected_source_language"],
      additionalProperties: false,
    });
    expect(result.text).toBe('{"translated_text":"Hola","detected_source_language":null}');
  });

  it("falls back to the configured model and null usage when the response omits them", async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] });
    const result = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request());
    expect(result).toMatchObject({ model: MODEL, inputTokens: null, outputTokens: null });
  });

  it("skips thought parts and joins the answer's text parts", async () => {
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "reasoning…", thought: true }, { text: "Part 1. " }, { text: "Part 2." }] }, finishReason: "STOP" }],
    });
    const result = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request());
    expect(result.text).toBe("Part 1. Part 2.");
  });

  it("marks MAX_TOKENS output as truncated", async () => {
    generateContent.mockResolvedValue(textResponse("cut off", { candidates: [{ content: { parts: [{ text: "cut off" }] }, finishReason: "MAX_TOKENS" }] }));
    const result = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request());
    expect(result.truncated).toBe(true);
  });

  it("returns empty text (rejected later by the gateway) when there are no candidates", async () => {
    generateContent.mockResolvedValue({});
    const result = await new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request());
    expect(result.text).toBe("");
  });

  it.each(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"])("treats finish reason %s as a refusal", async (finishReason) => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason }] });
    const err = await failureOf(new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request()));
    expect(err).toMatchObject({ code: "refused", retryable: false });
  });

  it("treats a blocked prompt as a refusal", async () => {
    generateContent.mockResolvedValue({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "blocked" } });
    const err = await failureOf(new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request()));
    expect(err).toMatchObject({ code: "refused", retryable: false });
  });

  it.each([
    [429, "rate_limited", true],
    [401, "auth", false],
    [403, "auth", false],
    [400, "bad_request", false],
    [404, "bad_request", false],
    [408, "timeout", true],
    [500, "overloaded", true],
    [503, "overloaded", true],
    [418, "unknown", false],
  ] as const)("maps HTTP %i to %s (retryable: %s) with a fixed message", async (status, code, retryable) => {
    // Google's error text could echo request details; it must never be passed on.
    generateContent.mockRejectedValue(new ApiError({ message: `upstream detail ${KEY} USER INPUT`, status }));
    const err = await failureOf(new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request()));
    expect(err).toMatchObject({ code, retryable });
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("USER INPUT");
    expect(err.message).not.toContain("upstream detail");
  });

  it("maps aborts (gateway timeout or cancel) to a non-retryable abort", async () => {
    const controller = new AbortController();
    generateContent.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    });
    const err = await failureOf(new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request({ signal: controller.signal })));
    expect(err).toMatchObject({ code: "aborted", retryable: false });
  });

  it("maps network failures to a retryable network error, but not other TypeErrors", async () => {
    generateContent.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await failureOf(new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request()))).toMatchObject({ code: "network", retryable: true });

    generateContent.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined"));
    expect(await failureOf(new GeminiProvider({ apiKey: KEY, model: MODEL }).generate(request()))).toMatchObject({ code: "unknown", retryable: false });
  });
});

describe("toGeminiJsonSchema", () => {
  it("rewrites nullable type arrays to anyOf at any depth and leaves everything else untouched", () => {
    const input = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { due_iso: { type: ["string", "null"] }, title: { type: "string" }, only: { type: ["string"] } },
            required: ["due_iso", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
    };
    expect(toGeminiJsonSchema(input)).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { due_iso: { anyOf: [{ type: "string" }, { type: "null" }] }, title: { type: "string" }, only: { type: "string" } },
            required: ["due_iso", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
    });
    // Input is not mutated.
    expect(input.properties.items.items.properties.due_iso.type).toEqual(["string", "null"]);
  });
});
