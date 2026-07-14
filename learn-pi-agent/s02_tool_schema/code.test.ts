import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Type } from "@earendil-works/pi-ai";

import {
  createCourseToolRegistry,
  createToolRegistry,
  dispatchTool,
  extendToolRegistry,
  listToolDefinitions,
  runToolRegistryAgentLoop,
  selectToolRegistry,
  type ToolParameters,
} from "./code.ts";
import { readAssistantText } from "../s01_agent_loop/code.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";

test("the registry exposes pi-ai tool schemas without exposing handlers", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s02-schema-"));
  t.after(() => rm(courseRoot, { recursive: true, force: true }));

  const definitions = listToolDefinitions(createCourseToolRegistry(courseRoot));

  assert.deepEqual(definitions.map((tool) => tool.name), ["read_file"]);
  assert.equal((definitions[0]?.parameters as { type?: string }).type, "object");
  assert.equal("handler" in definitions[0]!, false);
});

test("s02 keeps the S01 model/tool loop while dispatching through the registry", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s02-loop-"));
  await writeFile(join(courseRoot, "notes.txt"), "registry result from disk\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));

  const provider = setupFauxProvider([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "notes.txt" }, { id: "call_notes" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.equal(result.isError, false);
      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /registry result from disk/);
      return fauxAssistantMessage("The registry returned the note.");
    },
  ]);
  t.after(provider.unregister);

  const result = await runToolRegistryAgentLoop({
    model: provider.getModel(),
    prompt: "Read notes.txt.",
    registry: createCourseToolRegistry(courseRoot),
  });

  assert.equal(provider.state.callCount, 2);
  assert.equal(readAssistantText(result.finalMessage), "The registry returned the note.");
});

test("schema errors become toolResult errors so the model can recover", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s02-error-"));
  t.after(() => rm(courseRoot, { recursive: true, force: true }));
  const registry = createCourseToolRegistry(courseRoot);

  await assert.rejects(() => dispatchTool(registry, "missing", {}), /Unknown tool: missing/);
  await assert.rejects(
    () => dispatchTool(registry, "read_file", { path: { invalid: true } }),
    /Invalid parameter type|Invalid tool call|validation failed/i,
  );

  const provider = setupFauxProvider([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: { invalid: true } }, { id: "call_invalid" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.equal(result.isError, true);
      return fauxAssistantMessage("I recovered from the invalid tool arguments.");
    },
  ]);
  t.after(provider.unregister);

  const result = await runToolRegistryAgentLoop({
    model: provider.getModel(),
    prompt: "Try the tool.",
    registry,
  });

  assert.equal(result.toolResults[0]?.isError, true);
  assert.equal(readAssistantText(result.finalMessage), "I recovered from the invalid tool arguments.");
});

test("dispatchTool delegates integer, array, and nested validation to pi-ai", async () => {
  const parameters = Type.Object({
    count: Type.Integer(),
    tags: Type.Array(Type.String()),
    options: Type.Object({ enabled: Type.Boolean() }),
  }, { additionalProperties: false });
  let received: Record<string, unknown> | undefined;
  const registry = createToolRegistry([{
    name: "structured",
    description: "Accept structured arguments.",
    parameters: parameters as unknown as ToolParameters,
    handler(input) {
      received = input;
      return { toolName: "structured", content: "accepted" };
    },
  }]);

  const result = await dispatchTool(registry, "structured", {
    count: 2,
    tags: ["one", "two"],
    options: { enabled: true },
  });

  assert.equal(result.content, "accepted");
  assert.deepEqual(received, {
    count: 2,
    tags: ["one", "two"],
    options: { enabled: true },
  });
});

test("opaque registry selection and extension preserve private handlers", async () => {
  const base = createToolRegistry([
    {
      name: "first",
      description: "First tool.",
      parameters: { type: "object", properties: {} },
      handler() {
        return { toolName: "first", content: "first result" };
      },
    },
    {
      name: "second",
      description: "Second tool.",
      parameters: { type: "object", properties: {} },
      handler() {
        return { toolName: "second", content: "second result" };
      },
    },
  ]);

  assert.equal("tools" in base, false);
  const selected = selectToolRegistry(base, ["second", "first"]);
  assert.deepEqual(listToolDefinitions(selected).map((tool) => tool.name), ["second", "first"]);
  assert.equal((await dispatchTool(selected, "second", {})).content, "second result");
  assert.throws(() => selectToolRegistry(base, ["missing"]), /Unknown tool: missing/);
  assert.throws(() => selectToolRegistry(base, ["first", "first"]), /Duplicate tool: first/);

  const extended = extendToolRegistry(base, [{
    name: "third",
    description: "Third tool.",
    parameters: { type: "object", properties: {} },
    handler() {
      return { toolName: "third", content: "third result" };
    },
  }]);
  assert.deepEqual(listToolDefinitions(extended).map((tool) => tool.name), ["first", "second", "third"]);
  assert.equal((await dispatchTool(extended, "first", {})).content, "first result");
  assert.equal((await dispatchTool(extended, "third", {})).content, "third result");
  assert.throws(() => extendToolRegistry(base, [{
    name: "first",
    description: "Duplicate.",
    parameters: { type: "object", properties: {} },
    handler() {
      return { toolName: "first", content: "duplicate" };
    },
  }]), /Duplicate tool: first/);
});
