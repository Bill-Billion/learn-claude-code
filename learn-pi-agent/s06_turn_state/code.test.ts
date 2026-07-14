import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";

import { createToolRegistry } from "../s02_tool_schema/code.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";
import {
  BRANCH_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  convertToLlm,
  createMemorySession,
  createMiniHarness,
  listActiveToolNames,
  runHarnessTurn,
  type AgentMessage,
  type CustomMessage,
  type MiniSession,
} from "./code.ts";

function createRegistry() {
  return createToolRegistry([
    {
      name: "read",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler(input) {
        return { toolName: "read", content: String(input.path) };
      },
    },
  ]);
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

test("convertToLlm preserves standard messages and materializes custom agent messages", () => {
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
    timestamp: 2,
  };
  const messages: AgentMessage[] = [
    { role: "user", content: "hello", timestamp: 0 },
    assistantMessage("hi"),
    toolResult,
    {
      role: "custom",
      customType: "notice",
      content: "custom context",
      display: false,
      timestamp: 3,
    },
    {
      role: "branchSummary",
      summary: "the abandoned branch changed README.md",
      fromId: "entry-4",
      timestamp: 4,
    },
    {
      role: "compactionSummary",
      summary: "earlier context",
      tokensBefore: 900,
      timestamp: 5,
    },
  ];

  const converted = convertToLlm(messages);

  assert.deepEqual(converted.slice(0, 3), messages.slice(0, 3));
  assert.equal(converted[3]?.role, "user");
  assert.deepEqual((converted[3] as Message & { content: unknown }).content, [
    { type: "text", text: "custom context" },
  ]);
  assert.equal((converted[4] as { content: Array<{ text: string }> }).content[0]?.text,
    `${BRANCH_SUMMARY_PREFIX}the abandoned branch changed README.md`);
  assert.equal((converted[5] as { content: Array<{ text: string }> }).content[0]?.text,
    `${COMPACTION_SUMMARY_PREFIX}earlier context`);
});

test("convertToLlm formats bash executions and excludes explicitly hidden executions", () => {
  const converted = convertToLlm([
    {
      role: "bashExecution",
      command: "npm test",
      output: "1 passing",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    },
    {
      role: "bashExecution",
      command: "print-secret",
      output: "hidden",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 2,
    },
  ]);

  assert.equal(converted.length, 1);
  assert.match((converted[0] as { content: Array<{ text: string }> }).content[0]?.text ?? "", /Ran `npm test`/);
  assert.match((converted[0] as { content: Array<{ text: string }> }).content[0]?.text ?? "", /1 passing/);
  assert.doesNotMatch(JSON.stringify(converted), /print-secret|hidden/);
});

test("createLlmContext applies transformContext before converting AgentMessage", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const custom: CustomMessage = {
    role: "custom",
    customType: "injected",
    content: "visible to the model",
    display: true,
    timestamp: 2,
  };
  let transformSawCustomMessage = false;
  const harness = createMiniHarness({
    session: createMemorySession("session-transform", [{ role: "user", content: "hello", timestamp: 1 }]),
    model: faux.getModel(),
    registry: createRegistry(),
    transformContext(messages) {
      transformSawCustomMessage = messages.some((message) => message.role === "custom");
      return [...messages, custom];
    },
  });

  const turnState = await harness.createTurnState();
  const llmContext = await harness.createLlmContext(turnState);

  assert.equal(transformSawCustomMessage, false);
  assert.equal(turnState.messages.length, 1);
  assert.deepEqual(llmContext.messages.map((message) => message.role), ["user", "user"]);
  assert.equal((llmContext.messages[1] as { content: Array<{ text: string }> }).content[0]?.text,
    "visible to the model");
});

test("createTurnState deep-clones messages, resources, model metadata, and stream options", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const session = createMemorySession("session-clone", [assistantMessage("original")]);
  const resources = {
    promptTemplates: [{ name: "fix", content: "Fix {target}" }],
  };
  const streamOptions = {
    timeoutMs: 30,
    headers: { "x-course": "one" },
    metadata: { turn: "first" },
  };
  const model = faux.getModel();
  const harness = createMiniHarness({
    session,
    model,
    registry: createRegistry(),
    resources,
    streamOptions,
  });

  const turnState = await harness.createTurnState();
  (session.messages[0] as AssistantMessage).content[0] = { type: "text", text: "changed" };
  resources.promptTemplates[0]!.content = "changed";
  streamOptions.headers["x-course"] = "two";
  streamOptions.metadata.turn = "second";
  model.cost.input = 99;

  assert.equal((turnState.messages[0] as AssistantMessage).content[0]?.type, "text");
  assert.equal(((turnState.messages[0] as AssistantMessage).content[0] as { text: string }).text, "original");
  assert.equal(turnState.resources.promptTemplates?.[0]?.content, "Fix {target}");
  assert.deepEqual(turnState.streamOptions.headers, { "x-course": "one" });
  assert.deepEqual(turnState.streamOptions.metadata, { turn: "first" });
  assert.notEqual(turnState.model.cost.input, 99);
});

test("createTurnState selects active tools and rejects unknown names", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const registry = createRegistry();
  const harness = createMiniHarness({
    session: createMemorySession("session-tools"),
    model: faux.getModel(),
    registry,
    activeToolNames: ["read"],
  });

  const turnState = await harness.createTurnState();
  assert.equal(listActiveToolNames(turnState.activeTools), "read");

  assert.throws(() => createMiniHarness({
    session: createMemorySession("session-invalid"),
    model: faux.getModel(),
    registry,
    activeToolNames: ["missing"],
  }), /Unknown active tool: missing/);
});

test("memory session clones appended messages", async () => {
  const message: CustomMessage = {
    role: "custom",
    customType: "note",
    content: [{ type: "text", text: "original" }],
    display: true,
    timestamp: 1,
  };
  const session = createMemorySession("session-memory");
  session.appendMessage(message);
  (message.content as Array<{ type: "text"; text: string }>)[0]!.text = "changed";

  const context = await session.buildContext();

  assert.equal(((context.messages[0] as CustomMessage).content as Array<{ text: string }>)[0]?.text, "original");
  assert.equal((await session.getMetadata()).id, "session-memory");
});

test("runHarnessTurn keeps the real model to tool result to model path", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "README.md" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The file was read.")]),
  ]);
  t.after(() => faux.unregister());
  let executions = 0;
  const registry = createToolRegistry([{
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler(input) {
      executions += 1;
      return { toolName: "read", content: `contents of ${String(input.path)}` };
    },
  }]);
  const session = createMemorySession("session-loop");

  const result = await runHarnessTurn({
    session,
    model: faux.getModel(),
    registry,
    prompt: "Read README.md",
  });

  assert.equal(executions, 1);
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(session.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(result.finalMessage.content[0]?.type, "text");
  assert.equal(result.finalMessage.content[0]?.type === "text" ? result.finalMessage.content[0].text : "", "The file was read.");
});

test("runHarnessTurn exposes and executes only the active tool snapshot", async (t) => {
  let exposedTools: string[] = [];
  const faux = setupFauxProvider([
    (context) => {
      exposedTools = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo blocked" }),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("Recovered from the unavailable tool.")]),
  ]);
  t.after(() => faux.unregister());
  let bashExecutions = 0;
  const registry = createToolRegistry([
    {
      name: "read",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler(input) {
        return { toolName: "read", content: String(input.path) };
      },
    },
    {
      name: "bash",
      description: "Run a command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      handler(input) {
        bashExecutions += 1;
        return { toolName: "bash", content: String(input.command) };
      },
    },
  ]);

  const result = await runHarnessTurn({
    session: createMemorySession("session-active-tools"),
    model: faux.getModel(),
    registry,
    activeToolNames: ["read"],
    prompt: "Use only enabled tools",
  });

  assert.deepEqual(exposedTools, ["read"]);
  assert.equal(bashExecutions, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.match(
    result.toolResults[0]?.content[0]?.type === "text" ? result.toolResults[0].content[0].text : "",
    /Unknown tool: bash/,
  );
});

test("runHarnessTurn transforms history before conversion and appends the current prompt afterward", async (t) => {
  let providerMessages: Message[] = [];
  const faux = setupFauxProvider([
    (context) => {
      providerMessages = structuredClone(context.messages);
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  t.after(() => faux.unregister());
  const session = createMemorySession("session-transform-run", [
    { role: "user", content: "history", timestamp: 1 },
  ]);

  await runHarnessTurn({
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
    prompt: "current prompt",
    transformContext(messages) {
      return [...messages, {
        role: "custom",
        customType: "context-note",
        content: "injected context",
        display: false,
        timestamp: 2,
      }];
    },
  });

  assert.deepEqual(providerMessages.map((message) => message.role), ["user", "user", "user"]);
  assert.equal((providerMessages[1] as { content: Array<{ text: string }> }).content[0]?.text, "injected context");
  assert.equal(providerMessages[2]?.role === "user" ? providerMessages[2].content : "", "current prompt");
});

test("runHarnessTurn persists each completed message before a later provider failure", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "README.md" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "provider failed after the tool result",
    }),
  ]);
  t.after(() => faux.unregister());
  const session = createMemorySession("session-partial-failure");

  await assert.rejects(
    runHarnessTurn({
      session,
      model: faux.getModel(),
      registry: createRegistry(),
      prompt: "Read before failing",
    }),
    /provider failed after the tool result/,
  );

  assert.deepEqual(session.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(session.messages[3]?.role === "assistant" ? session.messages[3].stopReason : "", "error");
});

test("runHarnessTurn awaits async session writes before delivering message events", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxText("persisted")]),
  ]);
  t.after(() => faux.unregister());
  const messages: AgentMessage[] = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const session: MiniSession<AgentMessage> = {
    messages,
    async appendMessage(message) {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 2));
      messages.push(message);
      activeWrites -= 1;
    },
    buildContext() {
      return { messages: [...messages] };
    },
    getMetadata() {
      return { id: "session-async-writes" };
    },
  };

  await runHarnessTurn({
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
    prompt: "Persist in order",
    onEvent(event) {
      if (event.type === "message_end") {
        assert.strictEqual(messages.at(-1), event.message);
      }
    },
  });

  assert.equal(maximumActiveWrites, 1);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
});

test("runHarnessTurn persists an executed tool result before an external observer can abort", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
  ]);
  t.after(() => faux.unregister());
  const session = createMemorySession("session-observer-failure");
  let executions = 0;
  const registry = createToolRegistry([{
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler(input) {
      executions += 1;
      return { toolName: "read", content: String(input.path) };
    },
  }]);

  await assert.rejects(runHarnessTurn({
    session,
    model: faux.getModel(),
    registry,
    prompt: "Read once",
    onEvent(event) {
      if (event.type === "tool_execution_end") throw new Error("external observer failed");
    },
  }), /external observer failed/);

  assert.equal(executions, 1);
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
});

test("runHarnessTurn persists the exact user message consumed by the loop", async (t) => {
  let consumedUserMessage: Message | undefined;
  const faux = setupFauxProvider([
    (context) => {
      consumedUserMessage = context.messages.at(-1);
      return fauxAssistantMessage([fauxText("same object")]);
    },
  ]);
  t.after(() => faux.unregister());
  let persistedUserMessage: AgentMessage | undefined;
  const session: MiniSession<AgentMessage> = {
    messages: [],
    appendMessage(message) {
      if (message.role === "user") persistedUserMessage = message;
      this.messages.push(message);
    },
    buildContext() {
      return { messages: [...this.messages] };
    },
    getMetadata() {
      return { id: "session-user-reference" };
    },
  };

  await runHarnessTurn({
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
    prompt: "Use one message",
  });

  assert.strictEqual(consumedUserMessage, persistedUserMessage);
});

test("runHarnessTurn validates maxTurns and active tools before mutating the session", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const invalidTurnsSession = createMemorySession("session-invalid-turns");
  const invalidToolsSession = createMemorySession("session-invalid-tools");

  await assert.rejects(runHarnessTurn({
    session: invalidTurnsSession,
    model: faux.getModel(),
    registry: createRegistry(),
    prompt: "Do not persist",
    maxTurns: 0,
  }), /maxTurns must be a positive safe integer/);
  await assert.rejects(runHarnessTurn({
    session: invalidToolsSession,
    model: faux.getModel(),
    registry: createRegistry(),
    activeToolNames: ["missing"],
    prompt: "Do not persist",
  }), /Unknown active tool: missing/);

  assert.deepEqual(invalidTurnsSession.messages, []);
  assert.deepEqual(invalidToolsSession.messages, []);
  assert.equal(faux.state.callCount, 0);
});
