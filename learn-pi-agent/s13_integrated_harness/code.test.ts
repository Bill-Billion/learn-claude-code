import assert from "node:assert/strict";
import test from "node:test";

import { createDemoToolRegistry, createToolRegistry } from "../s02_tool_schema/code.ts";
import {
  createTextProvider,
  createToolCallProvider,
  type EventProvider,
  type ProviderContext,
} from "../s03_provider_events/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";
import type { MiniExtensionFactory } from "../s09_extension_runtime/code.ts";
import {
  createSdkSession,
  runJsonMode,
  runPrintMode,
  runRpcMode,
  type MiniRuntimeEvent,
} from "../s10_runtime_modes/code.ts";
import { createPackageManifest } from "../s12_pi_package/code.ts";
import { createIntegratedHarnessRuntime } from "./code.ts";

test("a package skill, extension tool, project context, provider loop, and session tree compose end to end", async () => {
  const packageRoot = "/packages/review";
  const extensionPath = `${packageRoot}/extensions/review.ts`;
  const skillPath = `${packageRoot}/skills/review/SKILL.md`;
  const files = {
    "/repo/AGENTS.md": "Project rule: verify before reporting.",
    [`${packageRoot}/package.json`]: JSON.stringify(
      createPackageManifest("review-pack", {
        extensions: ["extensions/review.ts"],
        skills: ["skills/review/SKILL.md"],
      }),
    ),
    [extensionPath]: "export default function review() {}",
    [skillPath]: [
      "---",
      "name: review",
      "description: Review a change before reporting.",
      "---",
      "Read the changed files and verification output.",
    ].join("\n"),
  };
  let toolCalls = 0;
  const extensionFactory: MiniExtensionFactory = (pi) => {
    pi.registerTool({
      name: "review_note",
      label: "review_note",
      description: "Record the file that was reviewed.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler(input) {
        toolCalls += 1;
        return { toolName: "review_note", content: `reviewed: ${String(input.path)}` };
      },
    });
  };
  const providerContexts: ProviderContext[] = [];
  const provider: EventProvider = {
    stream(context) {
      providerContexts.push({ ...context, messages: [...context.messages], tools: [...context.tools] });
      const lastMessage = context.messages.at(-1) as { role?: string } | undefined;
      if (lastMessage?.role === "toolResult") {
        return createTextProvider(["Review complete."]).stream(context);
      }
      return createToolCallProvider("review_note", { path: "README.md" }).stream(context);
    },
  };
  const sessionTree = createSessionTree({ id: "s13-package", cwd: "/repo", now: () => "2026-07-12T00:00:00.000Z" });
  const runtime = await createIntegratedHarnessRuntime({
    files,
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
    sessionTree,
    userPackages: [packageRoot],
    extensionFactories: { [extensionPath]: extensionFactory },
  });

  const result = await runtime.prompt("Review README.md");

  assert.equal(result.finalText, "Review complete.");
  assert.equal(toolCalls, 1);
  assert.match(providerContexts[0]?.systemPrompt ?? "", /Project rule: verify before reporting\./);
  assert.match(providerContexts[0]?.systemPrompt ?? "", /<name>review<\/name>/);
  assert.equal(providerContexts[0]?.tools.some((tool) => tool.name === "review_note"), true);
  const returnedToolResult = providerContexts[1]?.messages.at(-1) as {
    role?: string;
    toolName?: string;
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  assert.equal(returnedToolResult.role, "toolResult");
  assert.equal(returnedToolResult.toolName, "review_note");
  assert.equal(returnedToolResult.isError, false);
  assert.equal(returnedToolResult.content?.[0]?.text, "reviewed: README.md");

  const storedMessages = sessionTree.buildContext().messages;
  assert.deepEqual(storedMessages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.match(storedMessages[1]?.content ?? "", /"name":"review_note"/);
  assert.match(storedMessages[2]?.content ?? "", /"toolCallId":"call_1"/);
  assert.match(storedMessages[2]?.content ?? "", /reviewed: README\.md/);
  assert.match(storedMessages[3]?.content ?? "", /Review complete\./);
  assert.deepEqual(runtime.getState(), {
    sessionId: "s13-package",
    turns: 1,
    messageCount: 4,
    lastAssistantText: "Review complete.",
  });
});

test("an extension tool_call hook blocks dispatch and returns the structured error to the provider", async () => {
  const extensionPath = "/home/me/.pi/agent/extensions/guard.ts";
  let handlerCalls = 0;
  const registry = createToolRegistry([
    {
      name: "write",
      label: "write",
      description: "Write content in memory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      handler() {
        handlerCalls += 1;
        return { toolName: "write", content: "written" };
      },
    },
  ]);
  const guard: MiniExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "write") {
        return { block: true, reason: "writes are disabled" };
      }
    });
  };
  let structuredError: unknown;
  const provider: EventProvider = {
    stream(context) {
      const lastMessage = context.messages.at(-1) as { role?: string } | undefined;
      if (lastMessage?.role === "toolResult") {
        structuredError = lastMessage;
        return createTextProvider(["The write was blocked."]).stream(context);
      }
      return createToolCallProvider("write", { path: "/repo/out.txt", content: "no" }).stream(context);
    },
  };
  const runtime = await createIntegratedHarnessRuntime({
    files: { [extensionPath]: "export default function guard() {}" },
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: registry,
    userExtensionPaths: [extensionPath],
    extensionFactories: { [extensionPath]: guard },
  });

  const result = await runtime.prompt("Write a file");

  assert.equal(handlerCalls, 0);
  assert.equal(result.finalText, "The write was blocked.");
  assert.deepEqual(structuredError, {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "write",
    content: [{ type: "text", text: "writes are disabled" }],
    isError: true,
    timestamp: (structuredError as { timestamp?: number }).timestamp,
  });
  assert.equal(typeof (structuredError as { timestamp?: unknown }).timestamp, "number");
});

test("declined trust excludes project packages and direct extensions while user package resources remain", async () => {
  const userPackage = "/packages/user-review";
  const projectPackage = "/packages/project-review";
  const userExtensionPath = `${userPackage}/extensions/user.ts`;
  const projectPackageExtensionPath = `${projectPackage}/extensions/project.ts`;
  const projectDirectExtensionPath = "/repo/.pi/extensions/direct.ts";
  const files = {
    [`${userPackage}/package.json`]: JSON.stringify(
      createPackageManifest("user-review", {
        extensions: ["extensions/user.ts"],
        skills: ["skills/user/SKILL.md"],
      }),
    ),
    [userExtensionPath]: "export default function user() {}",
    [`${userPackage}/skills/user/SKILL.md`]: [
      "---",
      "name: user-review",
      "description: User review instructions.",
      "---",
      "User skill body.",
    ].join("\n"),
    [`${projectPackage}/package.json`]: JSON.stringify(
      createPackageManifest("project-review", {
        extensions: ["extensions/project.ts"],
        skills: ["skills/project/SKILL.md"],
      }),
    ),
    [projectPackageExtensionPath]: "export default function project() {}",
    [`${projectPackage}/skills/project/SKILL.md`]: [
      "---",
      "name: project-review",
      "description: Project review instructions.",
      "---",
      "Project skill body.",
    ].join("\n"),
    [projectDirectExtensionPath]: "export default function direct() {}",
  };
  let userFactoryLoads = 0;
  let projectPackageFactoryLoads = 0;
  let projectDirectFactoryLoads = 0;
  const registerNamedTool = (name: string): MiniExtensionFactory => (pi) => {
    pi.registerTool({
      name,
      label: name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      handler() {
        return { toolName: name, content: name };
      },
    });
  };
  const userFactory: MiniExtensionFactory = (pi) => {
    userFactoryLoads += 1;
    registerNamedTool("user_tool")(pi);
  };
  const projectPackageFactory: MiniExtensionFactory = (pi) => {
    projectPackageFactoryLoads += 1;
    registerNamedTool("project_package_tool")(pi);
  };
  const projectDirectFactory: MiniExtensionFactory = (pi) => {
    projectDirectFactoryLoads += 1;
    registerNamedTool("project_direct_tool")(pi);
  };
  let providerContext: ProviderContext | undefined;
  const provider: EventProvider = {
    stream(context) {
      providerContext = { ...context, messages: [...context.messages], tools: [...context.tools] };
      return createTextProvider(["User resources only."]).stream(context);
    },
  };
  const runtime = await createIntegratedHarnessRuntime({
    files,
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
    userPackages: [userPackage],
    projectPackages: [projectPackage],
    extensionFactories: {
      [userExtensionPath]: userFactory,
      [projectPackageExtensionPath]: projectPackageFactory,
      [projectDirectExtensionPath]: projectDirectFactory,
    },
    trust: { trustOverride: false },
  });

  await runtime.prompt("Show available resources");

  assert.equal(userFactoryLoads, 1);
  assert.equal(projectPackageFactoryLoads, 0);
  assert.equal(projectDirectFactoryLoads, 0);
  assert.equal(providerContext?.tools.some((tool) => tool.name === "user_tool"), true);
  assert.equal(providerContext?.tools.some((tool) => tool.name === "project_package_tool"), false);
  assert.equal(providerContext?.tools.some((tool) => tool.name === "project_direct_tool"), false);
  assert.match(providerContext?.systemPrompt ?? "", /<name>user-review<\/name>/);
  assert.doesNotMatch(providerContext?.systemPrompt ?? "", /<name>project-review<\/name>/);
});

test("print, JSON, RPC, and SDK shells share one integrated runtime and session state", async () => {
  const provider: EventProvider = {
    stream(context) {
      const latestUser = [...context.messages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "user") as { content?: string } | undefined;
      return createTextProvider([`answer: ${latestUser?.content ?? ""}`]).stream(context);
    },
  };
  const sessionTree = createSessionTree({ id: "s13-modes", cwd: "/repo", now: () => "2026-07-12T00:00:00.000Z" });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
    sessionTree,
  });

  assert.equal(await runPrintMode(runtime, "from print"), "answer: from print");

  const jsonEvents = (await runJsonMode(runtime, "from json"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as MiniRuntimeEvent);
  assert.deepEqual(jsonEvents.map((event) => event.type), ["session", "agent_start", "message", "agent_end"]);
  const lastJsonEvent = jsonEvents.at(-1);
  assert.equal(lastJsonEvent?.type === "agent_end" ? lastJsonEvent.finalText : undefined, "answer: from json");

  const rpcPrompt = await runRpcMode(runtime, { id: "prompt", type: "prompt", message: "from rpc" });
  assert.equal(rpcPrompt.data.finalText, "answer: from rpc");

  const sdkEvents: MiniRuntimeEvent[] = [];
  const sdk = createSdkSession(runtime);
  const unsubscribe = sdk.subscribe((event) => sdkEvents.push(event));
  const sdkResult = await sdk.prompt("from sdk");
  unsubscribe();
  assert.equal(sdkResult.finalText, "answer: from sdk");
  assert.deepEqual(sdkEvents.map((event) => event.type), ["session", "agent_start", "message", "agent_end"]);

  const expectedState = {
    sessionId: "s13-modes",
    turns: 4,
    messageCount: 8,
    lastAssistantText: "answer: from sdk",
  };
  assert.deepEqual(runtime.getState(), expectedState);
  assert.deepEqual(sdk.getState(), expectedState);
  assert.deepEqual((await runRpcMode(runtime, { id: "state", type: "get_state" })).data, expectedState);
  assert.equal(sdkResult.messages.length, 8);
  assert.deepEqual(sessionTree.buildContext().messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

test("concurrent prompts are serialized so run ids and session branches stay ordered", async () => {
  const provider: EventProvider = {
    stream(context) {
      const latestUser = [...context.messages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "user") as { content?: string } | undefined;
      return createTextProvider([`answer: ${latestUser?.content ?? ""}`]).stream(context);
    },
  };
  const sessionTree = createSessionTree({ id: "s13-concurrent", cwd: "/repo" });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
    sessionTree,
  });

  const [first, second] = await Promise.all([
    runtime.prompt("first"),
    runtime.prompt("second"),
  ]);

  assert.equal(first.runId, "s13-concurrent:1");
  assert.equal(second.runId, "s13-concurrent:2");
  assert.deepEqual(sessionTree.buildContext().messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  assert.deepEqual(runtime.getState(), {
    sessionId: "s13-concurrent",
    turns: 2,
    messageCount: 4,
    lastAssistantText: "answer: second",
  });
});

test("a rejected prompt does not poison later prompts waiting in the queue", async () => {
  let providerCalls = 0;
  const provider: EventProvider = {
    stream(context) {
      providerCalls += 1;
      if (providerCalls === 1) {
        return (async function* fail(): AsyncIterable<never> {
          throw new Error("provider failed");
        })();
      }
      return createTextProvider(["recovered"]).stream(context);
    },
  };
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
  });

  const [failed, recovered] = await Promise.allSettled([
    runtime.prompt("fail"),
    runtime.prompt("continue"),
  ]);

  assert.equal(failed.status, "rejected");
  assert.match(String(failed.status === "rejected" ? failed.reason : ""), /provider failed/);
  assert.equal(recovered.status, "fulfilled");
  assert.equal(recovered.status === "fulfilled" ? recovered.value.finalText : "", "recovered");
  assert.equal(providerCalls, 2);
});

test("completed assistant and tool-result messages stay auditable when the follow-up provider call fails", async () => {
  let providerCalls = 0;
  let sideEffects = 0;
  const provider: EventProvider = {
    stream(context) {
      providerCalls += 1;
      if (providerCalls === 1) {
        return createToolCallProvider("side_effect", { value: "written" }).stream(context);
      }
      return (async function* fail(): AsyncIterable<never> {
        throw new Error("follow-up provider failed");
      })();
    },
  };
  const registry = createToolRegistry([
    {
      name: "side_effect",
      label: "side_effect",
      description: "Record one deterministic side effect.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      handler(input) {
        sideEffects += 1;
        return { toolName: "side_effect", content: `stored: ${String(input.value)}` };
      },
    },
  ]);
  const sessionTree = createSessionTree({ id: "s13-audit", cwd: "/repo" });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: registry,
    sessionTree,
  });

  await assert.rejects(() => runtime.prompt("perform side effect"), /follow-up provider failed/);

  assert.equal(sideEffects, 1);
  const storedMessages = sessionTree.buildContext().messages;
  assert.deepEqual(storedMessages.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.match(storedMessages[1]?.content ?? "", /"name":"side_effect"/);
  assert.match(storedMessages[2]?.content ?? "", /"toolCallId":"call_1"/);
  assert.match(storedMessages[2]?.content ?? "", /stored: written/);
  assert.deepEqual(runtime.getState(), {
    sessionId: "s13-audit",
    turns: 0,
    messageCount: 3,
  });
});

test("trusted direct project extensions load child index entrypoints without treating helpers as extensions", async () => {
  const indexPath = "/repo/.pi/extensions/sub/index.ts";
  const helperPath = "/repo/.pi/extensions/sub/helper.ts";
  let factoryLoads = 0;
  const factory: MiniExtensionFactory = (pi) => {
    factoryLoads += 1;
    pi.registerTool({
      name: "project_index",
      label: "project_index",
      description: "Tool registered by a child extension index.",
      parameters: { type: "object", properties: {} },
      handler() {
        return { toolName: "project_index", content: "project index" };
      },
    });
  };
  let providerContext: ProviderContext | undefined;
  const provider: EventProvider = {
    stream(context) {
      providerContext = { ...context, messages: [...context.messages], tools: [...context.tools] };
      return createTextProvider(["Project extension loaded."]).stream(context);
    },
  };
  const runtime = await createIntegratedHarnessRuntime({
    files: {
      [indexPath]: "export default function extension() {}",
      [helperPath]: "export function helper() {}",
    },
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    provider,
    baseRegistry: createDemoToolRegistry(),
    extensionFactories: { [indexPath]: factory },
    trust: { trustOverride: true },
  });

  const result = await runtime.prompt("Use project extensions");

  assert.equal(result.finalText, "Project extension loaded.");
  assert.equal(factoryLoads, 1);
  assert.equal(providerContext?.tools.some((tool) => tool.name === "project_index"), true);
});
