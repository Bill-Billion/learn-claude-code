# 第5课 给工具执行加审核——两个钩子搞定拦截和审计

[English](README.md) · 中文 · [日本語](README.ja.md)

[← s04](../s04_evented_tool_loop/README.zh.md) · [目录](../README.zh.md) · [s06 →](../s06_turn_state/README.zh.md)

上节课我们写的工具循环是"来单必做"：模型说调什么就调什么，中间没有任何审核。真把这个循环用起来，你很快就会遇到三个绕不开的需求：
1. 有些调用根本不该执行——比如读敏感文件、跑rm -rf这种危险命令
2. 有些结果需要改一改再给模型——比如加审计标记、删掉不该暴露的敏感字段
3. 有些工具执行完就该直接结束——比如已经把结果发给用户了，没必要再让模型说废话

这节课我们就在工具执行路径上加两个钩子，把这些能力都开放出来，而且内核一行具体判断都不写。

---

## 先搞懂：把判断直接写进循环里为什么不行？

很多人第一反应是：这还不简单？我在执行工具的地方加几个if不就行了？敏感路径直接return，危险命令直接抛错，执行完notify就break。

这个思路做个demo可以，但做不成通用框架。

第一，**这些判断是和场景强相关的**。什么路径算敏感、什么命令算危险，每个项目、每个用户的标准都不一样，你把这些写死在内核里，换个场景就得改内核代码。

第二，**内核会越改越厚**。今天加个文件权限判断，明天加个命令审计，后天加个结果脱敏，最后工具执行那几行代码会塞满各种业务逻辑，谁也看不懂循环本身在干嘛。

第三，**扩展能力为零**。第三方扩展想加自己的审核逻辑？根本没地方插，只能改内核。

Pi的设计非常克制：内核不做任何具体的业务判断，只在工具执行路径的固定位置留两个"插口"，具体拦不拦、改不改、停不停，全交给外面传进来的钩子函数决定。就像地铁安检：安检机的位置是固定的，但查不查充电宝、查不查液体，是安检员按规定判断的，不是安检机自己决定的。

---

## 两个钩子分别能做什么？

两个钩子分别卡在工具执行的一前一后：
```text
tool_execution_start
  → beforeToolCall （执行前，决定跑不跑）
  → 真正执行本地handler
  → afterToolCall （执行后，决定改不改、停不停）
  → tool_execution_end
  → toolResult进上下文
```

### beforeToolCall：执行前的拦截
在真正调用本地handler之前调用，返回值决定这次调用要不要执行：
- 返回`{ block: true, reason: "xxx" }`：拦截这次调用，handler不执行，reason会被包成一个`isError: true`的toolResult给模型
- 返回undefined或者不返回：放行，正常执行handler

注意：被拦截不是"悄悄跳过"，而是照样生成toolResult、照样发事件、照样进上下文。模型看到拦截原因，自己会决定换个工具、换个参数重试，或者告诉用户"这个操作我做不了"。就像安检拦下了违禁品，也会给你开个条子说明原因，不是直接把东西没收了什么都不说。

### afterToolCall：执行后的处理
handler执行完、toolResult还没进上下文之前调用，可以做两件事：
1. **修改结果**：可以改content（比如加审计前缀、脱敏敏感字段），可以改isError（比如把成功结果改判成错误），没提到的字段保持原样
2. **要求提前结束**：返回`{ terminate: true }`，表示这轮工具执行完就可以停了，不需要再让模型生成下一轮回答

这里有个非常容易搞错的细节：**terminate是"全票通过"语义**。如果一轮有多个工具调用，必须所有工具的afterToolCall都返回terminate:true，循环才会真的提前结束；只要有一个工具没要求终止，就照常进入下一轮。

为什么？因为如果一批工具里有的说"可以停了"，有的说"我还要继续"，你直接停了，后面那个工具的结果模型就看不到了，回答肯定不完整。就像下班：必须组里所有人都做完手头的事才能走，一个人没做完大家都得等。

---

## 代码怎么写的

首先定义两个钩子的类型，所有字段都是可选的——你不需要什么都管，只写你关心的逻辑就行：
```ts
// before钩子能返回的内容
export type BeforeToolCallResult = {
  block?: boolean;
  reason?: string;
};

// after钩子能返回的内容
export type AfterToolCallResult = {
  content?: TextContent[];
  isError?: boolean;
  terminate?: boolean;
};

// 钩子上下文，判断需要的信息都在这里
export type HookContext = {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: Record<string, unknown>;
  messages: LoopMessage[];
};
```

带钩子的工具执行逻辑非常清晰：
```ts
async function executeToolCallWithHooks(...) {
  // 先过before钩子
  const beforeResult = await hooks.beforeToolCall?.(context);
  let message: ToolResultMessage;
  let terminate = false;

  if (beforeResult?.block) {
    // 被拦截了，生成错误的toolResult，handler不执行
    message = createToolResultMessage(toolCall, beforeResult.reason || "Blocked", true);
  } else {
    // 放行，真正执行工具
    message = await runLocalTool(registry, toolCall);
    
    // 再过after钩子
    const afterResult = await hooks.afterToolCall?.({ ...context, result: message, isError: message.isError });
    if (afterResult) {
      // 按钩子返回的内容修改结果，没提到的字段保持原样
      message = {
        ...message,
        content: afterResult.content ?? message.content,
        isError: afterResult.isError ?? message.isError,
      };
      terminate = afterResult.terminate ?? false;
    }
  }

  return { message, terminate };
}
```

循环里收集terminate标记的时候，用的是AND逻辑：
```ts
let shouldTerminate = toolCalls.length > 0;
for (const toolCall of toolCalls) {
  const result = await executeToolCallWithHooks(...);
  messages.push(result.message);
  // 所有工具都要求terminate，才是真的terminate
  shouldTerminate = shouldTerminate && result.terminate;
}

// 两个退出条件：要么没工具调用了，要么全票通过要终止
if (toolCalls.length === 0 || shouldTerminate) {
  break;
}
```

非常重要的一点：**不传钩子的时候，这个循环和s04的循环行为完全一模一样**。钩子是可选的，你不需要为了用循环必须写钩子，两个钩子位置空着就是普通通道。

---

## 先跑起来看看

```sh
npm run session:s05
```

输出长这样：
```text
Blocked result: read is disabled in this lesson
Patched result: audited: read: README.md
Terminated: true
Messages: assistant -> toolResult
```

demo跑了三个场景，正好对应三个能力：
1. 拦截：before钩子返回block，handler根本没执行，返回了拦截原因
2. 修改结果：after钩子在正常结果前面加了"audited: "前缀
3. 提前终止：after钩子返回terminate:true，循环直接结束，没有第二轮模型生成

---

## 动手试一试

### 实验1：只拦截bash，不拦截read
写个before钩子，只拦bash工具，read正常放行，用一次调用两个工具的provider测试。
你会看到read正常返回结果，bash被拦成错误，两个结果都进上下文，循环正常走到最终回答。

体会一下：权限判断就是这么简单，你只需要写判断逻辑，内核已经把位置给你留好了。

### 实验2：验证terminate的全票语义
还是两个工具的批次，只给read的after钩子返回terminate:true，bash不返回。
你会发现循环没有终止，照样生成了最终回答——只有一个工具要求停不算数。
改成两个工具都返回terminate:true，循环才会真的提前结束。

### 实验3：把成功结果改判成错误
在after钩子里，把正常执行的结果加上isError:true，content保持不变。
你会看到工具明明执行成功了，但进上下文的toolResult是错误状态。这和before拦截不一样：before是根本没执行，after是执行完了但结果被改判了。

跑完三个实验，你应该能回答下面检查点的问题。改完可以用`npm run test:s05`确认没破坏行为约定。

---

## 本节课打下的地基

s05我们给工具执行加上了可扩展的钩子，内核从此不再写死任何业务判断：

| 这节课立的约定 | 后面会怎么用 |
|----------------|--------------|
| beforeToolCall可以拦截工具执行，拦截也生成错误toolResult | 权限控制、危险命令确认、敏感路径拦截都走这里 |
| afterToolCall可以修改结果、要求提前终止 | 审计日志、结果脱敏、工具完成直接返回都走这里 |
| terminate是全票通过语义，混合批次不终止 | 多工具调用时不会因为单个工具要求停就漏掉其他结果 |
| 钩子是可选的，不传钩子行为和s04完全一致 | 基础使用不需要关心钩子，需要扩展时再加 |

**本课引入的核心原语**：`beforeToolCall` / `afterToolCall` / `ToolHooks`

---

## 检查点

学完这节课，你应该能脱口回答这几个问题：
- 工具被before钩子拦截了，为什么还要生成toolResult进上下文？直接跳过不行吗？
- 一轮调用了三个工具，其中一个返回terminate:true，循环会停吗？为什么？
- 为什么不把权限判断、审计逻辑直接写在内核的循环里？

---

## 本节课小结

这节课我们其实只讲了一个核心道理：
> 内核只留插口，不做判断。什么能做、什么不能做、做完怎么处理，全是外面的事。

看起来只是加了两个函数参数，实际上这是整个框架可扩展性的关键——权限、审计、确认、限流，所有和具体场景相关的逻辑，都可以通过这两个钩子加进来，内核永远保持薄薄一层，不会被业务逻辑塞爆。

但现在还有个问题：每一轮调用模型的时候，用什么system prompt、给模型看哪些工具、带哪些资源，这些配置现在还是散的。如果一轮执行到一半外面改了配置，就会出现前后不一致的问题。下节课我们就来解决这个问题：每轮开始前先拍个快照，整轮都用快照里的配置，不允许中途变卦。

进入下一课：[s06 轮次状态 —— 每轮开始前先拍快照，整轮只读不写](../s06_turn_state/README.zh.md)
