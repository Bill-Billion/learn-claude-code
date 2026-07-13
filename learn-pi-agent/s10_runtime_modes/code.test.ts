import assert from "node:assert/strict";
import test from "node:test";

import {
  createMiniCoreRuntime,
  createSdkSession,
  runInteractiveMode,
  runJsonMode,
  runPrintMode,
  runRpcMode,
  type MiniRunResult,
  type MiniRuntime,
} from "./code.ts";

test("print, json, rpc, and sdk modes all drive the same core runtime", async () => {
  const runtime = createMiniCoreRuntime({ sessionId: "s10" });

  assert.equal(await runPrintMode(runtime, "from print"), "mini pi: from print");

  const jsonLines = await runJsonMode(runtime, "from json");
  const jsonEvents = jsonLines.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(jsonEvents.at(-1)?.finalText, "mini pi: from json");

  const rpcResult = await runRpcMode(runtime, { id: "rpc-1", type: "prompt", message: "from rpc" });
  assert.equal(rpcResult.success, true);
  assert.equal(rpcResult.data.finalText, "mini pi: from rpc");

  const sdk = createSdkSession(runtime);
  const sdkResult = await sdk.prompt("from sdk");
  assert.equal(sdkResult.finalText, "mini pi: from sdk");

  assert.deepEqual(runtime.getState(), {
    sessionId: "s10",
    turns: 4,
    messageCount: 8,
    lastAssistantText: "mini pi: from sdk",
  });
  assert.deepEqual(runtime.getPrompts(), ["from print", "from json", "from rpc", "from sdk"]);
});

test("json mode serializes the core event stream instead of inventing another result shape", async () => {
  const runtime = createMiniCoreRuntime({ sessionId: "json-demo" });
  const lines = await runJsonMode(runtime, "show events");

  const events = lines.trimEnd().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(events.map((event) => event.type), [
    "session",
    "agent_start",
    "message",
    "agent_end",
  ]);
  assert.equal(events[0].sessionId, "json-demo");
  assert.equal(events[2].role, "assistant");
  assert.equal(events[2].content, "mini pi: show events");
});

test("rpc mode accepts commands and can query the same runtime state", async () => {
  const runtime = createMiniCoreRuntime({ sessionId: "rpc-demo" });

  const accepted = await runRpcMode(runtime, { id: "one", type: "prompt", message: "status" });
  const state = await runRpcMode(runtime, { id: "two", type: "get_state" });

  assert.equal(accepted.type, "response");
  assert.equal(accepted.command, "prompt");
  assert.equal(accepted.success, true);
  assert.equal(state.success, true);
  assert.deepEqual(state.data, {
    sessionId: "rpc-demo",
    turns: 1,
    messageCount: 2,
    lastAssistantText: "mini pi: status",
  });
});

test("interactive mode is only a terminal transcript around the same prompt method", async () => {
  const runtime = createMiniCoreRuntime({ sessionId: "interactive-demo" });

  const transcript = await runInteractiveMode(runtime, ["one", "two"]);

  assert.deepEqual(transcript, [
    "user> one",
    "assistant> mini pi: one",
    "user> two",
    "assistant> mini pi: two",
  ]);
  assert.deepEqual(runtime.getPrompts(), ["one", "two"]);
});

test("every mode accepts the minimal runtime contract instead of requiring MiniCoreRuntime", async () => {
  let turns = 0;
  const runtime: MiniRuntime = {
    async prompt(prompt: string): Promise<MiniRunResult> {
      turns += 1;
      const sessionId = "interface-runtime";
      const runId = `${sessionId}:${turns}`;
      const finalText = `interface: ${prompt}`;
      return {
        sessionId,
        runId,
        finalText,
        events: [
          { type: "session", sessionId, runId },
          { type: "agent_start", sessionId, runId, prompt },
          { type: "message", sessionId, runId, role: "assistant", content: finalText },
          { type: "agent_end", sessionId, runId, finalText },
        ],
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: finalText },
        ],
      };
    },
    getState() {
      return { sessionId: "interface-runtime", turns, messageCount: turns * 2 };
    },
  };

  assert.equal(await runPrintMode(runtime, "print"), "interface: print");
  assert.match(await runJsonMode(runtime, "json"), /interface: json/);
  assert.equal((await runRpcMode(runtime, { type: "prompt", message: "rpc" })).data.finalText, "interface: rpc");
  assert.equal((await createSdkSession(runtime).prompt("sdk")).finalText, "interface: sdk");
  assert.deepEqual(await runInteractiveMode(runtime, ["interactive"]), [
    "user> interactive",
    "assistant> interface: interactive",
  ]);
});
