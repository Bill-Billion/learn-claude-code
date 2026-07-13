export type JsonSchemaProperty = {
  type: "string" | "number" | "boolean";
  description?: string;
};

export type ToolParameters = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
};

export type ToolResult = {
  toolName: string;
  content: string;
};

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export type RegisteredTool = ToolDefinition & {
  label: string;
  handler: ToolHandler;
};

export type ToolRegistry = {
  tools: RegisteredTool[];
};

export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const seen = new Set<string>();

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    seen.add(tool.name);
  }

  return { tools };
}

export function listToolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.tools.map(({ handler: _handler, label: _label, ...definition }) => ({
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: { ...definition.parameters.properties },
      required: definition.parameters.required ? [...definition.parameters.required] : undefined,
    },
  }));
}

export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  validateInput(tool, input);
  return tool.handler(input);
}

function validateInput(tool: ToolDefinition, input: Record<string, unknown>): void {
  for (const key of tool.parameters.required ?? []) {
    if (!(key in input)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
  }
}

export function createDemoToolRegistry(): ToolRegistry {
  return createToolRegistry([
    {
      name: "read",
      label: "read",
      description: "Read a file by path. The s02 demo does not touch the filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to read.",
          },
        },
        required: ["path"],
      },
      handler(input) {
        return {
          toolName: "read",
          content: `read: ${String(input.path)}`,
        };
      },
    },
    {
      name: "bash",
      label: "bash",
      description: "Describe a shell command. The s02 demo does not execute it.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command to describe.",
          },
        },
        required: ["command"],
      },
      handler(input) {
        return {
          toolName: "bash",
          content: `bash: ${String(input.command)}`,
        };
      },
    },
  ]);
}

export async function runDemo(): Promise<void> {
  const registry = createDemoToolRegistry();
  const definitions = listToolDefinitions(registry);

  console.log("Tools visible to the provider:");
  for (const tool of definitions) {
    console.log(`- ${tool.name}: ${tool.description}`);
  }

  const result = await dispatchTool(registry, "read", { path: "README.md" });
  console.log(`Dispatch result: ${result.content}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runDemo();
}
