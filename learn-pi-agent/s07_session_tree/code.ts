export type SessionMessage = {
  role: "user" | "assistant" | "toolResult";
  content: string;
};

export type SessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
};

export type MessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: SessionMessage;
};

export type LeafEntry = {
  type: "leaf";
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string | null;
};

export type SessionEntry = MessageEntry | LeafEntry;

export type SessionContext = {
  messages: SessionMessage[];
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

export type SessionTree = {
  appendMessage(message: SessionMessage): string;
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
  const header: SessionHeader = {
    type: "session",
    version: 3,
    id: options.id ?? "demo-session",
    timestamp: now(),
    cwd: options.cwd ?? process.cwd(),
  };

  return new InMemorySessionTree(header, [], null, now);
}

export function loadSessionTreeFromJSONL(jsonl: string, options: Pick<SessionTreeOptions, "now"> = {}): SessionTree {
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
    if (row.type !== "message" && row.type !== "leaf") {
      throw new Error(`Unsupported session entry type: ${String(row.type)}`);
    }
    if (row.parentId !== null && !byId.has(row.parentId)) {
      throw new Error(`Entry ${row.id} points to missing parent ${row.parentId}`);
    }
    if (row.type === "leaf" && row.targetId !== null && !byId.has(row.targetId)) {
      throw new Error(`Leaf ${row.id} points to missing target ${row.targetId}`);
    }

    const entry = cloneEntry(row);
    entries.push(entry);
    byId.set(entry.id, entry);
    leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }

  return new InMemorySessionTree(
    {
      type: "session",
      version: 3,
      id: header.id,
      timestamp: header.timestamp,
      cwd: header.cwd,
    },
    entries,
    leafId,
    options.now ?? (() => new Date().toISOString()),
  );
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

  appendMessage(message: SessionMessage): string {
    const entry: MessageEntry = {
      type: "message",
      id: this.createEntryId(),
      parentId: this.leafId,
      timestamp: this.now(),
      message: { ...message },
    };

    this.appendEntry(entry);
    this.leafId = entry.id;
    return entry.id;
  }

  branch(entryId: string): string {
    if (!this.byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
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
    let current = this.byId.get(fromId);
    if (!current) {
      throw new Error(`Entry ${fromId} not found`);
    }

    while (current) {
      path.unshift(current);
      current = current.parentId === null ? undefined : this.byId.get(current.parentId);
    }

    return path.map(cloneEntry);
  }

  buildContext(fromId: string | null = this.leafId): SessionContext {
    return {
      messages: this.getBranch(fromId)
        .filter((entry): entry is MessageEntry => entry.type === "message")
        .map((entry) => ({ ...entry.message })),
    };
  }

  getMetadata(): SessionMetadata {
    return {
      id: this.header.id,
      createdAt: this.header.timestamp,
      cwd: this.header.cwd,
    };
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
    if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
      throw new Error(`Entry ${entry.id} points to missing parent ${entry.parentId}`);
    }
    if (entry.type === "leaf" && entry.targetId !== null && !this.byId.has(entry.targetId)) {
      throw new Error(`Leaf ${entry.id} points to missing target ${entry.targetId}`);
    }

    this.entries.push(cloneEntry(entry));
    this.byId.set(entry.id, cloneEntry(entry));
  }

  private createEntryId(): string {
    while (this.byId.has(`e${this.nextEntryNumber}`)) {
      this.nextEntryNumber += 1;
    }
    return `e${this.nextEntryNumber++}`;
  }
}

function cloneEntry<TEntry extends SessionEntry>(entry: TEntry): TEntry {
  if (entry.type === "message") {
    return {
      ...entry,
      message: { ...entry.message },
    };
  }
  return { ...entry };
}

function findNextEntryNumber(byId: Map<string, SessionEntry>): number {
  let next = 1;
  for (const id of byId.keys()) {
    const match = /^e(\d+)$/.exec(id);
    if (match) {
      next = Math.max(next, Number(match[1]) + 1);
    }
  }
  return next;
}

export async function runDemo(): Promise<void> {
  const session = createSessionTree({ id: "demo-session", cwd: "/demo/pi" });
  const questionId = session.appendMessage({ role: "user", content: "How should Pi store sessions?" });
  const firstAnswerId = session.appendMessage({ role: "assistant", content: "As a plain message list." });

  session.branch(questionId);
  const secondAnswerId = session.appendMessage({
    role: "assistant",
    content: "As an append-only entry tree with a movable leaf.",
  });

  console.log(`Session: ${session.getMetadata().id}`);
  console.log(`Old branch: ${session.buildContext(firstAnswerId).messages.map((message) => message.content).join(" -> ")}`);
  console.log(`Active branch: ${session.buildContext().messages.map((message) => message.content).join(" -> ")}`);
  console.log(`Current leaf: ${session.getLeafId()}`);
  console.log(`Children of question: ${session.getChildren(questionId).map((entry) => entry.id).join(", ")}`);
  console.log(`JSONL row types: ${session.toJSONL().trim().split("\n").map((line) => JSON.parse(line).type).join(" -> ")}`);
  console.log(`New answer parent: ${session.getEntry(secondAnswerId)?.parentId}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
