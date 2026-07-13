import assert from "node:assert/strict";
import test from "node:test";

import { createDemoToolRegistry } from "../s02_tool_schema/code.ts";
import { createMultiToolCallProvider, createToolLoopProvider } from "../s04_evented_tool_loop/code.ts";
import {
  createCountingReadRegistry,
  readTextBlocksFromLastAssistant,
  runHookedToolLoop,
} from "./code.ts";

test("beforeToolCall can block a tool before the handler runs", async () => {
  const registry = createCountingReadRegistry();

  const result = await runHookedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "secret.txt" },
      finalText: "I saw the block.",
    }),
    registry,
    {
      beforeToolCall() {
        return { block: true, reason: "read is disabled in this lesson" };
      },
    },
  );

  assert.equal(registry.calls, 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.equal(result.toolResults[0]?.content[0]?.text, "read is disabled in this lesson");
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["I saw the block."]);
});

test("afterToolCall can rewrite the tool result before it becomes a message", async () => {
  const registry = createCountingReadRegistry();

  const result = await runHookedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "README.md" },
      finalText: "I saw the patched result.",
    }),
    registry,
    {
      afterToolCall({ result }) {
        return {
          content: [{ type: "text", text: `audited: ${result.content[0]?.text}` }],
        };
      },
    },
  );

  assert.equal(registry.calls, 1);
  assert.equal(result.toolResults[0]?.isError, false);
  assert.equal(result.toolResults[0]?.content[0]?.text, "audited: read: README.md");
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["I saw the patched result."]);
});

test("a mixed batch keeps going: terminate only stops when every tool result sets it", async () => {
  const result = await runHookedToolLoop(
    createMultiToolCallProvider(
      [
        { toolName: "read", args: { path: "README.md" } },
        { toolName: "bash", args: { command: "ls" } },
      ],
      "the loop continued past the mixed batch",
    ),
    createDemoToolRegistry(),
    {
      afterToolCall({ toolCall }) {
        return toolCall.name === "read" ? { terminate: true } : undefined;
      },
    },
  );

  assert.equal(result.terminated, false);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), [
    "the loop continued past the mixed batch",
  ]);
});

test("a batch where every tool result terminates stops before the follow-up turn", async () => {
  const result = await runHookedToolLoop(
    createMultiToolCallProvider(
      [
        { toolName: "read", args: { path: "README.md" } },
        { toolName: "bash", args: { command: "ls" } },
      ],
      "this should not be emitted",
    ),
    createDemoToolRegistry(),
    {
      afterToolCall() {
        return { terminate: true };
      },
    },
  );

  assert.equal(result.terminated, true);
  assert.deepEqual(result.messages.map((message) => message.role), [
    "assistant",
    "toolResult",
    "toolResult",
  ]);
});

test("afterToolCall terminate skips the automatic follow-up turn", async () => {
  const registry = createCountingReadRegistry();

  const result = await runHookedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "README.md" },
      finalText: "this should not be emitted",
    }),
    registry,
    {
      afterToolCall() {
        return { terminate: true };
      },
    },
  );

  assert.equal(result.terminated, true);
  assert.deepEqual(result.messages.map((message) => message.role), ["assistant", "toolResult"]);
  assert.equal(readTextBlocksFromLastAssistant(result.messages).length, 0);
  assert.equal(result.eventTypes.at(-1), "agent_end");
});
