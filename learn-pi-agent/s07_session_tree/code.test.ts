import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { AgentMessage, CompactionSummaryMessage } from "../s06_turn_state/code.ts";
import { createSessionTree, loadSessionTreeFromJSONL } from "./code.ts";

function fixedClock() {
  let tick = 0;
  return () => `2026-06-10T00:00:0${tick++}.000Z`;
}

function user(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function assistant(content: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function messageText(message: AgentMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  if (message.role === "assistant") {
    return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary;
  return "";
}

test("appendMessage grows from the current leaf and deep-clones message content", () => {
  const session = createSessionTree({ id: "session-1", now: fixedClock() });
  const answer = assistant("As entries connected by parentId.", 2);

  const userId = session.appendMessage(user("How does Pi remember this turn?", 1));
  const assistantId = session.appendMessage(answer);
  answer.content[0] = { type: "text", text: "mutated" };

  assert.equal(session.getEntry(userId)?.parentId, null);
  assert.equal(session.getEntry(assistantId)?.parentId, userId);
  assert.equal(session.getLeafId(), assistantId);
  assert.deepEqual(session.buildContext().messages.map(messageText), [
    "How does Pi remember this turn?",
    "As entries connected by parentId.",
  ]);
});

test("branch preserves the old path and grows a sibling path", () => {
  const session = createSessionTree({ id: "session-2", now: fixedClock() });
  const questionId = session.appendMessage(user("Which file should we read?", 1));
  const firstAnswerId = session.appendMessage(assistant("Start from README.", 2));

  session.branch(questionId);
  const secondAnswerId = session.appendMessage(assistant("Start from session-format.md.", 3));

  assert.equal(session.getEntry(secondAnswerId)?.parentId, questionId);
  assert.deepEqual(session.buildContext().messages.map(messageText), [
    "Which file should we read?",
    "Start from session-format.md.",
  ]);
  assert.deepEqual(session.buildContext(firstAnswerId).messages.map(messageText), [
    "Which file should we read?",
    "Start from README.",
  ]);
});

test("branch_summary is append-only and materializes as an AgentMessage on the active branch", () => {
  const session = createSessionTree({ id: "session-3", now: fixedClock() });
  const questionId = session.appendMessage(user("Try two approaches.", 1));
  const abandonedLeafId = session.appendMessage(assistant("The first approach changed README.md.", 2));

  session.branch(questionId);
  const summaryId = session.appendBranchSummary(
    "The abandoned branch changed README.md.",
    abandonedLeafId,
  );
  session.appendMessage(user("Continue with the second approach.", 3));

  assert.equal(session.getEntry(summaryId)?.type, "branch_summary");
  assert.deepEqual(session.buildContext().messages.map((message) => message.role), [
    "user",
    "branchSummary",
    "user",
  ]);
  assert.deepEqual(session.buildContext().messages.map(messageText), [
    "Try two approaches.",
    "The abandoned branch changed README.md.",
    "Continue with the second approach.",
  ]);
});

test("compaction materializes one summary followed by the retained suffix", () => {
  const session = createSessionTree({ id: "session-4", now: fixedClock() });
  session.appendMessage(user("Old request", 1));
  session.appendMessage(assistant("Old answer", 2));
  const firstKeptEntryId = session.appendMessage(user("Recent request", 3));
  session.appendMessage(assistant("Recent answer", 4));

  const compactionId = session.appendCompaction({
    summary: "Old request and answer were completed.",
    firstKeptEntryId,
    tokensBefore: 800,
  });
  const context = session.buildContext();

  assert.equal(session.getEntry(compactionId)?.type, "compaction");
  assert.deepEqual(context.messages.map((message) => message.role), [
    "compactionSummary",
    "user",
    "assistant",
  ]);
  assert.equal((context.messages[0] as CompactionSummaryMessage).tokensBefore, 800);
  assert.deepEqual(context.messages.map(messageText), [
    "Old request and answer were completed.",
    "Recent request",
    "Recent answer",
  ]);
});

test("summary and compaction entries validate their references", () => {
  const session = createSessionTree({ id: "session-5", now: fixedClock() });
  const entryId = session.appendMessage(user("hello", 1));

  assert.throws(() => session.appendBranchSummary("missing", "missing"), /from entry missing not found/);
  assert.throws(() => session.appendCompaction({
    summary: "bad",
    firstKeptEntryId: "missing",
    tokensBefore: 1,
  }), /first kept entry missing is not on the active branch/);
  assert.doesNotThrow(() => session.appendCompaction({
    summary: "valid",
    firstKeptEntryId: entryId,
    tokensBefore: 1,
  }));
});

test("JSONL reload preserves branch_summary, compaction, and context materialization", () => {
  const session = createSessionTree({ id: "session-6", cwd: "/demo/pi", now: fixedClock() });
  const questionId = session.appendMessage(user("Question", 1));
  const abandonedLeafId = session.appendMessage(assistant("Abandoned answer", 2));
  session.branch(questionId);
  session.appendBranchSummary("Abandoned work", abandonedLeafId);
  const firstKeptEntryId = session.appendMessage(user("Recent question", 3));
  session.appendMessage(assistant("Recent answer", 4));
  session.appendCompaction({ summary: "Earlier branch context", firstKeptEntryId, tokensBefore: 500 });

  const jsonl = session.toJSONL();
  const loaded = loadSessionTreeFromJSONL(jsonl);

  assert.deepEqual(
    jsonl.trim().split("\n").map((line) => JSON.parse(line).type),
    ["session", "message", "message", "leaf", "branch_summary", "message", "message", "compaction"],
  );
  assert.equal(loaded.getLeafId(), session.getLeafId());
  assert.deepEqual(loaded.buildContext().messages.map(messageText), [
    "Earlier branch context",
    "Recent question",
    "Recent answer",
  ]);
});

test("JSONL reload rejects duplicate ids before they can create a cyclic branch", () => {
  const timestamp = "2026-06-10T00:00:00.000Z";
  const rows = [
    { type: "session", version: 3, id: "malicious", timestamp, cwd: "/work" },
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp,
      message: user("first", 1),
    },
    {
      type: "message",
      id: "e1",
      parentId: "e1",
      timestamp,
      message: user("self cycle", 2),
    },
  ];

  assert.throws(
    () => loadSessionTreeFromJSONL(rows.map((row) => JSON.stringify(row)).join("\n")),
    /Duplicate session entry id: e1/,
  );
});
