import assert from "node:assert/strict";
import test from "node:test";

import type { ToolResultMessage } from "@earendil-works/pi-ai";

import {
  createToolRegistry,
  dispatchTool,
} from "../s02_tool_schema/code.ts";
import {
  createMemorySession,
  runHarnessTurn,
  type AgentMessage,
  type MiniSession,
} from "../s06_turn_state/code.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";
import {
  createExtensionToolHooks,
  createExtensionTurnState,
  loadMiniExtensions,
  mergeExtensionTools,
  runExtensionTurn,
  type MiniExtensionFactory,
} from "./code.ts";

function emptySource() {
  return {
    readText() {
      return undefined;
    },
  };
}

function createReadRegistry() {
  return createToolRegistry([{
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler(input) {
      return { toolName: "read_file", content: `contents of ${String(input.path)}` };
    },
  }]);
}

function textFromToolResult(message: ToolResultMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

test("extension factories register tools and commands while loading", async () => {
  const extension: MiniExtensionFactory = (pi) => {
    pi.registerTool({
      name: "echo",
      description: "Echo text from an extension.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler(input) {
        return { toolName: "echo", content: `echo: ${String(input.text)}` };
      },
    });
    pi.registerCommand("hello", {
      description: "Say hello.",
      handler(args, ctx) {
        ctx.ui.notify(`hello ${args || "world"}`);
      },
    });
  };
  const runner = await loadMiniExtensions([{ path: "hello-extension.ts", factory: extension }]);
  const registry = mergeExtensionTools(createToolRegistry([]), runner);

  assert.deepEqual(runner.getTools().map((tool) => tool.name), ["echo"]);
  assert.equal((await dispatchTool(registry, "echo", { text: "Pi" })).content, "echo: Pi");
  assert.deepEqual((await runner.runCommand("hello", "Pi")).notifications, ["hello Pi"]);
});

test("duplicate extension tools, commands, and base-tool conflicts fail explicitly", async () => {
  await assert.rejects(loadMiniExtensions([{
    path: "duplicate-tools.ts",
    factory(pi) {
      const tool = {
        name: "echo",
        description: "Echo.",
        parameters: { type: "object" as const, properties: {} },
        handler() {
          return { toolName: "echo", content: "echo" };
        },
      };
      pi.registerTool(tool);
      pi.registerTool(tool);
    },
  }]), /Duplicate extension tool: echo/);

  await assert.rejects(loadMiniExtensions([
    {
      path: "first.ts",
      factory(pi) {
        pi.registerCommand("hello", { handler() {} });
      },
    },
    {
      path: "second.ts",
      factory(pi) {
        pi.registerCommand("hello", { handler() {} });
      },
    },
  ]), /Duplicate extension command: hello/);

  const runner = await loadMiniExtensions([{
    path: "read-shadow.ts",
    factory(pi) {
      pi.registerTool({
        name: "read_file",
        description: "Shadow read.",
        parameters: { type: "object", properties: {} },
        handler() {
          return { toolName: "read_file", content: "shadow" };
        },
      });
    },
  }]);
  assert.throws(() => mergeExtensionTools(createReadRegistry(), runner),
    /Extension tool conflicts with existing tool: read_file/);
});

test("before_agent_start handlers chain prompts and materialize AgentMessage values", async () => {
  const runner = await loadMiniExtensions([
    {
      path: "first.ts",
      factory(pi) {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: `${event.systemPrompt}\n[first]`,
          message: {
            customType: "first",
            content: "first extension saw the prompt",
            display: true,
          },
        }));
      },
    },
    {
      path: "second.ts",
      factory(pi) {
        pi.on("before_agent_start", (_event, ctx) => ({
          systemPrompt: `${ctx.getSystemPrompt()}\n[second]`,
        }));
      },
    },
  ]);

  const result = await runner.emitBeforeAgentStart({
    prompt: "fix",
    systemPrompt: "base",
    systemPromptOptions: { cwd: "/work/app" },
  });

  assert.equal(result.systemPrompt, "base\n[first]\n[second]");
  assert.equal(result.messages[0]?.role, "custom");
  assert.equal(result.messages[0]?.customType, "first");
  assert.equal(result.messages[0]?.content, "first extension saw the prompt");
  assert.equal(typeof result.messages[0]?.timestamp, "number");
});

test("resources_discover keeps extension provenance", async () => {
  const runner = await loadMiniExtensions([{
    path: "dynamic-resources.ts",
    factory(pi) {
      pi.on("resources_discover", (event) => ({
        skillPaths: [`${event.cwd}/.pi/skills/review/SKILL.md`],
        promptPaths: [`${event.cwd}/.pi/prompts/fix.md`],
      }));
    },
  }]);

  const result = await runner.emitResourcesDiscover("/work/app", "startup");

  assert.deepEqual(result.skillPaths, [
    { path: "/work/app/.pi/skills/review/SKILL.md", extensionPath: "dynamic-resources.ts" },
  ]);
  assert.deepEqual(result.promptPaths, [
    { path: "/work/app/.pi/prompts/fix.md", extensionPath: "dynamic-resources.ts" },
  ]);
});

test("createExtensionToolHooks blocks the actual S05 tool execution path", async (t) => {
  let executions = 0;
  const registry = createToolRegistry([{
    name: "danger",
    description: "Potentially dangerous action.",
    parameters: { type: "object", properties: {} },
    handler() {
      executions += 1;
      return { toolName: "danger", content: "executed" };
    },
  }]);
  const runner = await loadMiniExtensions([{
    path: "guard.ts",
    factory(pi) {
      pi.on("tool_call", (event) => event.toolName === "danger"
        ? { block: true, reason: "Denied by extension" }
        : undefined);
    },
  }]);
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxToolCall("danger", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The tool was denied.")]),
  ]);
  t.after(() => faux.unregister());
  const session = createMemorySession("s09-blocked");

  const result = await runHarnessTurn({
    session,
    model: faux.getModel(),
    registry,
    prompt: "Run danger",
    hooks: createExtensionToolHooks(runner),
  });

  const toolResult = result.addedMessages.find((message) => message.role === "toolResult") as ToolResultMessage;
  assert.equal(executions, 0);
  assert.equal(toolResult.isError, true);
  assert.equal(textFromToolResult(toolResult), "Denied by extension");
});

test("extension policy checks the effective arguments after caller hook rewrites", async (t) => {
  let executions = 0;
  const registry = createToolRegistry([{
    name: "read",
    description: "Read a path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler(input) {
      executions += 1;
      return { toolName: "read", content: String(input.path) };
    },
  }]);
  const runner = await loadMiniExtensions([{
    path: "path-policy.ts",
    factory(pi) {
      pi.on("tool_call", (event) => event.input.path === "secret.txt"
        ? { block: true, reason: "secret path denied" }
        : undefined);
    },
  }]);
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxToolCall("read", { path: "public.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("The rewritten path was denied.")]),
  ]);
  t.after(() => faux.unregister());

  const result = await runExtensionTurn({
    runner,
    source: emptySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createMemorySession("s09-effective-policy"),
    model: faux.getModel(),
    registry,
    prompt: "Read the public file",
    hooks: {
      beforeToolCall() {
        return { arguments: { path: "secret.txt" } };
      },
    },
  });

  assert.equal(executions, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.match(textFromToolResult(result.toolResults[0]!), /secret path denied/);
});

test("unblocked extension tools execute normally", async (t) => {
  let executions = 0;
  const registry = createToolRegistry([{
    name: "safe",
    description: "Safe action.",
    parameters: { type: "object", properties: {} },
    handler() {
      executions += 1;
      return { toolName: "safe", content: "executed" };
    },
  }]);
  const runner = await loadMiniExtensions([{
    path: "guard.ts",
    factory(pi) {
      pi.on("tool_call", () => undefined);
    },
  }]);
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxToolCall("safe", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Done.")]),
  ]);
  t.after(() => faux.unregister());

  await runExtensionTurn({
    runner,
    source: emptySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createMemorySession("s09-safe"),
    model: faux.getModel(),
    registry,
    prompt: "Run safe",
  });

  assert.equal(executions, 1);
});

test("createExtensionTurnState persists before_agent_start custom messages", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const session = createMemorySession("s09-state");
  const runner = await loadMiniExtensions([{
    path: "context.ts",
    factory(pi) {
      pi.on("before_agent_start", () => ({
        message: { customType: "context", content: "extension context", display: false },
      }));
    },
  }]);

  const state = await createExtensionTurnState({
    runner,
    source: emptySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
    prompt: "Use context",
  });

  assert.deepEqual(session.messages.map((message) => message.role), ["custom"]);
  assert.deepEqual(state.messages.map((message) => message.role), ["custom"]);
});

test("createExtensionTurnState awaits an async custom-message session sink", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const messages: AgentMessage[] = [];
  const session: MiniSession<AgentMessage> = {
    messages,
    async appendMessage(message) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      messages.push(message);
    },
    buildContext() {
      return { messages: [...messages] };
    },
    getMetadata() {
      return { id: "s09-async-state" };
    },
  };
  const runner = await loadMiniExtensions([{
    path: "context.ts",
    factory(pi) {
      pi.on("before_agent_start", () => ({
        message: { customType: "context", content: "async extension context", display: false },
      }));
    },
  }]);

  const state = await createExtensionTurnState({
    runner,
    source: emptySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
    prompt: "Use context",
  });

  assert.deepEqual(messages.map((message) => message.role), ["custom"]);
  assert.deepEqual(state.messages.map((message) => message.role), ["custom"]);
});

test("runExtensionTurn validates maxTurns before persisting extension messages", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const session = createMemorySession("s09-invalid-turns");
  const runner = await loadMiniExtensions([{
    path: "context.ts",
    factory(pi) {
      pi.on("before_agent_start", () => ({
        message: { customType: "context", content: "must not persist", display: false },
      }));
    },
  }]);

  await assert.rejects(runExtensionTurn({
    runner,
    source: emptySource(),
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
    prompt: "Invalid configuration",
    maxTurns: 0,
  }), /maxTurns must be a positive safe integer/);

  assert.deepEqual(session.messages, []);
  assert.equal(faux.state.callCount, 0);
});

test("runExtensionTurn merges tools before the snapshot and carries resources through the live loop", async (t) => {
  const files: Record<string, string> = {
    "/work/app/AGENTS.md": "Project rule: verify before reporting.",
    "/work/app/.pi/skills/review/SKILL.md": [
      "---",
      "name: review",
      "description: Review code changes.",
      "---",
      "Read the diff before commenting.",
    ].join("\n"),
  };
  let noteExecutions = 0;
  const runner = await loadMiniExtensions([{
    path: "review-helper.ts",
    factory(pi) {
      pi.registerTool({
        name: "note",
        description: "Write a short note.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        handler(input) {
          noteExecutions += 1;
          return { toolName: "note", content: `note: ${String(input.text)}` };
        },
      });
      pi.on("resources_discover", (event) => ({
        skillPaths: [`${event.cwd}/.pi/skills/review/SKILL.md`],
      }));
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\nExtension note: keep answers short.`,
        message: { customType: "extension-note", content: "extension context", display: false },
      }));
    },
  }]);
  let firstSystemPrompt = "";
  let firstTools: string[] = [];
  let firstMessages = "";
  const faux = setupFauxProvider([
    (context) => {
      firstSystemPrompt = context.systemPrompt ?? "";
      firstTools = context.tools?.map((tool) => tool.name) ?? [];
      firstMessages = JSON.stringify(context.messages);
      return fauxAssistantMessage([
        fauxToolCall("note", { text: "checked" }),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("Noted after reading the project context.")]),
  ]);
  t.after(() => faux.unregister());
  const session = createMemorySession("s09-live");

  const result = await runExtensionTurn({
    runner,
    source: { readText: (path) => files[path] },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createReadRegistry(),
    prompt: "Review and take a note",
  });

  assert.equal(noteExecutions, 1);
  assert.deepEqual(firstTools, ["read_file", "note"]);
  assert.match(firstSystemPrompt, /Project rule: verify before reporting\./);
  assert.match(firstSystemPrompt, /<name>review<\/name>/);
  assert.match(firstSystemPrompt, /Extension note: keep answers short\./);
  assert.match(firstMessages, /extension context/);
  assert.deepEqual(session.messages.map((message) => message.role), [
    "custom",
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(result.contextResources.skills[0]?.name, "review");
  assert.equal(result.discoveredResources.skillPaths[0]?.extensionPath, "review-helper.ts");
});
