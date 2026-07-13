# 第2课 工具怎么给模型看？别直接把本地函数塞给大模型

[English](README.md) · 中文 · [日本語](README.ja.md)

[← s01](../s01_agent_loop/README.zh.md) · [目录](../README.zh.md) · [s03 →](../s03_provider_events/README.zh.md)

上节课我们写了最小的Agent循环，你应该还记得那个有点尴尬的瞬间：输入带"tool"的消息，模型返回"我想调用工具"，然后什么都没发生。

当然什么都不会发生——整个系统里根本没有"工具"这个概念。模型不知道有哪些工具可用，本地也没有任何能被调用的函数。这节课我们就来把工具补上。

但补工具的时候，90%的人第一反应都是错的。

---

## 先搞懂：直接把函数塞给模型为什么不行？

很多人想当然地觉得：这还不简单？我把本地函数整理成一个列表，调用模型的时候一起传过去，模型说要调哪个我就执行哪个不就行了？

这条路从根上就错了。

第一，**模型根本看不懂你的本地函数**。大模型能理解的只有文本，它拿不到你的代码、看不到函数实现，更不可能直接调用你的函数。你传给它的只能是文本描述，告诉它"有这么一个工具，叫什么，能干什么，需要什么参数"。

第二，**边界从一开始就糊了**。哪些信息是给模型看的，哪些是本地代码才需要的，你不分开的话，要么把不该给模型的东西（比如本地函数引用、内部逻辑）泄露出去，要么模型拿到的信息不够，不知道该怎么调工具。

第三，**错误会在最糟糕的时候才暴露**。重名了、参数不对了、找不到工具了，这些问题如果不提前拦住，等模型真的返回工具调用的时候才炸，debug都不知道从哪下手。

这里有个非常贴切的类比：餐厅的菜单和后厨。
给顾客看的菜单上只有菜名、菜品描述、点单时需要说明的选项（几分辣、去不去冰）；菜谱怎么做、厨师是谁、厨房在哪，这些顾客不需要知道，也不会印在菜单上。顾客点菜只说菜名和要求，后厨按单做菜。

工具也是一样：
- 给模型看的是"菜单"：工具名、功能描述、参数格式
- 本地执行的是"后厨"：真正的函数实现、内部逻辑
- 模型只需要看菜单点菜，不需要知道后厨怎么炒菜

这节课我们就把这条边界立起来：先把工具的"菜单"和"后厨"分开，注册的时候放在一起，发给模型之前只把菜单给它，本地执行的时候再按菜名找后厨的做法。这节课我们不真正执行工具，只把边界划清楚。

---

## 第一步：定义工具的两面

首先用两个类型把工具的两面写死：

### 给模型看的"菜单"：ToolDefinition
这是模型能看到的全部信息，只有三个字段，多一个都不给：
```ts
export type ToolDefinition = {
  name: string;        // 菜名，模型调用时只传这个名字
  description: string; // 这道菜是什么，用来干嘛
  parameters: ToolParameters; // 点单时需要提供什么参数
};
```

### 本地用的"完整工具"：RegisteredTool
在ToolDefinition基础上，加两个只有本地才知道的字段：
```ts
export type RegisteredTool = ToolDefinition & {
  label: string;   // UI显示用的友好名称，模型不需要看
  handler: ToolHandler; // 真正执行的本地函数，绝对不能给模型
};
```

容易想错的是`label`字段：很多人觉得"显示名字也应该给模型看啊"——不是的。label是给终端用户看的，模型只需要通过name来识别工具，多给它反而会造成混淆。它和handler一样，都是本地运行时才需要的东西。

---

## 第二步：注册工具，重名当场报错

工具定义好了，我们需要一个注册表来统一管理所有工具。注册的时候第一件事就是检查重名：
```ts
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
```

为什么重名检查要这么严格，注册的时候直接抛错？
因为模型调用工具的时候只会传名字，就像顾客点菜只说菜名。如果两个工具重名，你根本不知道模型想调哪个，执行错了后果可能很严重。所以这个问题必须拦在最早——注册的时候就发现，不要等运行时出问题。

---

## 第三步：发给模型之前，只给它看菜单

注册表是本地的完整信息，发给模型之前必须把本地字段剥掉，只留下ToolDefinition：
```ts
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
```

你可能会问：handler是函数，JSON序列化的时候本来就会被丢掉，何必显式剥一遍？
这是很多人踩过的坑：**序列化只会帮你丢掉"进不了JSON"的东西，不会帮你丢掉"不该给模型看"的东西**。比如label是个字符串，序列化的时候会原封不动传给模型，你靠JSON.stringify是剥不掉的。

> 给模型看什么，必须是显式的、可控的。所有发给模型的工具定义，只能从`listToolDefinitions()`这一个口出去，边界才是可靠的、可测试的。不能靠序列化的"巧合"来保证安全。

---

## 第四步：本地按名找函数，先校验参数再执行

模型返回工具调用的时候，只会传工具名和参数，我们需要在注册表里找到对应的handler，校验参数没问题了再执行：
```ts
export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  // 按名字找工具，找不到直接报错
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // 校验必填参数，缺了直接报错
  validateInput(tool, input);

  // 参数没问题，交给handler执行
  return tool.handler(input);
}
```

参数校验我们先做最基础的：检查必填字段在不在：
```ts
function validateInput(tool: ToolDefinition, input: Record<string, unknown>): void {
  for (const key of tool.parameters.required ?? []) {
    if (!(key in input)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
  }
}
```

注意：这节课的dispatchTool只是"能按名字找到函数"，它还不是完整的工具执行流程。真正的工具执行还要处理事件、hook、错误包装、结果回传，那些是s04的内容。这节课我们只保证：模型说的工具名我们能找到，参数对不对我们能检查。

---

## 先跑起来看看

```sh
npm run session:s02
```

输出长这样：
```text
Tools visible to the provider:
- read: Read a file by path. The s02 demo does not touch the filesystem.
- bash: Describe a shell command. The s02 demo does not execute it.
Dispatch result: read: README.md
```

前两行是模型能看到的工具列表——只有名字和描述，没有label，更没有handler。最后一行是本地按名字找到handler，模拟执行的结果。

特别注意：这里的read没有真的读文件，bash也没有真的执行命令。它们只是证明两件事：模型能看到正确的工具描述，本地能按名字找到对应的处理函数。边界立住了，执行是下一层的事。

---

## 动手试一试

### 实验1：亲眼看一次序列化剥不干净
在`runDemo()`里加一行`console.log(JSON.stringify(registry.tools[0]))`，和`listToolDefinitions()`返回的结果对比一下。

你会发现：handler确实在序列化的时候消失了（函数进不了JSON），但label字段原封不动地留在了JSON里。
这就是为什么我们必须显式剥离本地字段——靠序列化"顺手"剥，永远有漏网之鱼。

### 实验2：加一个新工具，故意缺参数调用
给注册表加第三个工具`write`，有`path`和`content`两个必填参数，跑demo确认它出现在了模型可见的工具列表里。
然后故意不传`content`参数去调用dispatchTool，你会看到校验直接抛出`Missing required parameter: content`。

体会一下：同一份schema，两头都在用——给模型看的时候是说明书，本地执行的时候是校验规则。

### 实验3：制造一次重名
把bash工具的name也改成"read"，再跑demo。
你会看到程序在注册阶段就直接抛出`Duplicate tool: read`，根本等不到调用的时候才报错。

体会一下错误拦截的时机：问题越早发现，调试成本越低。

跑完三个实验，你应该能回答下面检查点的问题。改完可以用`npm run test:s02`确认没破坏行为约定。

---

## 本节课打下的地基

s02我们立住了工具的边界，后面所有和工具相关的功能都建立在这个边界上：

| 这节课立的约定 | 后面会怎么用 |
|----------------|--------------|
| 工具分两面：ToolDefinition给模型，RegisteredTool本地用 | s03事件流、s04工具循环、s05 hook都严格遵守这个边界 |
| 显式剥离本地字段，不靠序列化巧合 | 所有发给模型的工具定义都走listToolDefinitions()，不会泄露本地信息 |
| 注册时检查重名，dispatch时校验参数 | 错误尽量早拦截，不把问题留到运行时 |
| dispatchTool按名找handler | s04的工具循环会用这个函数真正执行工具 |

**本课引入的核心原语**：`ToolDefinition` / `RegisteredTool` / `createToolRegistry` / `listToolDefinitions` / `dispatchTool`

---

## 检查点

学完这节课，你应该能脱口回答这几个问题：
- 工具的哪几个字段是给模型看的？label和handler为什么不能发给模型？
- 为什么不能靠JSON序列化自动剥离本地字段？
- 重名检查为什么要放在注册时，而不是调用dispatch的时候再查？

---

## 本节课小结

这节课我们其实只讲了一个核心道理：
> 工具首先是给模型看的契约，然后才是本地可执行的代码。边界划清楚了，后面才不会乱。

看起来只是把工具拆成了两个类型，多了个剥离的步骤，实际上这是整个工具体系最基础的边界——模型知道什么、本地知道什么，从一开始就分的清清楚楚。后面加工具执行、加权限hook、加扩展工具，都不会乱。

但现在还有个问题：我们的provider还是一次性返回完整结果的，而真实的大模型是一个token一个token往外蹦的，文本和工具参数都是分片返回的，等全部生成完再给你，用户体验会非常差。下节课我们就把一次性返回改成流式事件，让模型边生成边返回。

进入下一课：[s03 Provider Events —— 别等模型全说完，边生成边返回](../s03_provider_events/README.zh.md)
