import type { Model, ProviderStreamOptions } from "@earendil-works/pi-ai";

export type CourseEnvironment = Record<string, string | undefined>;

export type CourseModelRuntime = {
  model: Model<"openai-completions">;
  streamOptions: ProviderStreamOptions;
};

export function loadCourseModel(env: CourseEnvironment = process.env): CourseModelRuntime {
  const apiKey = requireEnvironmentValue(env, "OPENAI_API_KEY");
  const modelId = env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const baseUrl = normalizeBaseUrl(env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1");

  return {
    model: {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
    streamOptions: {
      apiKey,
      maxRetries: 0,
      timeoutMs: 60_000,
    },
  };
}

function requireEnvironmentValue(env: CourseEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for live model calls`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPENAI_BASE_URL must be an absolute HTTP(S) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL must be an absolute HTTP(S) URL");
  }

  return url.toString().replace(/\/$/, "");
}
