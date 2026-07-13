export type MiniRuntimeMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MiniRuntimeEvent =
  | {
      type: "session";
      sessionId: string;
      runId: string;
    }
  | {
      type: "agent_start";
      sessionId: string;
      runId: string;
      prompt: string;
    }
  | {
      type: "message";
      sessionId: string;
      runId: string;
      role: "assistant";
      content: string;
    }
  | {
      type: "agent_end";
      sessionId: string;
      runId: string;
      finalText: string;
    };

export type MiniRuntimeState = {
  sessionId: string;
  turns: number;
  messageCount: number;
  lastAssistantText?: string;
};

export type MiniRunResult = {
  sessionId: string;
  runId: string;
  finalText: string;
  events: MiniRuntimeEvent[];
  messages: MiniRuntimeMessage[];
};

export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
}

export type MiniCoreRuntimeOptions = {
  sessionId?: string;
  answerPrefix?: string;
};

export type MiniRpcCommand =
  | {
      id?: string;
      type: "prompt";
      message: string;
    }
  | {
      id?: string;
      type: "get_state";
    };

export type MiniRpcResponse =
  | {
      id?: string;
      type: "response";
      command: "prompt";
      success: true;
      data: MiniRunResult;
    }
  | {
      id?: string;
      type: "response";
      command: "get_state";
      success: true;
      data: MiniRuntimeState;
    }
  | {
      id?: string;
      type: "response";
      command: string;
      success: false;
      error: string;
    };

type StoredRun = MiniRunResult & {
  prompt: string;
};

export class MiniCoreRuntime implements MiniRuntime {
  private readonly sessionId: string;
  private readonly answerPrefix: string;
  private readonly messages: MiniRuntimeMessage[] = [];
  private readonly runs: StoredRun[] = [];

  constructor(options: MiniCoreRuntimeOptions = {}) {
    this.sessionId = options.sessionId ?? "mini-session";
    this.answerPrefix = options.answerPrefix ?? "mini pi";
  }

  async prompt(prompt: string): Promise<MiniRunResult> {
    const runId = `${this.sessionId}:${this.runs.length + 1}`;
    const finalText = `${this.answerPrefix}: ${prompt}`;
    const userMessage: MiniRuntimeMessage = { role: "user", content: prompt };
    const assistantMessage: MiniRuntimeMessage = { role: "assistant", content: finalText };

    this.messages.push(userMessage, assistantMessage);

    const events: MiniRuntimeEvent[] = [
      { type: "session", sessionId: this.sessionId, runId },
      { type: "agent_start", sessionId: this.sessionId, runId, prompt },
      { type: "message", sessionId: this.sessionId, runId, role: "assistant", content: finalText },
      { type: "agent_end", sessionId: this.sessionId, runId, finalText },
    ];
    const result: MiniRunResult = {
      sessionId: this.sessionId,
      runId,
      finalText,
      events: cloneEvents(events),
      messages: this.getMessages(),
    };

    this.runs.push({ ...result, prompt });
    return cloneRunResult(result);
  }

  getState(): MiniRuntimeState {
    const lastAssistantText = [...this.messages].reverse().find((message) => message.role === "assistant")?.content;
    return {
      sessionId: this.sessionId,
      turns: this.runs.length,
      messageCount: this.messages.length,
      ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
    };
  }

  getMessages(): MiniRuntimeMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  getPrompts(): string[] {
    return this.runs.map((run) => run.prompt);
  }

  getRuns(): MiniRunResult[] {
    return this.runs.map(cloneRunResult);
  }
}

export function createMiniCoreRuntime(options: MiniCoreRuntimeOptions = {}): MiniCoreRuntime {
  return new MiniCoreRuntime(options);
}

export async function runPrintMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return result.finalText;
}

export async function runJsonMode(runtime: MiniRuntime, prompt: string): Promise<string> {
  const result = await runtime.prompt(prompt);
  return `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function runRpcMode(
  runtime: MiniRuntime,
  command: Extract<MiniRpcCommand, { type: "prompt" }>,
): Promise<Extract<MiniRpcResponse, { command: "prompt"; success: true }>>;
export function runRpcMode(
  runtime: MiniRuntime,
  command: Extract<MiniRpcCommand, { type: "get_state" }>,
): Promise<Extract<MiniRpcResponse, { command: "get_state"; success: true }>>;
export function runRpcMode(runtime: MiniRuntime, command: MiniRpcCommand): Promise<MiniRpcResponse>;
export async function runRpcMode(runtime: MiniRuntime, command: MiniRpcCommand): Promise<MiniRpcResponse> {
  switch (command.type) {
    case "prompt":
      return {
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: await runtime.prompt(command.message),
      };
    case "get_state":
      return {
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: runtime.getState(),
      };
    default:
      return {
        id: (command as { id?: string }).id,
        type: "response",
        command: (command as { type?: string }).type ?? "unknown",
        success: false,
        error: "Unknown RPC command",
      };
  }
}

export function createSdkSession(runtime: MiniRuntime): {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void;
} {
  const listeners = new Set<(event: MiniRuntimeEvent) => void>();

  return {
    async prompt(prompt: string): Promise<MiniRunResult> {
      const result = await runtime.prompt(prompt);
      for (const event of result.events) {
        for (const listener of listeners) {
          listener({ ...event });
        }
      }
      return result;
    },
    getState(): MiniRuntimeState {
      return runtime.getState();
    },
    subscribe(listener: (event: MiniRuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function runInteractiveMode(runtime: MiniRuntime, prompts: string[]): Promise<string[]> {
  const transcript: string[] = [];

  for (const prompt of prompts) {
    transcript.push(`user> ${prompt}`);
    const result = await runtime.prompt(prompt);
    transcript.push(`assistant> ${result.finalText}`);
  }

  return transcript;
}

function cloneEvents(events: MiniRuntimeEvent[]): MiniRuntimeEvent[] {
  return events.map((event) => ({ ...event }));
}

function cloneRunResult(result: MiniRunResult): MiniRunResult {
  return {
    ...result,
    events: cloneEvents(result.events),
    messages: result.messages.map((message) => ({ ...message })),
  };
}

async function demo(): Promise<void> {
  const runtime = createMiniCoreRuntime({ sessionId: "demo" });
  const printText = await runPrintMode(runtime, "hello print");
  const jsonText = await runJsonMode(runtime, "hello json");
  const rpcState = await runRpcMode(runtime, { type: "get_state" });

  console.log(`Print: ${printText}`);
  console.log(`JSON event types: ${jsonText.trimEnd().split("\n").map((line) => JSON.parse(line).type).join(", ")}`);
  console.log(`RPC turns: ${rpcState.success ? rpcState.data.turns : "error"}`);
}

if (process.argv.includes("--demo")) {
  await demo();
}
