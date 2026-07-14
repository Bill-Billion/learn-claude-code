import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCourseToolRegistry } from "../s02_tool_schema/code.ts";
import {
  collectAssistantStream,
  readTextBlocks,
  runStreamingAgentLoop,
} from "./code.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";

test("collectAssistantStream exposes the official pi-ai event protocol", async (t) => {
  const provider = setupFauxProvider([fauxAssistantMessage("Pi streams real events.")]);
  t.after(provider.unregister);

  const result = await collectAssistantStream({
    model: provider.getModel(),
    context: { messages: [] },
  });

  assert.deepEqual(result.eventTypes, [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.equal(result.message.api, provider.api);
  assert.deepEqual(readTextBlocks(result.message), ["Pi streams real events."]);
});

test("s03 streams both model turns while preserving registry tool execution", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s03-loop-"));
  await writeFile(join(courseRoot, "stream.txt"), "streamed tool result\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));

  const provider = setupFauxProvider([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "stream.txt" }, { id: "call_stream" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /streamed tool result/);
      return fauxAssistantMessage("Streaming loop complete.");
    },
  ]);
  t.after(provider.unregister);
  const seenEvents: string[] = [];

  const result = await runStreamingAgentLoop({
    model: provider.getModel(),
    prompt: "Read stream.txt.",
    registry: createCourseToolRegistry(courseRoot),
    onEvent(event) {
      seenEvents.push(event.type);
    },
  });

  assert.equal(provider.state.callCount, 2);
  assert.ok(seenEvents.includes("toolcall_end"));
  assert.equal(seenEvents.at(-1), "done");
  assert.deepEqual(result.state.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.deepEqual(readTextBlocks(result.finalMessage), ["Streaming loop complete."]);
});

test("stream errors are surfaced to the caller", async (t) => {
  const provider = setupFauxProvider([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "stream failed" }),
  ]);
  t.after(provider.unregister);

  await assert.rejects(
    () => runStreamingAgentLoop({
      model: provider.getModel(),
      prompt: "hello",
      registry: createCourseToolRegistry(process.cwd()),
    }),
    /stream failed/,
  );
});
