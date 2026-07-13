import assert from "node:assert/strict";
import test from "node:test";

import { createDemoToolRegistry } from "../s02_tool_schema/code.ts";
import {
  createMultiToolCallProvider,
  createToolLoopProvider,
  readTextBlocksFromLastAssistant,
  runEventedToolLoop,
} from "./code.ts";

test("tool call executes a local handler and returns toolResult before the next turn", async () => {
  const registry = createDemoToolRegistry();
  const provider = createToolLoopProvider({
    toolName: "read",
    args: { path: "README.md" },
    finalText: "I saw the tool result.",
  });

  const result = await runEventedToolLoop(provider, registry);

  assert.deepEqual(result.messages.map((message) => message.role), [
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(result.toolResults[0]?.toolName, "read");
  assert.equal(result.toolResults[0]?.content[0]?.text, "read: README.md");
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["I saw the tool result."]);
});

test("agent events keep the Pi order around tool execution", async () => {
  const result = await runEventedToolLoop(
    createToolLoopProvider({
      toolName: "read",
      args: { path: "README.md" },
      finalText: "done",
    }),
    createDemoToolRegistry(),
  );

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
});

test("toolResult messages keep the assistant source order in a multi-tool batch", async () => {
  const result = await runEventedToolLoop(
    createMultiToolCallProvider(
      [
        { toolName: "read", args: { path: "README.md" } },
        { toolName: "bash", args: { command: "ls" } },
      ],
      "I saw both results.",
    ),
    createDemoToolRegistry(),
  );

  assert.deepEqual(result.toolResults.map((message) => message.toolCallId), ["call_1", "call_2"]);
  assert.deepEqual(result.toolResults.map((message) => message.toolName), ["read", "bash"]);
  assert.deepEqual(result.messages.map((message) => message.role), [
    "assistant",
    "toolResult",
    "toolResult",
    "assistant",
  ]);
});

test("unknown tools become error toolResult messages and still continue", async () => {
  const result = await runEventedToolLoop(
    createToolLoopProvider({
      toolName: "missing",
      args: {},
      finalText: "I can see the error.",
      allowUnknownTool: true,
    }),
    createDemoToolRegistry(),
  );

  assert.equal(result.toolResults[0]?.toolName, "missing");
  assert.equal(result.toolResults[0]?.isError, true);
  assert.match(result.toolResults[0]?.content[0]?.text ?? "", /Unknown tool: missing/);
  assert.deepEqual(readTextBlocksFromLastAssistant(result.messages), ["I can see the error."]);
});
