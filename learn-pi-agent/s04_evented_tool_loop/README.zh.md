# 第4课 工具真的能跑了——写真正的工具执行循环

[English](README.md) · 中文 · [日本語](README.ja.md)

[← s03](../s03_provider_events/README.zh.md) · [目录](../README.zh.md) · [s05 →](../s05_tool_hooks/README.zh.md)

学到这里，我们手上已经有了两块拼图：s02给了工具定义，模型知道有哪些工具、要什么参数；s03给了事件流，模型想调用工具的意图能一个字一个字流出来。

但你有没有发现一件很别扭的事——到现在为止，工具一次都没真的跑过。
模型返回"我要调用read工具"，然后就没有然后了，那个toolUse信号就悬在半空中没人接。

这节课我们就把这最后一段接上，写真正的工具执行循环。

---

## 先搞懂：直接执行工具把结果给用户为什么不行？

很多人第一反应是：这还不简单？看到toolCall就调用对应的函数，把返回值打印给用户不就完了？

这个思路从根上就错了。

第一，**工具结果不是给用户的回答**。read工具返回的是文件内容，bash返回的是命令输出，这些不是"对用户说的话"——真正该看这些内容的是模型，它看完才知道下一句该说什么。你直接把文件内容甩给用户，用户根本看不懂。

第二，**一次调用根本不够**。模型看完第一个工具的结果，很可能还要调用第二个、第三个工具，甚至根据第一个结果调整第二个工具的参数。没有循环，链条在第一环就断了。

第三，**执行过程不能是黑盒**。s03我们好不容易把模型生成做成了流式，用户能看到字一个一个蹦出来，结果工具执行那几秒又变成了黑屏等待，体验直接断层。

正确的流程其实和医院看病是一个逻辑：
- 医生（模型）问诊完，开检验单（toolCall）
- 检验科（本地工具）做检查，出报告（toolResult）
- 报告不是直接念给病人听，而是订进病历（上下文）
- 医生下一轮翻病历看到报告，决定是再开检查，还是下诊断（最终回答）

就这么简单，我们把这个流程做成循环，就是这节课的核心。

---

## 工具循环的核心逻辑

整个循环的主干非常清晰，一共就三步，反复执行直到退出：

### 1. 调用模型，流式收完一整条assistant消息
每一轮开始，把当前所有上下文消息传给模型，边生成边发事件，等模型生成完一整条消息。

### 2. 提取消息里的所有toolCall，逐个执行
如果这一轮模型返回了工具调用，就按顺序逐个执行：
- 执行前发`tool_execution_start`事件，告诉UI"现在开始跑工具了"
- 用s02的dispatchTool按名字找handler执行
- 执行完发`tool_execution_end`事件
- 不管成功失败，都把结果包成toolResult消息，追加到上下文里

### 3. 判断要不要继续循环
- 如果这一轮一个toolCall都没有，说明模型已经给出最终回答了，循环结束
- 如果有toolCall，带着新的toolResult回到第一步，让模型继续生成下一轮消息

这里有几个非常重要的设计细节，一个都不能错：

#### 退出条件：模型说了算，maxTurns只是兜底
很多人会问：怎么判断任务完成了？要不要写个逻辑判断"回答是不是满意"？
不需要。循环自己不判断"做完没有"，它只看这一轮模型还开不开工具调用。开不开工具、开几个、什么时候停，全是模型自己决定的。

那maxTurns是干嘛的？只是个防御性的兜底，防止模型bug导致无限循环调工具。正常情况下永远不会触发maxTurns，循环都是自然退出的。

#### toolResult严格按开单顺序排列
如果模型一轮调用了多个工具，toolResult必须严格按照toolCall在assistant消息里出现的顺序排列，哪怕你是并行执行的，最后也要按顺序排好再进上下文。

为什么？因为模型是按自己开单的顺序等结果的，如果顺序乱了，模型会把A工具的结果当成B工具的，回答直接就错了。就像医生开了三张检验单，报告回来也得按开单顺序订进病历，医生才不会看串。

#### 工具执行失败不打断循环
工具执行出错了（找不到工具、参数错了、handler抛异常），不要直接抛错中断整个循环。把错误信息包成一个`isError: true`的toolResult，照样进上下文。

模型看到错误信息，自己会决定换个工具、换个参数重试，或者告诉用户"这个操作我做不了"。错误只是工具返回的一种结果，不是整个流程的崩溃。就像检验科做不了某项检查，也会在病历上写"该检查无法完成，原因xxx"，医生看到自然会调整方案。

#### 事件分层：工具执行和消息生成是两个生命周期
工具执行完先发`tool_execution_end`事件，再发toolResult作为消息的`message_start/message_end`事件。这两个是分开的：
- "工具跑完了"是执行状态
- "结果成为上下文里的一条消息"是消息状态
UI可以根据这两个事件做不同的渲染，比如工具跑完先显示个对勾，再把结果慢慢展示出来。

---

## 代码怎么写的

整个循环的主干代码其实很短：
```ts
export async function runEventedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  options: { maxTurns?: number } = {},
) {
  const maxTurns = options.maxTurns ?? 4;
  const messages: LoopMessage[] = [];
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => events.push(event);

  emit({ type: "agent_start" });

  // 一轮一轮循环
  for (let turn = 0; turn < maxTurns; turn++) {
    emit({ type: "turn_start" });

    // 第一步：流式收完assistant消息
    const assistantMessage = await streamAssistant(provider, messages, emit);
    messages.push(assistantMessage);

    // 第二步：提取所有toolCall，逐个执行
    const toolCalls = assistantMessage.content.filter(
      (block): block is ToolCall => block.type === "toolCall"
    );
    for (const toolCall of toolCalls) {
      const result = await executeToolCall(registry, toolCall, emit);
      messages.push(result);
    }

    emit({ type: "turn_end", message: assistantMessage, toolResults });

    // 第三步：没有toolCall就退出
    if (toolCalls.length === 0) {
      break;
    }
  }

  emit({ type: "agent_end", messages });
  return { messages, events, toolResults };
}
```

`streamAssistant`负责把s03的provider事件包装成更上层的agent事件：
- provider的`start` → agent的`message_start`
- provider的各种delta事件 → agent的`message_update`，原provider事件挂在里面不丢
- provider的`done/error` → agent的`message_end`

`executeToolCall`负责真正执行工具，错误处理就在这里：
```ts
let message: ToolResultMessage;
try {
  // 调用s02的dispatchTool执行
  const result = await dispatchTool(registry, toolCall.name, toolCall.arguments);
  message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: result.content }],
    isError: false,
  };
} catch (error) {
  // 出错了也包成正常的toolResult，不打断循环
  message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}
```

---

## 先跑起来看看

```sh
npm run session:s04
```

输出长这样：
```text
Events: agent_start -> turn_start -> message_start -> message_update -> ... -> message_end -> tool_execution_start -> tool_execution_end -> message_start -> message_end -> turn_end -> turn_start -> message_start -> ... -> message_end -> turn_end -> agent_end
Messages: assistant -> toolResult -> assistant
Tool result: read: README.md
Final text: I saw the tool result.
```

注意看事件序列里有两个`turn_start`，说明一共跑了两轮：
- 第一轮：模型生成消息，调用read工具，执行工具，把结果加进上下文
- 第二轮：模型看到工具结果，生成最终回答，没有再调用工具，循环结束

你可以清楚看到`tool_execution_end`在toolResult的`message_start`前面，两个生命周期是分开的。

---

## 动手试一试

### 实验1：用maxTurns掐断循环
给循环传`{ maxTurns: 1 }`再跑。
你会发现最后没有最终回答，消息停在assistant和toolResult——第一轮工具执行完，maxTurns直接把第二轮掐断了。改回2就恢复正常。

体会一下：maxTurns不是正常退出机制，它只是个保险丝，正常退出永远是"这一轮没有toolCall"。

### 实验2：一次调用多个工具，验证顺序
换成多工具provider，一次调用read和bash两个工具：
```ts
createMultiToolCallProvider(
  [{ toolName: "read", args: { path: "README.md" } }, { toolName: "bash", args: { command: "ls" } }],
  "I saw both results."
)
```
你会看到toolResult严格按read→bash的顺序进上下文，把两个工具顺序反过来，toolResult顺序也跟着反过来。

体会一下：报告永远按开单顺序归档，模型不会看串结果。

### 实验3：调用一个不存在的工具
让模型调用一个注册表里没有的工具，比如"delete"。
你会看到工具返回`Unknown tool: delete`的错误，标记了isError:true，但循环没有断，模型照样看到错误生成了最终回答。

体会一下：错误只是工具返回的一种结果，不是崩溃，怎么处理错误是模型的事。

跑完三个实验，你应该能回答下面检查点的问题。改完可以用`npm run test:s04`确认没破坏行为约定。

---

## 本节课打下的地基

s04我们终于把工具执行的循环跑通了，前3节课的零件第一次拼成了能自己转的完整流程：

| 这节课立的约定 | 后面会怎么用 |
|----------------|--------------|
| 工具循环：生成→执行工具→加结果→再生成，直到没有toolCall | 这就是Agent最核心的执行流程，后面所有功能都在这个循环上加 |
| 退出条件：无toolCall则退出，maxTurns仅兜底 | s05 hook、s09扩展都不会改变这个退出逻辑 |
| toolResult严格按toolCall顺序排列 | 多工具、并行执行时都遵守这个顺序，保证模型不会看串 |
| 工具错误包成isError的toolResult，不打断循环 | 权限拦截、危险操作确认也走这个机制 |
| 事件分层：agent级事件包装provider事件，增加turn和工具执行事件 | s10各种运行模式都消费这层统一的事件 |

**本课引入的核心原语**：`runEventedToolLoop` / `ToolResultMessage` / `AgentEvent`（turn_start/end、tool_execution_start/end等）

---

## 检查点

学完这节课，你应该能脱口回答这几个问题：
- 工具执行完为什么不直接把结果给用户，还要再调用一次模型？
- 循环正常退出的条件是什么？maxTurns是干嘛用的？
- 工具执行出错了为什么不直接抛错中断循环？

---

## 本节课小结

这节课我们其实只讲了一个核心道理：
> 工具结果不是给用户的回答，是给模型的下一条输入。循环不替模型做决策，只负责跑腿、记病历、按流程走。

看起来只是加了个for循环，实际上我们终于有了一个真正能跑的Agent——它能自己决定调用工具，能根据工具结果继续回答，出错了也不会直接崩溃。

但现在这个循环还是"来单必做"：模型说调什么就调什么，中间没有任何审核。想读敏感文件就直接读，想跑危险命令就直接跑，连个确认的机会都没有。下节课我们就在工具执行前后加两个钩子，让你可以拦截、审核、修改工具调用，甚至提前终止循环。

进入下一课：[s05 工具钩子 —— 给工具执行加审核和拦截](../s05_tool_hooks/README.zh.md)
