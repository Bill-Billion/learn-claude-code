import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../s02_tool_schema/code.ts";
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
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";
import { createIntegratedHarnessRuntime } from "./code.ts";

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
      return { toolName: "read_file", content: `contents:${String(input.path)}` };
    },
  }]);
}

test("real model, package resources, extension tools, context, and AgentMessage sessions compose end to end", async (t) => {
  const packageRoot = "/packages/review";
  const extensionPath = `${packageRoot}/extensions/review.ts`;
  const skillPath = `${packageRoot}/skills/review/SKILL.md`;
  const promptPath = `${packageRoot}/prompts/review.md`;
  const files = {
    "/repo/AGENTS.md": "Project rule: verify before reporting.",
    [`${packageRoot}/package.json`]: JSON.stringify(
      createPackageManifest("review-pack", {
        extensions: ["extensions/review.ts"],
        skills: ["skills/review/SKILL.md"],
        prompts: ["prompts/review.md"],
      }),
    ),
    [extensionPath]: "export default reviewExtension",
    [skillPath]: "---\nname: review\ndescription: Review before reporting.\n---\nRead changed files.",
    [promptPath]: "---\ndescription: Review a target.\n---\nReview $ARGUMENTS.",
  };
  let toolCalls = 0;
  let firstSystemPrompt = "";
  let firstTools: string[] = [];
  let returnedToolResult: unknown;
  const faux = setupFauxProvider([
    (context) => {
      firstSystemPrompt = context.systemPrompt ?? "";
      firstTools = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage([fauxToolCall("review_note", { path: "README.md" })], {
        stopReason: "toolUse",
      });
    },
    (context) => {
      returnedToolResult = context.messages.at(-1);
      return fauxAssistantMessage([fauxText("Review complete.")]);
    },
  ]);
  t.after(() => faux.unregister());
  const extensionFactory: MiniExtensionFactory = (pi) => {
    pi.registerTool({
      name: "review_note",
      description: "Record a reviewed file.",
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
  const session = createSessionTree({
    id: "s13-package",
    cwd: "/repo",
    now: () => "2026-07-12T00:00:00.000Z",
  });
  const runtime = await createIntegratedHarnessRuntime({
    files,
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    model: faux.getModel(),
    registry: createReadRegistry(),
    session,
    userPackages: [packageRoot],
    extensionFactories: { [extensionPath]: extensionFactory },
  });

  const result = await runtime.prompt("Review README.md");

  assert.equal(result.finalText, "Review complete.");
  assert.equal(toolCalls, 1);
  assert.match(firstSystemPrompt, /Project rule: verify before reporting\./);
  assert.match(firstSystemPrompt, /<name>review<\/name>/);
  assert.doesNotMatch(firstSystemPrompt, /Review \$ARGUMENTS\./);
  assert.deepEqual(firstTools, ["read_file", "review_note"]);
  assert.equal((returnedToolResult as { role?: string }).role, "toolResult");
  assert.equal((returnedToolResult as { toolName?: string }).toolName, "review_note");
  assert.equal((returnedToolResult as { isError?: boolean }).isError, false);

  const storedMessages = session.buildContext().messages;
  assert.deepEqual(storedMessages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  const assistantToolCall = storedMessages[1];
  const toolResult = storedMessages[2];
  assert.ok(assistantToolCall?.role === "assistant");
  assert.ok(toolResult?.role === "toolResult");
  assert.equal(assistantToolCall.content[0]?.type === "toolCall" ? assistantToolCall.content[0].name : "", "review_note");
  assert.equal(toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "", "reviewed: README.md");
  assert.deepEqual(runtime.getState(), {
    sessionId: "s13-package",
    turns: 1,
    messageCount: 4,
    lastAssistantText: "Review complete.",
  });
});

test("explicit prompt template invocation expands into a queued real turn", async (t) => {
  const packageRoot = "/packages/prompts";
  const promptPath = `${packageRoot}/prompts/review.md`;
  const files = {
    [`${packageRoot}/package.json`]: JSON.stringify(createPackageManifest("prompt-pack", {
      prompts: ["prompts/review.md"],
    })),
    [promptPath]: "---\ndescription: Review a target.\n---\nReview $1 with $ARGUMENTS.",
  };
  const seenUserPrompts: string[] = [];
  const seenSystemPrompts: string[] = [];
  const faux = setupFauxProvider([
    (context) => {
      const message = context.messages.at(-1);
      seenUserPrompts.push(message?.role === "user" && typeof message.content === "string" ? message.content : "");
      seenSystemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage([fauxText("Normal turn complete.")]);
    },
    (context) => {
      const message = context.messages.at(-1);
      seenUserPrompts.push(message?.role === "user" && typeof message.content === "string" ? message.content : "");
      seenSystemPrompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage([fauxText("Template turn complete.")]);
    },
  ]);
  t.after(() => faux.unregister());
  const session = createSessionTree({ id: "s13-prompts", cwd: "/repo" });
  const runtime = await createIntegratedHarnessRuntime({
    files,
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    model: faux.getModel(),
    registry: createReadRegistry(),
    session,
    userPackages: [packageRoot],
  });

  const [normal, invoked] = await Promise.all([
    runtime.prompt("Normal prompt"),
    runtime.invokePromptTemplate("review", ["README.md", "carefully"]),
  ]);

  assert.equal(normal.runId, "s13-prompts:1");
  assert.equal(invoked.runId, "s13-prompts:2");
  assert.equal(invoked.finalText, "Template turn complete.");
  assert.deepEqual(seenUserPrompts, [
    "Normal prompt",
    "Review README.md with README.md carefully.",
  ]);
  assert.equal(seenSystemPrompts.every((prompt) => !prompt.includes("Review $1 with $ARGUMENTS.")), true);
  assert.deepEqual(runtime.getState(), {
    sessionId: "s13-prompts",
    turns: 2,
    messageCount: 4,
    lastAssistantText: "Template turn complete.",
  });
});

test("declined trust excludes project packages and direct extensions while user package resources remain", async (t) => {
  const userPackage = "/packages/user-review";
  const projectPackage = "/repo/.pi/packages/project-review";
  const userExtensionPath = `${userPackage}/extensions/user.ts`;
  const projectPackageExtensionPath = `${projectPackage}/extensions/project.ts`;
  const projectDirectExtensionPath = "/repo/.pi/extensions/direct.ts";
  const files = {
    "/repo/.pi/settings.json": "{}",
    [`${userPackage}/package.json`]: JSON.stringify(createPackageManifest("user-review", {
      extensions: ["extensions/user.ts"],
      skills: ["skills/user/SKILL.md"],
    })),
    [userExtensionPath]: "export default userExtension",
    [`${userPackage}/skills/user/SKILL.md`]: "---\nname: user-review\ndescription: User review.\n---\nUser rules.",
    [`${projectPackage}/package.json`]: JSON.stringify(createPackageManifest("project-review", {
      extensions: ["extensions/project.ts"],
      skills: ["skills/project/SKILL.md"],
    })),
    [projectPackageExtensionPath]: "export default projectExtension",
    [`${projectPackage}/skills/project/SKILL.md`]: "---\nname: project-review\ndescription: Project review.\n---\nProject rules.",
    [projectDirectExtensionPath]: "export default directExtension",
  };
  let userFactoryLoads = 0;
  let projectPackageFactoryLoads = 0;
  let projectDirectFactoryLoads = 0;
  let providerSystemPrompt = "";
  let providerTools: string[] = [];
  const faux = setupFauxProvider([
    (context) => {
      providerSystemPrompt = context.systemPrompt ?? "";
      providerTools = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage([fauxText("User resources only.")]);
    },
  ]);
  t.after(() => faux.unregister());
  const namedFactory = (name: string, loaded: () => void): MiniExtensionFactory => (pi) => {
    loaded();
    pi.registerTool({
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      handler: () => ({ toolName: name, content: name }),
    });
  };
  const runtime = await createIntegratedHarnessRuntime({
    files,
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    model: faux.getModel(),
    registry: createReadRegistry(),
    userPackages: [userPackage],
    projectPackages: [projectPackage],
    extensionFactories: {
      [userExtensionPath]: namedFactory("user_tool", () => userFactoryLoads += 1),
      [projectPackageExtensionPath]: namedFactory("project_package_tool", () => projectPackageFactoryLoads += 1),
      [projectDirectExtensionPath]: namedFactory("project_direct_tool", () => projectDirectFactoryLoads += 1),
    },
    trust: { trustOverride: false },
  });

  await runtime.prompt("Show available resources");

  assert.equal(runtime.projectTrusted, false);
  assert.equal(userFactoryLoads, 1);
  assert.equal(projectPackageFactoryLoads, 0);
  assert.equal(projectDirectFactoryLoads, 0);
  assert.equal(providerTools.includes("user_tool"), true);
  assert.equal(providerTools.includes("project_package_tool"), false);
  assert.equal(providerTools.includes("project_direct_tool"), false);
  assert.match(providerSystemPrompt, /<name>user-review<\/name>/);
  assert.doesNotMatch(providerSystemPrompt, /<name>project-review<\/name>/);
});

test("print, JSON, RPC, and SDK shells share one real integrated runtime and session", async (t) => {
  const faux = setupFauxProvider(["print", "json", "rpc", "sdk"].map((label) =>
    fauxAssistantMessage([fauxText(`answer: ${label}`)]),
  ));
  t.after(() => faux.unregister());
  const session = createSessionTree({ id: "s13-modes", cwd: "/repo" });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    model: faux.getModel(),
    registry: createReadRegistry(),
    session,
  });

  assert.equal(await runPrintMode(runtime, "from print"), "answer: print");
  const jsonEvents = (await runJsonMode(runtime, "from json"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as MiniRuntimeEvent);
  assert.equal(jsonEvents[0]?.type, "agent_start");
  assert.equal(jsonEvents.at(-1)?.type, "agent_end");

  const rpcPrompt = await runRpcMode(runtime, { id: "prompt", type: "prompt", message: "from rpc" });
  assert.ok(rpcPrompt.success);
  assert.equal(rpcPrompt.data.finalText, "answer: rpc");

  const sdkEvents: MiniRuntimeEvent[] = [];
  const sdk = createSdkSession(runtime);
  const unsubscribe = sdk.subscribe((event) => sdkEvents.push(event));
  const sdkResult = await sdk.prompt("from sdk");
  unsubscribe();
  assert.equal(sdkResult.finalText, "answer: sdk");
  assert.equal(sdkEvents[0]?.type, "agent_start");
  assert.equal(sdkEvents.at(-1)?.type, "agent_end");

  const expectedState = {
    sessionId: "s13-modes",
    turns: 4,
    messageCount: 8,
    lastAssistantText: "answer: sdk",
  };
  assert.deepEqual(runtime.getState(), expectedState);
  assert.deepEqual(sdk.getState(), expectedState);
  assert.deepEqual((await runRpcMode(runtime, { id: "state", type: "get_state" })).data, expectedState);
  assert.equal(sdkResult.messages.length, 8);
  assert.deepEqual(session.buildContext().messages.map((message) => message.role), [
    "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant",
  ]);
});

test("concurrent prompts are serialized around the shared real session", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxText("answer: first")]),
    fauxAssistantMessage([fauxText("answer: second")]),
  ]);
  t.after(() => faux.unregister());
  const session = createSessionTree({ id: "s13-concurrent", cwd: "/repo" });
  const runtime = await createIntegratedHarnessRuntime({
    files: {},
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    model: faux.getModel(),
    registry: createReadRegistry(),
    session,
  });

  const [first, second] = await Promise.all([runtime.prompt("first"), runtime.prompt("second")]);

  assert.equal(first.runId, "s13-concurrent:1");
  assert.equal(second.runId, "s13-concurrent:2");
  assert.equal(first.finalText, "answer: first");
  assert.equal(second.finalText, "answer: second");
  assert.deepEqual(session.buildContext().messages.map((message) => message.role), [
    "user", "assistant", "user", "assistant",
  ]);
});

test("trusted direct project extension discovery loads an index entrypoint but not its helper", async (t) => {
  const indexPath = "/repo/.pi/extensions/sub/index.ts";
  const helperPath = "/repo/.pi/extensions/sub/helper.ts";
  let factoryLoads = 0;
  let providerTools: string[] = [];
  const faux = setupFauxProvider([
    (context) => {
      providerTools = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage([fauxText("Project extension loaded.")]);
    },
  ]);
  t.after(() => faux.unregister());
  const factory: MiniExtensionFactory = (pi) => {
    factoryLoads += 1;
    pi.registerTool({
      name: "project_index",
      description: "Tool registered by the extension index.",
      parameters: { type: "object", properties: {} },
      handler: () => ({ toolName: "project_index", content: "project index" }),
    });
  };
  const runtime = await createIntegratedHarnessRuntime({
    files: {
      [indexPath]: "export default extension",
      [helperPath]: "export function helper() {}",
    },
    cwd: "/repo",
    agentDir: "/home/me/.pi/agent",
    model: faux.getModel(),
    registry: createReadRegistry(),
    extensionFactories: { [indexPath]: factory },
    trust: { trustOverride: true },
  });

  assert.equal(await runPrintMode(runtime, "Use project extensions"), "Project extension loaded.");
  assert.equal(factoryLoads, 1);
  assert.equal(providerTools.includes("project_index"), true);
});
