import assert from "node:assert/strict";
import test from "node:test";

import { createSessionTree, loadSessionTreeFromJSONL } from "./code.ts";

function fixedClock() {
  let tick = 0;
  return () => `2026-06-10T00:00:0${tick++}.000Z`;
}

test("appendMessage creates a child of the current leaf and advances the leaf", () => {
  const session = createSessionTree({ id: "session-1", now: fixedClock() });

  const userId = session.appendMessage({ role: "user", content: "How does Pi remember this turn?" });
  const assistantId = session.appendMessage({ role: "assistant", content: "As entries connected by parentId." });

  assert.equal(session.getEntry(userId)?.parentId, null);
  assert.equal(session.getEntry(assistantId)?.parentId, userId);
  assert.equal(session.getLeafId(), assistantId);
  assert.deepEqual(
    session.buildContext().messages.map((message) => message.content),
    ["How does Pi remember this turn?", "As entries connected by parentId."],
  );
});

test("branch moves the leaf, and the next append grows a sibling branch", () => {
  const session = createSessionTree({ id: "session-2", now: fixedClock() });

  const questionId = session.appendMessage({ role: "user", content: "Which file should we read?" });
  const firstAnswerId = session.appendMessage({ role: "assistant", content: "Start from README." });

  session.branch(questionId);
  const secondAnswerId = session.appendMessage({ role: "assistant", content: "Start from session-format.md." });

  assert.equal(session.getEntry(secondAnswerId)?.parentId, questionId);
  assert.equal(session.getLeafId(), secondAnswerId);
  assert.deepEqual(
    session.buildContext().messages.map((message) => message.content),
    ["Which file should we read?", "Start from session-format.md."],
  );
  assert.deepEqual(
    session.buildContext(firstAnswerId).messages.map((message) => message.content),
    ["Which file should we read?", "Start from README."],
  );
  assert.deepEqual(
    session.getChildren(questionId).map((entry) => entry.id),
    [firstAnswerId, secondAnswerId],
  );
});

test("JSONL stores messages and leaf moves without rewriting old entries", () => {
  const session = createSessionTree({ id: "session-3", cwd: "/demo/pi", now: fixedClock() });

  const questionId = session.appendMessage({ role: "user", content: "Can we try another answer?" });
  const firstAnswerId = session.appendMessage({ role: "assistant", content: "Keep the old path." });
  session.branch(questionId);
  const secondAnswerId = session.appendMessage({ role: "assistant", content: "Grow a new path." });

  const rows = session.toJSONL().trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(
    rows.map((row) => row.type),
    ["session", "message", "message", "leaf", "message"],
  );
  assert.equal(rows[3].parentId, firstAnswerId);
  assert.equal(rows[3].targetId, questionId);

  const loaded = loadSessionTreeFromJSONL(session.toJSONL());

  assert.equal(loaded.getLeafId(), secondAnswerId);
  assert.deepEqual(
    loaded.buildContext().messages.map((message) => message.content),
    ["Can we try another answer?", "Grow a new path."],
  );
  assert.deepEqual(
    loaded.buildContext(firstAnswerId).messages.map((message) => message.content),
    ["Can we try another answer?", "Keep the old path."],
  );
});

test("branch rejects unknown entries", () => {
  const session = createSessionTree({ id: "session-4" });

  assert.throws(() => session.branch("missing"), /Entry missing not found/);
});
