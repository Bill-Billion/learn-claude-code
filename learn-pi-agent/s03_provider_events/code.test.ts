import assert from "node:assert/strict";
import test from "node:test";

import { listToolDefinitions, createDemoToolRegistry } from "../s02_tool_schema/code.ts";
import {
  collectProviderStream,
  createInterleavedProvider,
  createTextProvider,
  createToolCallProvider,
  readTextBlocks,
  type EventProvider,
} from "./code.ts";

test("text provider stream keeps lifecycle events and final assistant message", async () => {
  const provider = createTextProvider(["Pi ", "uses ", "events."]);
  const result = await collectProviderStream(provider, { messages: [], tools: [] });

  assert.deepEqual(result.eventTypes, [
    "start",
    "text_start",
    "text_delta",
    "text_delta",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.equal(result.message.stopReason, "stop");
  assert.deepEqual(readTextBlocks(result.message), ["Pi uses events."]);
});

test("tool call stream exposes toolcall events without executing the local handler", async () => {
  const registry = createDemoToolRegistry();
  const provider = createToolCallProvider("read", { path: "README.md" });

  const result = await collectProviderStream(provider, {
    messages: [],
    tools: listToolDefinitions(registry),
  });

  assert.deepEqual(result.eventTypes, [
    "start",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ]);
  assert.equal(result.message.stopReason, "toolUse");
  assert.equal(result.toolCalls[0]?.name, "read");
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "README.md" });
});

test("contentIndex lets consumers rebuild interleaved text blocks", async () => {
  const provider = createInterleavedProvider();
  const result = await collectProviderStream(provider, { messages: [], tools: [] });

  assert.deepEqual(result.textByIndex, new Map([
    [0, "first block"],
    [1, "second block"],
  ]));
});

test("provider context can carry a system prompt without changing existing providers", async () => {
  let receivedSystemPrompt: string | undefined;
  const provider: EventProvider = {
    stream(context) {
      receivedSystemPrompt = context.systemPrompt;
      return createTextProvider(["ok"]).stream(context);
    },
  };

  await collectProviderStream(provider, {
    messages: [],
    tools: [],
    systemPrompt: "Project instructions.",
  });

  assert.equal(receivedSystemPrompt, "Project instructions.");
});
