import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInitialState } from "../s01_agent_loop/code.ts";
import { createCourseToolRegistry, createToolRegistry } from "../s02_tool_schema/code.ts";
import {
  readTextBlocksFromLastAssistant,
  runEventedToolLoop,
} from "./code.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";

test("s04 wraps the streamed tool loop in ordered agent lifecycle events", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s04-events-"));
  await writeFile(join(courseRoot, "event.txt"), "evented result\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));
  const provider = setupFauxProvider([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "event.txt" }, { id: "call_event" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Evented loop complete."),
  ]);
  t.after(provider.unregister);

  const result = await runEventedToolLoop({
    model: provider.getModel(),
    prompt: "Read event.txt.",
    registry: createCourseToolRegistry(courseRoot),
  });

  assert.deepEqual(result.eventTypes, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "message_start",
    "message_end",
    "turn_end",
    "turn_start",
    "message_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
  assert.deepEqual(result.state.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.state.messages), ["Evented loop complete."]);
});

test("unknown tools become error tool results and the next model turn can recover", async (t) => {
  const provider = setupFauxProvider([
    fauxAssistantMessage(
      fauxToolCall("missing", {}, { id: "call_missing" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Unknown tool: missing/);
      return fauxAssistantMessage("Recovered from the tool error.");
    },
  ]);
  t.after(provider.unregister);

  const result = await runEventedToolLoop({
    model: provider.getModel(),
    prompt: "Call the missing tool.",
    registry: createCourseToolRegistry(process.cwd()),
  });

  assert.equal(result.toolResults[0]?.isError, true);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.state.messages), ["Recovered from the tool error."]);
});

test("multi-tool results keep assistant source order", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s04-batch-"));
  await writeFile(join(courseRoot, "a.txt"), "A\n");
  await writeFile(join(courseRoot, "b.txt"), "B\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));
  const provider = setupFauxProvider([
    fauxAssistantMessage([
      fauxToolCall("read_file", { path: "a.txt" }, { id: "call_a" }),
      fauxToolCall("read_file", { path: "b.txt" }, { id: "call_b" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Read both files."),
  ]);
  t.after(provider.unregister);

  const result = await runEventedToolLoop({
    model: provider.getModel(),
    prompt: "Read both.",
    registry: createCourseToolRegistry(courseRoot),
  });

  assert.deepEqual(result.toolResults.map((message) => message.toolCallId), ["call_a", "call_b"]);
});

test("maximum-turn exhaustion is explicit and still closes the lifecycle", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s04-limit-"));
  await writeFile(join(courseRoot, "loop.txt"), "loop\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "loop.txt" }), { stopReason: "toolUse" }),
  ]);
  t.after(provider.unregister);
  const eventTypes: string[] = [];

  await assert.rejects(
    () => runEventedToolLoop({
      model: provider.getModel(),
      prompt: "Loop.",
      registry: createCourseToolRegistry(courseRoot),
      maxTurns: 1,
      onEvent(event) {
        eventTypes.push(event.type);
      },
    }),
    /maximum of 1 model turn/,
  );
  assert.equal(eventTypes.at(-1), "agent_end");
});

test("agent_end keeps a deep snapshot when the same state runs another prompt", async (t) => {
  const provider = setupFauxProvider([
    fauxAssistantMessage("First answer."),
    fauxAssistantMessage("Second answer."),
  ]);
  t.after(provider.unregister);
  const state = createInitialState();
  const registry = createToolRegistry([]);

  const first = await runEventedToolLoop({
    model: provider.getModel(),
    prompt: "First prompt.",
    registry,
    state,
  });
  const firstAgentEnd = first.events.find((event) => event.type === "agent_end");
  assert.ok(firstAgentEnd?.type === "agent_end");
  const snapshot = structuredClone(firstAgentEnd.messages);

  const second = await runEventedToolLoop({
    model: provider.getModel(),
    prompt: "Second prompt.",
    registry,
    state,
  });
  const secondAgentEnd = second.events.find((event) => event.type === "agent_end");
  assert.ok(secondAgentEnd?.type === "agent_end");

  assert.deepEqual(firstAgentEnd.messages, snapshot);
  assert.equal(firstAgentEnd.messages.length, 2);
  assert.equal(secondAgentEnd.messages.length, 2);
  assert.deepEqual(secondAgentEnd.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(state.messages.length, 4);
});

test("provider errors balance the active turn before agent_end", async (t) => {
  const provider = setupFauxProvider([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed" }),
  ]);
  t.after(provider.unregister);
  const events: string[] = [];

  await assert.rejects(
    () => runEventedToolLoop({
      model: provider.getModel(),
      prompt: "Fail this turn.",
      registry: createToolRegistry([]),
      onEvent(event) {
        events.push(event.type);
      },
    }),
    /provider failed/,
  );

  assert.deepEqual(events.slice(-3), ["message_end", "turn_end", "agent_end"]);
});

test("event observers are awaited in order", async (t) => {
  const provider = setupFauxProvider([fauxAssistantMessage("Done.")]);
  t.after(provider.unregister);
  const observed: string[] = [];
  let observerRunning = false;

  const result = await runEventedToolLoop({
    model: provider.getModel(),
    prompt: "Observe.",
    registry: createToolRegistry([]),
    async onEvent(event) {
      assert.equal(observerRunning, false, `observer overlapped at ${event.type}`);
      observerRunning = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      observed.push(event.type);
      observerRunning = false;
    },
  });

  assert.deepEqual(observed, result.eventTypes);
});

test("an observer failure aborts once without replacing its original error", async (t) => {
  const provider = setupFauxProvider([fauxAssistantMessage("must remain unused")]);
  t.after(provider.unregister);
  let observerCalls = 0;

  await assert.rejects(
    runEventedToolLoop({
      model: provider.getModel(),
      prompt: "Fail at start.",
      registry: createToolRegistry([]),
      onEvent() {
        observerCalls += 1;
        throw new Error("observer failed at agent_start");
      },
    }),
    /observer failed at agent_start/,
  );

  assert.equal(observerCalls, 1);
  assert.equal(provider.state.callCount, 0);
});
