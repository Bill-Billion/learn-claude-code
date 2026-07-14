import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createInitialState,
  createReadFileToolRuntime,
  readAssistantText,
  runAgentLoop,
} from "./code.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  setupFauxProvider,
} from "../test-support/faux-provider.ts";

test("s01 completes model -> toolCall -> toolResult -> model with a real file read", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s01-"));
  await writeFile(join(courseRoot, "README.md"), "# Course\n\nHello from disk.\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));

  const provider = setupFauxProvider([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "README.md" }, { id: "call_readme" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.deepEqual(context.messages.map((message) => message.role), [
        "user",
        "assistant",
        "toolResult",
      ]);
      const toolResult = context.messages.at(-1);
      assert.equal(toolResult?.role, "toolResult");
      assert.equal(toolResult.content[0]?.type, "text");
      assert.match(toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "", /Hello from disk/);
      return fauxAssistantMessage("README.md says hello from disk.");
    },
  ]);
  t.after(provider.unregister);

  const result = await runAgentLoop({
    model: provider.getModel(),
    prompt: "Read README.md and summarize it.",
    cwd: courseRoot,
  });

  assert.equal(provider.state.callCount, 2);
  assert.deepEqual(result.state.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(result.toolResults[0]?.toolName, "read_file");
  assert.equal(readAssistantText(result.finalMessage), "README.md says hello from disk.");
});

test("the inline read_file tool rejects hidden files and symlink escapes", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s01-root-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-s01-outside-"));
  await writeFile(join(courseRoot, ".env"), "SECRET=value\n");
  await writeFile(join(outsideRoot, "secret.txt"), "outside\n");
  await symlink(join(outsideRoot, "secret.txt"), join(courseRoot, "linked-secret.txt"));
  t.after(() => rm(courseRoot, { recursive: true, force: true }));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));

  const runtime = createReadFileToolRuntime(courseRoot);
  await assert.rejects(
    () => runtime.execute({
      type: "toolCall",
      id: "hidden",
      name: "read_file",
      arguments: { path: ".env" },
    }),
    /hidden path/,
  );
  await assert.rejects(
    () => runtime.execute({
      type: "toolCall",
      id: "escape",
      name: "read_file",
      arguments: { path: "linked-secret.txt" },
    }),
    /outside the course root/,
  );
});

test("runAgentLoop reports model failures and maximum-turn exhaustion", async (t) => {
  const courseRoot = await mkdtemp(join(tmpdir(), "pi-s01-limit-"));
  await writeFile(join(courseRoot, "README.md"), "loop\n");
  t.after(() => rm(courseRoot, { recursive: true, force: true }));

  const failingProvider = setupFauxProvider([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" }),
  ]);
  t.after(failingProvider.unregister);
  await assert.rejects(
    () => runAgentLoop({ model: failingProvider.getModel(), prompt: "hello", cwd: courseRoot }),
    /provider unavailable/,
  );

  const loopingProvider = setupFauxProvider([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "README.md" }), { stopReason: "toolUse" }),
  ]);
  t.after(loopingProvider.unregister);
  await assert.rejects(
    () => runAgentLoop({
      model: loopingProvider.getModel(),
      prompt: "keep reading",
      cwd: courseRoot,
      state: createInitialState(),
      maxTurns: 1,
    }),
    /maximum of 1 model turn/,
  );
});
