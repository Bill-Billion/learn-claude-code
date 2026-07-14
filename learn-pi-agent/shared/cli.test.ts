import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { fileURLToPath } from "node:url";

import { parsePromptArguments, runPromptCli } from "./cli.ts";

test("parsePromptArguments joins a one-shot prompt and ignores blank input", () => {
  assert.equal(parsePromptArguments(["node", "lesson.ts", "read", "README.md"]), "read README.md");
  assert.equal(parsePromptArguments(["node", "lesson.ts", "   "]), undefined);
  assert.equal(parsePromptArguments(["node", "lesson.ts"]), undefined);
});

test("runPromptCli prints returned text but leaves streamed void output alone", async () => {
  let output = "";
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });

  await runPromptCli("course", async () => "answer", ["node", "lesson.ts", "first"], {
    input: Readable.from([]),
    output: writable,
  });
  assert.equal(output, "answer\n");

  output = "";
  await runPromptCli("course", async () => undefined, ["node", "lesson.ts", "streamed"], {
    input: Readable.from([]),
    output: writable,
  });
  assert.equal(output, "");
});

test("a live lesson exits cleanly when interactive stdin reaches EOF", () => {
  const courseRoot = fileURLToPath(new URL("..", import.meta.url));
  const entry = fileURLToPath(new URL("../s01_agent_loop/code.ts", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    cwd: courseRoot,
    env: { ...process.env, OPENAI_API_KEY: "eof-test-key" },
    input: "",
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /unsettled top-level await/i);
});
