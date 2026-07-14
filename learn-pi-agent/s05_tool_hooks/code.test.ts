import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";

import { createToolRegistry, type ToolParameters } from "../s02_tool_schema/code.ts";
import {
  readTextBlocksFromLastAssistant,
  runHookedToolLoop,
} from "./code.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";

function createCountingRegistry() {
  let calls = 0;
  let lastPath = "";
  const parameters = Type.Object({ path: Type.String() }, { additionalProperties: false });
  const registry = createToolRegistry([{
    name: "read_note",
    label: "read_note",
    description: "Read a note from the test fixture.",
    parameters: parameters as unknown as ToolParameters,
    handler(input) {
      calls += 1;
      lastPath = String(input.path);
      return { toolName: "read_note", content: `read: ${lastPath}` };
    },
  }]);
  return { registry, get calls() { return calls; }, get lastPath() { return lastPath; } };
}

test("beforeToolCall blocks execution but still returns an error result to the model", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", { path: "secret.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("I saw the block."),
  ]);
  t.after(provider.unregister);

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Read the secret.",
    registry: counting.registry,
    hooks: {
      beforeToolCall() {
        return { block: true, reason: "reads are disabled" };
      },
    },
  });

  assert.equal(counting.calls, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.equal(result.toolResults[0]?.content[0]?.type === "text" ? result.toolResults[0].content[0].text : "", "reads are disabled");
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["I saw the block."]);
});

test("hooks can rewrite arguments and the finalized tool result", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", { path: "wrong.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("I saw the audited result."),
  ]);
  t.after(provider.unregister);

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Read a note.",
    registry: counting.registry,
    hooks: {
      beforeToolCall() {
        return { arguments: { path: "approved.txt" } };
      },
      afterToolCall({ result: toolResult }) {
        const text = toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "";
        return { content: [{ type: "text", text: `audited: ${text}` }] };
      },
    },
  });

  assert.equal(counting.calls, 1);
  assert.equal(counting.lastPath, "approved.txt");
  assert.equal(result.toolResults[0]?.content[0]?.type === "text" ? result.toolResults[0].content[0].text : "", "audited: read: approved.txt");
});

test("afterToolCall can terminate before the automatic follow-up model turn", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", { path: "one.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("This response must remain queued."),
  ]);
  t.after(provider.unregister);

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Read once.",
    registry: counting.registry,
    hooks: {
      afterToolCall() {
        return { terminate: true };
      },
    },
  });

  assert.equal(result.terminated, true);
  assert.equal(provider.state.callCount, 1);
  assert.equal(provider.getPendingResponseCount(), 1);
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.equal(result.eventTypes.at(-1), "agent_end");
});

test("an afterToolCall failure preserves the executed result without retrying the tool", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", { path: "once.txt" }), { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.equal(result.isError, true);
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      assert.match(text, /read: once\.txt/);
      assert.match(text, /post-tool hook failed after the tool executed/i);
      assert.match(text, /audit backend unavailable/);
      return fauxAssistantMessage("I saw the post-hook failure.");
    },
  ]);
  t.after(provider.unregister);

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Read once.",
    registry: counting.registry,
    hooks: {
      afterToolCall() {
        throw new Error("audit backend unavailable");
      },
    },
  });

  assert.equal(counting.calls, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["I saw the post-hook failure."]);
});

test("unknown tools become error results without invoking either hook", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("missing", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered from the unknown tool."),
  ]);
  t.after(provider.unregister);
  let beforeCalls = 0;
  let afterCalls = 0;

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Call a missing tool.",
    registry: counting.registry,
    hooks: {
      beforeToolCall() {
        beforeCalls += 1;
      },
      afterToolCall() {
        afterCalls += 1;
      },
    },
  });

  assert.equal(beforeCalls, 0);
  assert.equal(afterCalls, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.match(result.toolResults[0]?.content[0]?.type === "text" ? result.toolResults[0].content[0].text : "", /Unknown tool: missing/);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["Recovered from the unknown tool."]);
});

test("invalid arguments are rejected before hooks and the model can continue", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered from invalid arguments."),
  ]);
  t.after(provider.unregister);
  let beforeCalls = 0;
  let afterCalls = 0;

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Call with invalid arguments.",
    registry: counting.registry,
    hooks: {
      beforeToolCall() {
        beforeCalls += 1;
      },
      afterToolCall() {
        afterCalls += 1;
      },
    },
  });

  assert.equal(counting.calls, 0);
  assert.equal(beforeCalls, 0);
  assert.equal(afterCalls, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["Recovered from invalid arguments."]);
});

test("a beforeToolCall exception becomes an error result and skips afterToolCall", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", { path: "note.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered from the before hook failure."),
  ]);
  t.after(provider.unregister);
  let afterCalls = 0;

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Read a note.",
    registry: counting.registry,
    hooks: {
      beforeToolCall() {
        throw new Error("policy service unavailable");
      },
      afterToolCall() {
        afterCalls += 1;
      },
    },
  });

  assert.equal(counting.calls, 0);
  assert.equal(afterCalls, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.match(result.toolResults[0]?.content[0]?.type === "text" ? result.toolResults[0].content[0].text : "", /policy service unavailable/);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["Recovered from the before hook failure."]);
});

test("rewritten arguments are revalidated before execution and afterToolCall", async (t) => {
  const counting = createCountingRegistry();
  const provider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_note", { path: "valid.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered from invalid rewritten arguments."),
  ]);
  t.after(provider.unregister);
  let afterCalls = 0;

  const result = await runHookedToolLoop({
    model: provider.getModel(),
    prompt: "Rewrite to invalid arguments.",
    registry: counting.registry,
    hooks: {
      beforeToolCall() {
        return { arguments: {} };
      },
      afterToolCall() {
        afterCalls += 1;
      },
    },
  });

  assert.equal(counting.calls, 0);
  assert.equal(afterCalls, 0);
  assert.equal(result.toolResults[0]?.isError, true);
});
