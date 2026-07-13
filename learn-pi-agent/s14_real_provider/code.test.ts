import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDemoToolRegistry } from "../s02_tool_schema/code.ts";
import { collectProviderStream, readTextBlocks, type ProviderContext } from "../s03_provider_events/code.ts";
import { createIntegratedHarnessRuntime } from "../s13_integrated_harness/code.ts";
import {
  createOpenAICompatibleProvider,
  createLiveHarnessRuntime,
  loadOpenAICompatibleConfig,
  runLiveSession,
} from "./code.ts";

const context: ProviderContext = {
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: "Say hello" }],
  tools: [
    {
      name: "read",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path." } },
        required: ["path"],
      },
    },
  ],
};

test("loads live configuration without hiding the two required values", () => {
  assert.throws(
    () => loadOpenAICompatibleConfig({}),
    /OPENAI_API_KEY is required.*\.env\.example/,
  );
  assert.throws(
    () => loadOpenAICompatibleConfig({ OPENAI_API_KEY: "secret" }),
    /OPENAI_MODEL is required.*\.env\.example/,
  );
  assert.deepEqual(
    loadOpenAICompatibleConfig({ OPENAI_API_KEY: "secret", OPENAI_MODEL: "gpt-example" }),
    {
      apiKey: "secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-example",
    },
  );
});

test("the CLI entrypoint still runs through a symlink path containing spaces", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "learn pi s14 entry "));
  const linkedCourse = path.join(workspace, "learn pi agent");
  const courseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await symlink(courseRoot, linkedCourse, "dir");
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_MODEL;
  delete env.OPENAI_BASE_URL;

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(linkedCourse, "s14_real_provider", "code.ts"), "Read README.md"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENAI_API_KEY is required for s14/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sends ProviderContext to chat/completions and decodes text across arbitrary byte chunks", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ input: String(input), init: init ?? {} });
    return sseResponse([
      { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ delta: { content: "你" }, finish_reason: null }] },
      { choices: [{ delta: { content: "好" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], [1, 2, 5, 3, 1, 8]);
  };
  const provider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://gateway.example/v1/",
    model: "model-a",
    fetch: fetchStub,
  });

  const result = await collectProviderStream(provider, context);

  assert.equal(readTextBlocks(result.message).join(""), "你好");
  assert.deepEqual(result.eventTypes, ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "https://gateway.example/v1/chat/completions");
  assert.equal(requests[0]?.init.method, "POST");
  assert.equal(new Headers(requests[0]?.init.headers).get("authorization"), "Bearer test-key");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    model: "model-a",
    stream: true,
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Say hello" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "File path." } },
            required: ["path"],
          },
        },
      },
    ],
    parallel_tool_calls: false,
  });
});

test("surfaces streamed refusal text instead of returning an empty success", async () => {
  const provider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => sseResponse([
      { choices: [{ delta: { refusal: "I cannot help with that request." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  });

  const result = await collectProviderStream(provider, context);

  assert.equal(readTextBlocks(result.message).join(""), "I cannot help with that request.");
  assert.deepEqual(result.eventTypes, ["start", "text_start", "text_delta", "text_end", "done"]);
});

test("assembles fragmented tool-call deltas and completes the s13 tool loop", async () => {
  const requestBodies: unknown[] = [];
  let requestCount = 0;
  const fetchStub = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body)));
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: "call_", type: "function", function: { name: "re", arguments: "{\"pa" } }],
            },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: "1", function: { name: "ad", arguments: "th\":\"README.md\"}" } }],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ], [4, 1, 7, 2]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "Read complete." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], [3, 2, 9]);
  };
  const provider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://gateway.example/v1",
    model: "model-a",
    fetch: fetchStub,
  });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/student/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
  });

  const result = await runtime.prompt("Read README.md and confirm");

  assert.equal(result.finalText, "Read complete.");
  assert.equal(requestCount, 2);
  const secondRequest = requestBodies[1] as {
    messages: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string; content?: string }>;
  };
  assert.equal(secondRequest.messages.some((message) => message.role === "assistant" && message.tool_calls?.length === 1), true);
  assert.equal(secondRequest.messages.some((message) => (
    message.role === "tool"
      && message.tool_call_id === "call_1"
      && message.content === "read: README.md"
  )), true);
});

test("rejects multiple live tool calls before the harness executes either one", async () => {
  let requestCount = 0;
  const provider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => {
      requestCount += 1;
      return sseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } },
                { index: 1, id: "call_2", function: { name: "read", arguments: "{\"path\":\"package.json\"}" } },
              ],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    },
  });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/student/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
  });

  const result = await runtime.prompt("Read two files");

  assert.equal(requestCount, 1);
  assert.match(result.finalText, /at most 1 tool call per response/);
});

test("the live file tool rejects symlink escapes and the local secret file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "learn-pi-s14-"));
  const courseRoot = path.join(workspace, "course");
  const outside = path.join(workspace, "secret.txt");
  await mkdir(courseRoot);
  await writeFile(outside, "must-not-leak", "utf8");
  await symlink(outside, path.join(courseRoot, "escape.txt"));
  await writeFile(path.join(courseRoot, ".env"), "OPENAI_API_KEY=must-not-leak-either", "utf8");
  await writeFile(path.join(courseRoot, "oversized.txt"), "x".repeat(50_001), "utf8");
  await mkdir(path.join(courseRoot, "folder"));

  const requestBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  let call = 0;
  const fetchStub = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body)));
    call += 1;
    if (call === 1 || call === 3 || call === 5 || call === 7 || call === 9 || call === 11) {
      const requestedPath = call === 1
        ? "escape.txt"
        : call === 3
          ? ".env"
          : call === 5
            ? 42
            : call === 7
              ? "missing.md"
              : call === 9
                ? "oversized.txt"
                : "folder";
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${call}`, function: { name: "read_course_file", arguments: JSON.stringify({ path: requestedPath }) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "Handled." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  };

  try {
    const runtime = await createLiveHarnessRuntime({
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      fetch: fetchStub,
    }, courseRoot);
    await runtime.prompt("Read escape.txt");
    await runtime.prompt("Read .env");
    await runtime.prompt("Read path 42");
    await runtime.prompt("Read missing.md");
    await runtime.prompt("Read oversized.txt");
    await runtime.prompt("Read folder");

    const toolMessage = requestBodies[1]?.messages.find((message) => message.role === "tool");
    assert.match(toolMessage?.content ?? "", /only accepts paths inside learn-pi-agent/);
    assert.doesNotMatch(toolMessage?.content ?? "", /must-not-leak/);
    const secretToolMessage = requestBodies[3]?.messages.filter((message) => message.role === "tool").at(-1);
    assert.match(secretToolMessage?.content ?? "", /does not read hidden files/);
    assert.doesNotMatch(secretToolMessage?.content ?? "", /must-not-leak-either/);
    const invalidTypeMessage = requestBodies[5]?.messages.filter((message) => message.role === "tool").at(-1);
    assert.match(invalidTypeMessage?.content ?? "", /Invalid parameter type: path must be string/);
    const missingFileMessage = requestBodies[7]?.messages.filter((message) => message.role === "tool").at(-1);
    assert.equal(missingFileMessage?.content, "read_course_file could not read missing.md");
    assert.doesNotMatch(missingFileMessage?.content ?? "", new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const oversizedFileMessage = requestBodies[9]?.messages.filter((message) => message.role === "tool").at(-1);
    assert.equal(oversizedFileMessage?.content, "read_course_file refuses files larger than 50,000 bytes");
    const directoryMessage = requestBodies[11]?.messages.filter((message) => message.role === "tool").at(-1);
    assert.equal(directoryMessage?.content, "read_course_file only reads regular files");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the live file tool defaults to the course directory instead of ambient cwd", async () => {
  const ambientRoot = await mkdtemp(path.join(os.tmpdir(), "learn-pi-s14-cwd-"));
  await writeFile(path.join(ambientRoot, "README.md"), "ambient-cwd-secret", "utf8");
  const originalCwd = process.cwd();
  const requestBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  let requestCount = 0;
  const fetchStub = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body)));
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_course_file", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "Handled." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  };

  try {
    process.chdir(ambientRoot);
    const runtime = await createLiveHarnessRuntime({
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      fetch: fetchStub,
    });
    await runtime.prompt("Read README.md");
    const toolMessage = requestBodies[1]?.messages.find((message) => message.role === "tool");
    assert.doesNotMatch(toolMessage?.content ?? "", /ambient-cwd-secret/);
    assert.match(toolMessage?.content ?? "", /Learn Pi Agent/);
  } finally {
    process.chdir(originalCwd);
    await rm(ambientRoot, { recursive: true, force: true });
  }
});

for (const [status, expected] of [
  [401, /Authentication failed \(HTTP 401\): bad key/],
  [429, /Rate limited \(HTTP 429\): slow down/],
  [503, /Provider request failed \(HTTP 503\): unavailable/],
] as const) {
  test(`reports HTTP ${status} once without retrying`, async () => {
    let calls = 0;
    const provider = createOpenAICompatibleProvider({
      apiKey: "test-key",
      model: "model-a",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: status === 401 ? "bad key" : status === 429 ? "slow down" : "unavailable" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await collectProviderStream(provider, context);
    assert.equal(result.message.stopReason, "error");
    assert.match(readTextBlocks(result.message).join(""), expected);
    assert.deepEqual(result.eventTypes, ["start", "error"]);
    assert.equal(result.eventTypes.includes("done"), false);
    assert.equal(calls, 1);
  });
}

test("distinguishes network failure from an aborted request", async () => {
  const networkProvider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => { throw new TypeError("socket closed"); },
  });
  const networkResult = await collectProviderStream(networkProvider, context);
  assert.equal(networkResult.message.stopReason, "error");
  assert.match(readTextBlocks(networkResult.message).join(""), /Provider network error: socket closed/);
  assert.deepEqual(networkResult.eventTypes, ["start", "error"]);

  const controller = new AbortController();
  controller.abort();
  const abortedProvider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    signal: controller.signal,
    fetch: async () => { throw new DOMException("The operation was aborted", "AbortError"); },
  });
  const abortedResult = await collectProviderStream(abortedProvider, context);
  assert.equal(abortedResult.message.stopReason, "aborted");
  assert.match(readTextBlocks(abortedResult.message).join(""), /Provider request was aborted/);
  const abortedEvent = abortedResult.events.at(-1);
  assert.equal(abortedEvent?.type, "error");
  assert.equal(abortedEvent?.type === "error" ? abortedEvent.reason : undefined, "aborted");
  assert.deepEqual(abortedResult.eventTypes, ["start", "error"]);
});

test("reports malformed and incomplete SSE without executing partial output", async () => {
  const malformed = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => rawResponse("data: {not-json}\n\ndata: [DONE]\n\n"),
  });
  const malformedResult = await collectProviderStream(malformed, context);
  assert.equal(malformedResult.message.stopReason, "error");
  assert.match(readTextBlocks(malformedResult.message).join(""), /Malformed SSE JSON/);
  assert.equal(malformedResult.eventTypes.at(-1), "error");

  const incomplete = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => rawResponse("data: {\"choices\":[{\"delta\":{\"content\":\"half\"},\"finish_reason\":null}]}\n\n"),
  });
  const incompleteResult = await collectProviderStream(incomplete, context);
  assert.equal(incompleteResult.message.stopReason, "error");
  assert.match(readTextBlocks(incompleteResult.message).join(""), /SSE stream ended before \[DONE\]/);
  assert.equal(incompleteResult.eventTypes.at(-1), "error");

  const brokenArguments = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{bad" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  });
  const brokenArgumentsResult = await collectProviderStream(brokenArguments, context);
  assert.equal(brokenArgumentsResult.message.stopReason, "error");
  assert.match(readTextBlocks(brokenArgumentsResult.message).join(""), /Invalid JSON arguments for tool read/);
  assert.equal(brokenArgumentsResult.eventTypes.at(-1), "error");

  const truncatedToolCall = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]),
  });
  const truncatedResult = await collectProviderStream(truncatedToolCall, context);
  assert.equal(truncatedResult.message.stopReason, "error");
  assert.match(readTextBlocks(truncatedResult.message).join(""), /finish_reason length cannot finalize a tool call/);
  assert.equal(truncatedResult.eventTypes.at(-1), "error");
});

test("the live CLI reports turn exhaustion instead of succeeding with an empty answer", async () => {
  let requestCount = 0;
  const fetchStub = async (): Promise<Response> => {
    requestCount += 1;
    return sseResponse([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${requestCount}`,
              function: { name: "read_course_file", arguments: "{\"path\":\"README.md\"}" },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
  };

  await assert.rejects(
    runLiveSession(
      "Read README.md",
      { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "model-a" },
      { fetch: fetchStub },
    ),
    /reached the 4-turn limit while the model was still requesting a tool/,
  );
  assert.equal(requestCount, 4);
});

test("bounds remote streams and turns the request timeout into an aborted event", async () => {
  const timeoutProvider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    timeoutMs: 5,
    fetch: (_input, init): Promise<Response> => {
      assert.ok(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException("timed out", "AbortError"));
        if (init.signal?.aborted) {
          rejectAbort();
          return;
        }
        init.signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    },
  });
  const timeoutResult = await collectProviderStream(timeoutProvider, context);
  assert.equal(timeoutResult.message.stopReason, "aborted");
  assert.equal(timeoutResult.events.at(-1)?.type, "error");

  const oversizedSse = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => rawResponse(`data: ${"x".repeat(1_000_001)}`),
  });
  const oversizedResult = await collectProviderStream(oversizedSse, context);
  assert.equal(oversizedResult.message.stopReason, "error");
  assert.match(readTextBlocks(oversizedResult.message).join(""), /SSE event exceeded 1,000,000 characters/);

  const oversizedDelimitedSse = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => sseResponse([
      { choices: [{ delta: { content: "x".repeat(1_000_001) }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  });
  const oversizedDelimitedResult = await collectProviderStream(oversizedDelimitedSse, context);
  assert.equal(oversizedDelimitedResult.message.stopReason, "error");
  assert.match(
    readTextBlocks(oversizedDelimitedResult.message).join(""),
    /SSE event exceeded 1,000,000 characters/,
  );

  const oversizedTotal = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => rawResponse("x".repeat(4_000_001)),
  });
  const oversizedTotalResult = await collectProviderStream(oversizedTotal, context);
  assert.equal(oversizedTotalResult.message.stopReason, "error");
  assert.match(readTextBlocks(oversizedTotalResult.message).join(""), /SSE response exceeded 4,000,000 bytes/);

  let pulls = 0;
  let cancelled = false;
  const oversizedErrorBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 1_000) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(1_024).fill(97));
    },
    cancel() {
      cancelled = true;
    },
  });
  const errorProvider = createOpenAICompatibleProvider({
    apiKey: "test-key",
    model: "model-a",
    fetch: async () => new Response(oversizedErrorBody, { status: 503 }),
  });
  const errorResult = await collectProviderStream(errorProvider, context);
  assert.equal(errorResult.message.stopReason, "error");
  assert.ok(pulls < 1_000);
  assert.equal(cancelled, true);
});

function sseResponse(events: unknown[], chunkSizes: number[] = [Number.MAX_SAFE_INTEGER]): Response {
  const source = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return rawResponse(source, chunkSizes);
}

function rawResponse(source: string, chunkSizes: number[] = [Number.MAX_SAFE_INTEGER]): Response {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[chunkIndex % chunkSizes.length] ?? bytes.length;
      const end = Math.min(offset + size, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
      chunkIndex += 1;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
