import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  type Provider,
  runOneTurn,
  runScript,
} from "./code.ts";

test("runOneTurn appends user and assistant messages", async () => {
  const state = createInitialState();

  const assistant = await runOneTurn(state, {
    async complete() {
      return {
        role: "assistant",
        content: "hello back",
        stopReason: "stop",
      };
    },
  }, "hello");

  assert.equal(assistant.stopReason, "stop");
  assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(state.messages[0]?.content, "hello");
  assert.equal(state.messages[1]?.content, "hello back");
});

test("provider receives the full message history", async () => {
  const seenLengths: number[] = [];
  const provider: Provider = {
    async complete(messages) {
      seenLengths.push(messages.length);
      return {
        role: "assistant",
        content: `reply ${seenLengths.length}`,
        stopReason: "stop",
      };
    },
  };

  const state = await runScript(["first line", "second line"], provider);

  assert.deepEqual(seenLengths, [1, 3]);
  assert.equal(state.messages.length, 4);
});

test("s01 keeps toolUse as a stop reason but does not execute tools", async () => {
  const state = await runScript(["I need a tool"]);
  const assistant = state.messages.at(-1);

  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.stopReason, "toolUse");
  assert.match(assistant?.content ?? "", /no tool executor yet/);
});
