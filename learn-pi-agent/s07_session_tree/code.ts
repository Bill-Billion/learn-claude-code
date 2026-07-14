import type { AgentMessage, BranchSummaryMessage, CompactionSummaryMessage } from "../s06_turn_state/code.ts";
import { cloneAgentMessage, runHarnessTurn } from "../s06_turn_state/code.ts";
import { isMainModule, runPromptCli } from "../shared/cli.ts";
import { loadCourseModel } from "../shared/model.ts";
import { createCourseToolRegistry } from "../s02_tool_schema/code.ts";

export type SessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
};

type SessionEntryBase = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type MessageEntry = SessionEntryBase & {
  type: "message";
  message: AgentMessage;
};

export type LeafEntry = SessionEntryBase & {
  type: "leaf";
  targetId: string | null;
};

export type BranchSummaryEntry = SessionEntryBase & {
  type: "branch_summary";
  summary: string;
  fromId: string;
  details?: unknown;
};

export type CompactionEntry = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
};

export type SessionEntry = MessageEntry | LeafEntry | BranchSummaryEntry | CompactionEntry;

export type SessionContext = {
  messages: AgentMessage[];
};

export type SessionMetadata = {
  id: string;
  createdAt: string;
  cwd: string;
};

export type SessionTreeOptions = {
  id?: string;
  cwd?: string;
  now?: () => string;
};

export type AppendCompactionOptions = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
};

export type SessionTree = {
  readonly messages: AgentMessage[];
  appendMessage(message: AgentMessage): string;
  appendBranchSummary(summary: string, fromId: string, details?: unknown): string;
  appendCompaction(options: AppendCompactionOptions): string;
  branch(entryId: string): string;
  resetLeaf(): string;
  getLeafId(): string | null;
  getEntry(id: string): SessionEntry | undefined;
  getEntries(): SessionEntry[];
  getChildren(parentId: string | null): SessionEntry[];
  getBranch(fromId?: string | null): SessionEntry[];
  buildContext(fromId?: string | null): SessionContext;
  getMetadata(): SessionMetadata;
  toJSONL(): string;
};

type SessionRow = SessionHeader | SessionEntry;

export function createSessionTree(options: SessionTreeOptions = {}): SessionTree {
  const now = options.now ?? (() => new Date().toISOString());
  return new InMemorySessionTree({
    type: "session",
    version: 3,
    id: options.id ?? `session-${Date.now()}`,
    timestamp: now(),
    cwd: options.cwd ?? process.cwd(),
  }, [], null, now);
}

export function loadSessionTreeFromJSONL(
  jsonl: string,
  options: Pick<SessionTreeOptions, "now"> = {},
): SessionTree {
  const rows = jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionRow);
  const header = rows[0];
  if (!header || header.type !== "session") {
    throw new Error("JSONL session must start with a session header");
  }

  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();
  let leafId: string | null = null;
  for (const row of rows.slice(1)) {
    if (!isSessionEntry(row)) {
      throw new Error(`Unsupported session entry type: ${String((row as { type?: unknown }).type)}`);
    }
    if (byId.has(row.id)) throw new Error(`Duplicate session entry id: ${row.id}`);
    validateEntryReferences(row, byId);
    const entry = cloneEntry(row);
    entries.push(entry);
    byId.set(entry.id, entry);
    leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }

  return new InMemorySessionTree({ ...header }, entries, leafId, options.now ?? (() => new Date().toISOString()));
}

class InMemorySessionTree implements SessionTree {
  private readonly header: SessionHeader;
  private readonly entries: SessionEntry[];
  private readonly byId: Map<string, SessionEntry>;
  private readonly now: () => string;
  private leafId: string | null;
  private nextEntryNumber: number;

  constructor(header: SessionHeader, entries: SessionEntry[], leafId: string | null, now: () => string) {
    this.header = { ...header };
    this.entries = entries.map(cloneEntry);
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    this.leafId = leafId;
    this.now = now;
    this.nextEntryNumber = findNextEntryNumber(this.byId);
  }

  get messages(): AgentMessage[] {
    return this.buildContext().messages;
  }

  appendMessage(message: AgentMessage): string {
    const entry: MessageEntry = {
      type: "message",
      id: this.createEntryId(),
      parentId: this.leafId,
      timestamp: this.now(),
      message: cloneAgentMessage(message),
    };
    this.appendEntry(entry);
    this.leafId = entry.id;
    return entry.id;
  }

  appendBranchSummary(summary: string, fromId: string, details?: unknown): string {
    if (!this.byId.has(fromId)) {
      throw new Error(`Branch summary from entry ${fromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: this.createEntryId(),
      parentId: this.leafId,
      timestamp: this.now(),
      summary,
      fromId,
      ...(details === undefined ? {} : { details: cloneDetails(details) }),
    };
    this.appendEntry(entry);
    this.leafId = entry.id;
    return entry.id;
  }

  appendCompaction(options: AppendCompactionOptions): string {
    const activePathIds = new Set(this.getBranch().map((entry) => entry.id));
    if (!activePathIds.has(options.firstKeptEntryId)) {
      throw new Error(`Compaction first kept entry ${options.firstKeptEntryId} is not on the active branch`);
    }
    const entry: CompactionEntry = {
      type: "compaction",
      id: this.createEntryId(),
      parentId: this.leafId,
      timestamp: this.now(),
      summary: options.summary,
      firstKeptEntryId: options.firstKeptEntryId,
      tokensBefore: options.tokensBefore,
      ...(options.details === undefined ? {} : { details: cloneDetails(options.details) }),
    };
    this.appendEntry(entry);
    this.leafId = entry.id;
    return entry.id;
  }

  branch(entryId: string): string {
    if (!this.byId.has(entryId)) throw new Error(`Entry ${entryId} not found`);
    return this.moveLeaf(entryId);
  }

  resetLeaf(): string {
    return this.moveLeaf(null);
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    const entry = this.byId.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  getEntries(): SessionEntry[] {
    return this.entries.map(cloneEntry);
  }

  getChildren(parentId: string | null): SessionEntry[] {
    return this.entries.filter((entry) => entry.parentId === parentId).map(cloneEntry);
  }

  getBranch(fromId: string | null = this.leafId): SessionEntry[] {
    if (fromId === null) return [];
    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    let current = this.byId.get(fromId);
    if (!current) throw new Error(`Entry ${fromId} not found`);
    while (current) {
      if (visited.has(current.id)) throw new Error(`Session branch contains a cycle at ${current.id}`);
      visited.add(current.id);
      path.unshift(current);
      current = current.parentId === null ? undefined : this.byId.get(current.parentId);
    }
    return path.map(cloneEntry);
  }

  buildContext(fromId: string | null = this.leafId): SessionContext {
    const branch = this.getBranch(fromId);
    const latestCompactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
    const messages: AgentMessage[] = [];
    let startIndex = 0;

    if (latestCompactionIndex >= 0) {
      const compaction = branch[latestCompactionIndex] as CompactionEntry;
      const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
      if (firstKeptIndex < 0 || firstKeptIndex >= latestCompactionIndex) {
        throw new Error(`Compaction ${compaction.id} has an invalid first kept entry`);
      }
      const summaryMessage: CompactionSummaryMessage = {
        role: "compactionSummary",
        summary: compaction.summary,
        tokensBefore: compaction.tokensBefore,
        timestamp: Date.parse(compaction.timestamp),
      };
      messages.push(summaryMessage);
      startIndex = firstKeptIndex;
    }

    for (let index = startIndex; index < branch.length; index++) {
      const entry = branch[index]!;
      if (entry.type === "message") {
        messages.push(cloneAgentMessage(entry.message));
      } else if (entry.type === "branch_summary") {
        const summaryMessage: BranchSummaryMessage = {
          role: "branchSummary",
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: Date.parse(entry.timestamp),
        };
        messages.push(summaryMessage);
      }
    }
    return { messages };
  }

  getMetadata(): SessionMetadata {
    return { id: this.header.id, createdAt: this.header.timestamp, cwd: this.header.cwd };
  }

  toJSONL(): string {
    return [this.header, ...this.entries].map((row) => JSON.stringify(row)).join("\n") + "\n";
  }

  private moveLeaf(targetId: string | null): string {
    const entry: LeafEntry = {
      type: "leaf",
      id: this.createEntryId(),
      parentId: this.leafId,
      timestamp: this.now(),
      targetId,
    };
    this.appendEntry(entry);
    this.leafId = targetId;
    return entry.id;
  }

  private appendEntry(entry: SessionEntry): void {
    validateEntryReferences(entry, this.byId);
    const stored = cloneEntry(entry);
    this.entries.push(stored);
    this.byId.set(stored.id, stored);
  }

  private createEntryId(): string {
    while (this.byId.has(`e${this.nextEntryNumber}`)) this.nextEntryNumber += 1;
    return `e${this.nextEntryNumber++}`;
  }
}

function isSessionEntry(row: SessionRow): row is SessionEntry {
  return row.type === "message"
    || row.type === "leaf"
    || row.type === "branch_summary"
    || row.type === "compaction";
}

function validateEntryReferences(entry: SessionEntry, byId: Map<string, SessionEntry>): void {
  if (entry.parentId !== null && !byId.has(entry.parentId)) {
    throw new Error(`Entry ${entry.id} points to missing parent ${entry.parentId}`);
  }
  if (entry.type === "leaf" && entry.targetId !== null && !byId.has(entry.targetId)) {
    throw new Error(`Leaf ${entry.id} points to missing target ${entry.targetId}`);
  }
  if (entry.type === "branch_summary" && !byId.has(entry.fromId)) {
    throw new Error(`Branch summary ${entry.id} points to missing from entry ${entry.fromId}`);
  }
  if (entry.type === "compaction" && !byId.has(entry.firstKeptEntryId)) {
    throw new Error(`Compaction ${entry.id} points to missing first kept entry ${entry.firstKeptEntryId}`);
  }
}

function cloneEntry<TEntry extends SessionEntry>(entry: TEntry): TEntry {
  if (entry.type === "message") {
    return { ...entry, message: cloneAgentMessage(entry.message) } as TEntry;
  }
  if (entry.type === "branch_summary" || entry.type === "compaction") {
    return {
      ...entry,
      ...(entry.details === undefined ? {} : { details: cloneDetails(entry.details) }),
    } as TEntry;
  }
  return { ...entry };
}

function cloneDetails<T>(details: T): T {
  return structuredClone(details);
}

function findNextEntryNumber(byId: Map<string, SessionEntry>): number {
  let next = 1;
  for (const id of byId.keys()) {
    const match = /^e(\d+)$/.exec(id);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

async function runLiveCli(): Promise<void> {
  const runtime = loadCourseModel();
  const session = createSessionTree({ cwd: process.cwd() });
  const registry = createCourseToolRegistry(process.cwd());
  await runPromptCli("s07 Session Tree", async (prompt) => {
    const result = await runHarnessTurn({
      session,
      model: runtime.model,
      registry,
      streamOptions: runtime.streamOptions,
      prompt,
    });
    return result.finalMessage.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  });
}

if (isMainModule(import.meta.url)) {
  await runLiveCli();
}
