import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../s02_tool_schema/code.ts";
import { createMemorySession } from "../s06_turn_state/code.ts";
import { createSessionTree } from "../s07_session_tree/code.ts";
import { loadMiniExtensions } from "../s09_extension_runtime/code.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";
import {
  createMiniCoreRuntime,
  createSdkSession,
  runInteractiveMode,
  runJsonMode,
  runPrintMode,
  runRpcMode,
} from "./code.ts";

async function createRuntime(
  t: { after(callback: () => void): void },
  responses: Parameters<typeof setupFauxProvider>[0],
) {
  const faux = setupFauxProvider(responses);
  t.after(() => faux.unregister());
  let reads = 0;
  const runtime = await createMiniCoreRuntime({
    runner: await loadMiniExtensions([]),
    source: { readText: () => undefined },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createMemorySession("s10-real-runtime"),
    model: faux.getModel(),
    registry: createToolRegistry([{
      name: "read_file",
      description: "Read a course file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler(input) {
        reads += 1;
        return { toolName: "read_file", content: `contents of ${String(input.path)}` };
      },
    }]),
  });
  return { runtime, get reads() { return reads; } };
}

test("print, json, rpc, and sdk modes drive one cumulative real agent runtime", async (t) => {
  const setup = await createRuntime(t, [
    fauxAssistantMessage([fauxToolCall("read_file", { path: "README.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Print used the real file result.")]),
    fauxAssistantMessage([fauxText("JSON used the real model.")]),
    fauxAssistantMessage([fauxText("RPC used the real model.")]),
    fauxAssistantMessage([fauxText("SDK used the real model.")]),
  ]);

  assert.equal(await runPrintMode(setup.runtime, "from print"), "Print used the real file result.");

  const jsonLines = await runJsonMode(setup.runtime, "from json");
  const jsonEvents = jsonLines.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(jsonEvents[0]?.type, "agent_start");
  assert.equal(jsonEvents.at(-1)?.type, "agent_end");

  const rpcResult = await runRpcMode(setup.runtime, { id: "rpc-1", type: "prompt", message: "from rpc" });
  assert.ok(rpcResult.success);
  assert.equal(rpcResult.data.finalText, "RPC used the real model.");

  const sdk = createSdkSession(setup.runtime);
  const observed: string[] = [];
  const observedCompletedRuns: number[] = [];
  sdk.subscribe((event) => {
    observed.push(event.type);
    observedCompletedRuns.push(setup.runtime.getRuns().length);
  });
  const sdkResult = await sdk.prompt("from sdk");
  assert.equal(sdkResult.finalText, "SDK used the real model.");
  assert.equal(observed[0], "agent_start");
  assert.equal(observed.at(-1), "agent_end");
  assert.deepEqual(new Set(observedCompletedRuns), new Set([3]));

  assert.equal(setup.reads, 1);
  assert.deepEqual(setup.runtime.getState(), {
    sessionId: "s10-real-runtime",
    turns: 4,
    messageCount: 10,
    lastAssistantText: "SDK used the real model.",
  });
  assert.deepEqual(setup.runtime.getPrompts(), ["from print", "from json", "from rpc", "from sdk"]);
});

test("json mode serializes the real lifecycle event stream", async (t) => {
  const { runtime } = await createRuntime(t, [
    fauxAssistantMessage([fauxText("Lifecycle complete.")]),
  ]);

  const events = (await runJsonMode(runtime, "show events"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(events.map((event) => event.type), [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
  const finalMessage = events.find((event) => event.type === "message_end")?.message;
  assert.equal(finalMessage.content[0].text, "Lifecycle complete.");
});

test("rpc state and interactive transcript reflect actual accumulated turns", async (t) => {
  const { runtime } = await createRuntime(t, [
    fauxAssistantMessage([fauxText("RPC status complete.")]),
    fauxAssistantMessage([fauxText("Interactive one.")]),
    fauxAssistantMessage([fauxText("Interactive two.")]),
  ]);

  const accepted = await runRpcMode(runtime, { id: "one", type: "prompt", message: "status" });
  const state = await runRpcMode(runtime, { id: "two", type: "get_state" });
  assert.ok(accepted.success);
  assert.equal(accepted.data.finalText, "RPC status complete.");
  assert.deepEqual(state.data, {
    sessionId: "s10-real-runtime",
    turns: 1,
    messageCount: 2,
    lastAssistantText: "RPC status complete.",
  });

  assert.deepEqual(await runInteractiveMode(runtime, ["one", "two"]), [
    "user> one",
    "assistant> Interactive one.",
    "user> two",
    "assistant> Interactive two.",
  ]);
  assert.equal(runtime.getState().turns, 3);
});

test("the runtime factory initializes state from a preloaded session", async (t) => {
  const faux = setupFauxProvider([]);
  t.after(() => faux.unregister());
  const session = createMemorySession("s10-preloaded", [
    { role: "user", content: "Earlier prompt", timestamp: 1 },
    fauxAssistantMessage([fauxText("Earlier answer")]),
  ]);

  const runtime = await createMiniCoreRuntime({
    runner: await loadMiniExtensions([]),
    source: { readText: () => undefined },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
  });

  assert.deepEqual(runtime.getState(), {
    sessionId: "s10-preloaded",
    turns: 1,
    messageCount: 2,
    lastAssistantText: "Earlier answer",
  });
  assert.deepEqual(runtime.getMessages().map((message) => message.role), ["user", "assistant"]);
});

test("prompt numbering stays monotonic when the active session branch gets shorter", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxText("First branch answer.")]),
    fauxAssistantMessage([fauxText("Fresh branch answer.")]),
  ]);
  t.after(() => faux.unregister());
  const session = createSessionTree({ id: "s10-branching", cwd: "/work/app" });
  const runtime = await createMiniCoreRuntime({
    runner: await loadMiniExtensions([]),
    source: { readText: () => undefined },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session,
    model: faux.getModel(),
    registry: createToolRegistry([]),
  });

  const first = await runtime.prompt("first branch");
  session.resetLeaf();
  const second = await runtime.prompt("fresh branch");

  assert.equal(first.runId, "s10-branching:1");
  assert.equal(second.runId, "s10-branching:2");
  assert.deepEqual(runtime.getState(), {
    sessionId: "s10-branching",
    turns: 2,
    messageCount: 2,
    lastAssistantText: "Fresh branch answer.",
  });
});

test("RPC converts provider failure to an error response and refreshes partial session state", async (t) => {
  const setup = await createRuntime(t, [
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" }),
    fauxAssistantMessage([fauxText("Recovered on the next prompt.")]),
  ]);

  const failed = await runRpcMode(setup.runtime, {
    id: "provider-failure",
    type: "prompt",
    message: "fail once",
  });

  assert.deepEqual(failed, {
    id: "provider-failure",
    type: "response",
    command: "prompt",
    success: false,
    error: "provider unavailable",
  });
  assert.equal(setup.runtime.getState().sessionId, "s10-real-runtime");
  assert.equal(setup.runtime.getState().turns, 1);
  assert.equal(setup.runtime.getState().messageCount, 2);
  assert.deepEqual(setup.runtime.getPrompts(), ["fail once"]);
  assert.deepEqual(setup.runtime.getRuns(), []);

  const recovered = await setup.runtime.prompt("continue");
  assert.equal(recovered.runId, "s10-real-runtime:2");
  assert.equal(recovered.finalText, "Recovered on the next prompt.");
  assert.equal(setup.runtime.getState().turns, 2);
  assert.equal(setup.runtime.getState().messageCount, 4);
  assert.deepEqual(setup.runtime.getPrompts(), ["fail once", "continue"]);
  assert.equal(setup.runtime.getRuns().length, 1);
});

test("RPC converts observer failure to an error response without poisoning the next prompt", async (t) => {
  const setup = await createRuntime(t, [
    fauxAssistantMessage([fauxText("Response remains available.")]),
  ]);
  const unsubscribe = setup.runtime.subscribe((event) => {
    if (event.type === "agent_start") throw new Error("observer failed");
  });

  const failed = await runRpcMode(setup.runtime, {
    id: "observer-failure",
    type: "prompt",
    message: "observe",
  });
  unsubscribe();

  assert.deepEqual(failed, {
    id: "observer-failure",
    type: "response",
    command: "prompt",
    success: false,
    error: "observer failed",
  });
  assert.equal(setup.runtime.getState().turns, 1);
  assert.equal(setup.runtime.getState().messageCount, 1);

  const recovered = await setup.runtime.prompt("continue");
  assert.equal(recovered.runId, "s10-real-runtime:2");
  assert.equal(recovered.finalText, "Response remains available.");
});

test("RPC converts tool-loop exhaustion to an error response after refreshing tool results", async (t) => {
  const faux = setupFauxProvider([
    fauxAssistantMessage([fauxToolCall("missing_tool", {})], { stopReason: "toolUse" }),
  ]);
  t.after(() => faux.unregister());
  const runtime = await createMiniCoreRuntime({
    runner: await loadMiniExtensions([]),
    source: { readText: () => undefined },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: createMemorySession("s10-tool-failure"),
    model: faux.getModel(),
    registry: createToolRegistry([]),
    maxTurns: 1,
  });

  const failed = await runRpcMode(runtime, {
    id: "tool-failure",
    type: "prompt",
    message: "call a missing tool",
  });

  assert.equal(failed.success, false);
  assert.match(failed.success ? "" : failed.error, /maximum of 1 model turn/);
  assert.equal(runtime.getState().turns, 1);
  assert.equal(runtime.getState().messageCount, 3);
  assert.deepEqual(runtime.getMessages().map((message) => message.role), ["user", "assistant", "toolResult"]);
});

test("RPC returns the same failure shape for unknown commands", async (t) => {
  const setup = await createRuntime(t, []);

  const response = await runRpcMode(setup.runtime, {
    id: "unknown-command",
    type: "not_a_command",
  } as never);

  assert.deepEqual(response, {
    id: "unknown-command",
    type: "response",
    command: "not_a_command",
    success: false,
    error: "Unknown RPC command",
  });
});

test("a failed state refresh never replaces the original prompt error", async (t) => {
  let failRefresh = false;
  const faux = setupFauxProvider([
    () => {
      failRefresh = true;
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "original provider error" });
    },
  ]);
  t.after(() => faux.unregister());
  const messages: Parameters<typeof createMemorySession>[1] = [];
  const runtime = await createMiniCoreRuntime({
    runner: await loadMiniExtensions([]),
    source: { readText: () => undefined },
    cwd: "/work/app",
    agentDir: "/home/me/.pi/agent",
    session: {
      messages,
      appendMessage(message) {
        messages.push(structuredClone(message));
      },
      buildContext() {
        if (failRefresh) throw new Error("refresh failed");
        return { messages: messages.map((message) => structuredClone(message)) };
      },
      getMetadata() {
        return { id: "s10-refresh-failure" };
      },
    },
    model: faux.getModel(),
    registry: createToolRegistry([]),
  });

  await assert.rejects(() => runtime.prompt("fail"), /original provider error/);
});
