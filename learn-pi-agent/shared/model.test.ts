import assert from "node:assert/strict";
import test from "node:test";

import { loadCourseModel } from "./model.ts";

test("loadCourseModel needs only an API key for the official OpenAI defaults", () => {
  const runtime = loadCourseModel({ OPENAI_API_KEY: "test-key" });

  assert.equal(runtime.model.api, "openai-completions");
  assert.equal(runtime.model.provider, "openai-compatible");
  assert.equal(runtime.model.id, "gpt-4o-mini");
  assert.equal(runtime.model.baseUrl, "https://api.openai.com/v1");
  assert.deepEqual(runtime.streamOptions, {
    apiKey: "test-key",
    maxRetries: 0,
    timeoutMs: 60_000,
  });
});

test("loadCourseModel accepts OpenAI-compatible endpoint and model overrides", () => {
  const runtime = loadCourseModel({
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://example.test/v1/",
    OPENAI_MODEL: "course-model",
  });

  assert.equal(runtime.model.id, "course-model");
  assert.equal(runtime.model.baseUrl, "https://example.test/v1");
});

test("loadCourseModel rejects incomplete or invalid live configuration", () => {
  assert.throws(
    () => loadCourseModel({}),
    /OPENAI_API_KEY/,
  );
  assert.throws(
    () => loadCourseModel({ OPENAI_API_KEY: "key", OPENAI_BASE_URL: "relative", OPENAI_MODEL: "m" }),
    /absolute HTTP\(S\) URL/,
  );
});
