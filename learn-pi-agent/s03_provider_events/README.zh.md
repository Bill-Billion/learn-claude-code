# 第3课 别等模型全说完再返回——把生成过程变成事件流

[English](README.md) · 中文 · [日本語](README.ja.md)

[← s02](../s02_tool_schema/README.zh.md) · [目录](../README.zh.md) · [s04 →](../s04_evented_tool_loop/README.zh.md)

前两节课我们写的provider都是一次性返回完整结果的：调用complete()，等模型把所有内容都生成完，一下子把整条消息返回给你。写demo没问题，但你平时用AI产品肯定不是这个体验——回答都是一个字一个字蹦出来的，没有哪个产品让你对着空白屏幕等十秒，然后"啪"一下甩给你一整段。

模型本来就是一个token一个token生成的，一次性返回只是我们为了简化做的假设。这节课我们就把这个假设拆掉，把模型的生成过程变成一条可以边生成边消费的事件流。

---

## 先搞懂：加回调函数为什么不行？

很多人第一反应是：这还不简单？我给complete加个回调函数，每生成一段文本就调用一次onText不就行了？

这个方案写个helloworld可以，但做不成框架。

第一，**回调会越加越多**。文本要回调，工具调用的参数也是分片生成的也要回调，开始生成要回调，出错要回调，结束要回调——onText、onToolCall、onError、onStart...函数签名越来越长，维护成本爆炸。

第二，**消费者被写死了**。同一条模型输出，至少有三种消费方式：终端UI要边收边渲染给用户看，RPC模式要把事件序列化成JSONL传给其他进程，agent核心要等整轮生成完再处理工具调用。回调函数把"谁在消费"焊死在了provider的接口上，三种消费方式根本没法共存。

第三，**消费者要自己维护状态**。如果只给你增量delta，你得自己维护一个缓冲区拼文本，自己记哪些工具调用拼到哪了，中途加入的消费者还得先把之前的内容全要一遍才能开始渲染。

正确的做法是把整个生成过程变成一条事件流：开始生成、文本增量、工具调用增量、生成结束、出错，所有这些都是独立的事件，谁想消费谁就来遍历这条流，想怎么处理就怎么处理。

---

## 事件流长什么样？

事件流的设计其实和快递物流跟踪是一个思路：
- 下单后你不会在家死等，而是会收到一条条状态更新：已揽收、到中转站、派送中、已签收
- 任何时候打开物流页面，看到的都是到当前为止的完整轨迹，不需要你自己记之前更新过什么
- 每单最后一定有终态：要么签收，要么退回，没有永远"运输中"的快递

对应到我们的事件流，就是这几个设计原则：

### 1. 完整的事件生命周期
每个内容块（文本、工具调用）都走完整的start → delta → end流程，最后整个流要么done要么error收尾：

| 事件类型 | 触发时机 |
|----------|----------|
| `start` | 整个流开始 |
| `text_start` / `text_delta` / `text_end` | 一段文本块的生成过程 |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 一个工具调用的生成过程 |
| `done` | 正常生成结束 |
| `error` | 生成出错 |

### 2. 每个事件都带完整快照
这是最容易被忽略，但也是最重要的设计：**每个事件都附带一份到当前为止的完整assistant消息快照**。

乍一看有点浪费——delta里已经有增量了，为什么还要带全量？
因为这让消费者可以完全无状态：UI不需要自己维护缓冲区拼文本，中途接入的消费者不需要回放之前的事件，拿到任何一个事件都能直接渲染当前的完整状态。就像物流每次给你推的都是完整轨迹，你不需要自己记之前到哪了。

### 3. 快照必须是克隆的，不能是引用
这是很多人写流式接口踩的第一个坑：provider内部一直在修改同一个partial消息对象，如果yield事件的时候不做深克隆，你之前存下来的所有历史快照，都会被后续的修改悄悄改掉。

举个例子：
- 生成"Pi"的时候你存了个快照，内容是"Pi"
- 后面继续生成" streams"，因为是同一个对象，你之前存的那个快照里的内容也会变成"Pi streams"
- 最后你回头看，所有历史快照都是最终的完整内容，中间状态全丢了

所以每次yield事件之前，都必须调用cloneMessage()做一次深拷贝，把当前状态冻住再发出去。

### 4. 靠contentIndex解决内容块交错
模型生成内容的时候，不一定老老实实把一块内容生成完再生成下一块——很可能第一段文本生成到一半，突然开始生成工具调用，工具调用生成完又回来继续生成第一段文本。

如果你按事件到达顺序直接拼delta，会拼出乱码。所以每个内容事件都带一个contentIndex，不同内容块的delta各自按索引拼接，互不干扰。就像两个快递的物流更新混在同一个通知列表里，你靠运单号把它们分开看。

### 5. 流必须有终态
这是硬约定：一条流要么以done结束，要么以error结束，没有第三种可能。消费者可以靠这个约定拿最终结果——如果for await循环结束了还没收到done或error，说明这个provider是坏的，直接抛错。

---

## 代码怎么写的

首先把事件类型定义全，一共9种事件，用联合类型写死合法的状态转换：
```ts
export type ProviderEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: "error"; error: AssistantMessage };
```

然后provider的输入也升级成结构化的context，把s02的工具定义也加进来：
```ts
export type ProviderContext = {
  messages: AgentMessage[];
  tools: ToolDefinition[]; // s02里listToolDefinitions()返回的结果
  systemPrompt?: string;
};
```

以文本流为例，生成逻辑非常直接：
```ts
async *stream(context: ProviderContext) {
  const partial = createAssistantMessage();
  partial.content.push({ type: "text", text: "" });

  // 流开始
  yield { type: "start", partial: cloneMessage(partial) };
  yield { type: "text_start", contentIndex: 0, partial: cloneMessage(partial) };

  // 逐块生成文本，每个delta都发事件，每次都克隆快照
  for (const chunk of chunks) {
    (partial.content[0] as TextContent).text += chunk;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: chunk,
      partial: cloneMessage(partial), // 每次都要克隆！
    };
  }

  // 文本块结束，整个流结束
  yield { type: "text_end", contentIndex: 0, content: text, partial: cloneMessage(partial) };
  yield { type: "done", reason: "stop", message: cloneMessage(partial) };
}
```

工具调用流的结构和文本流完全同构，只是中间的delta是工具调用参数的JSON片段，最后以reason: "toolUse"收尾。如果工具不在s02给的工具列表里，直接发error事件收尾——哪怕出错，也遵守"流必须有终态"的约定。

消费流也很简单，一个for await循环就搞定：按contentIndex拼文本和工具调用参数，等done或error事件拿最终结果。如果循环结束还没收到终态，直接抛错，抓出不遵守约定的坏provider。

---

## 先跑起来看看

```sh
npm run session:s03
```

输出长这样：
```text
Text events: start -> text_start -> text_delta -> text_delta -> text_delta -> text_end -> done
Text: Pi streams events.
Tool events: start -> toolcall_start -> toolcall_delta -> toolcall_end -> done
Stop reason: toolUse
Tool call: read {"path":"README.md"}
```

第一行是纯文本流的完整事件序列，三个delta对应三段文本。第三行是工具调用流的事件序列，结构和文本流一模一样。

特别注意最后两行：流里已经出现了完整的工具调用（名字、参数都有），但没有任何文件真的被读取。事件流里出来的只是"模型想调用工具"这个意图，真正执行工具是s04的事。

---

## 动手试一试

### 实验1：不克隆快照，亲眼看历史被改写
在文本provider里，把text_delta事件里的`cloneMessage(partial)`改成直接返回partial，然后在demo里把第一个text_delta事件打印出来存着。
等流跑完再看你存的那个事件，你会发现它里面的文本已经变成了完整的最终内容，而不是当时的delta对应的状态。

这就是为什么每次yield都必须克隆——你存的应该是"当时的快照"，而不是一个会跟着后续修改变的引用。

### 实验2：调用一个不存在的工具
把demo里工具调用的名字从"read"改成一个注册表里没有的名字，比如"delete"，再跑demo。
你会看到流直接从start跳到error，不会生成任何工具调用内容。注意哪怕出错，流还是有明确的error终态，不会半路断掉。

### 实验3：交错内容块，验证contentIndex的作用
demo里有个交错生成的provider，它会先生成第一块文本的一半，再生成第二块文本，再回来生成第一块的另一半。
你可以把两个块的delta顺序打乱再跑，只要contentIndex标对了，最后拼出来的两块文本都是完整正确的，不会因为到达顺序乱了就拼错。

体会一下：消费者根本不关心事件到达的顺序，它只认contentIndex。

跑完三个实验，你应该能回答下面检查点的问题。改完可以用`npm run test:s03`确认没破坏行为约定。

---

## 本节课打下的地基

s03我们把provider的输出从一次性返回值改成了事件流，后面所有的输出处理都建立在这个流上：

| 这节课立的约定 | 后面会怎么用 |
|----------------|--------------|
| 事件生命周期：start → *delta → end → done/error | s04工具循环、s10运行模式都会消费这个事件流 |
| 每个事件带完整克隆快照 | UI渲染、日志、RPC序列化都可以无状态消费 |
| contentIndex区分交错内容块 | 支持文本、工具调用、思考过程等多种内容块穿插生成 |
| 流必有终态（done/error） | 消费者可以可靠地拿到最终结果，不会死等 |
| ProviderContext包含messages、tools、systemPrompt | s04工具循环会把s02的工具定义传进来，s08会把资源加载到systemPrompt |

**本课引入的核心原语**：`ProviderEvent` / `ProviderContext` / `EventProvider` / `cloneMessage`

---

## 检查点

学完这节课，你应该能脱口回答这几个问题：
- 为什么每个事件都要带完整的partial快照？只传delta不行吗？
- 为什么yield事件之前必须克隆partial对象？不克隆会发生什么？
- 多个内容块的delta交错到达的时候，靠什么把它们正确拼起来？

---

## 本节课小结

这节课我们其实只讲了一个核心道理：
> 不要等模型把所有话都说完再返回，把生成过程变成一条有明确约定的事件流，谁想消费谁就来拿。

看起来只是把返回值从一个对象变成了一堆事件，实际上这让整个框架的输出层彻底灵活了——终端渲染、日志、RPC、后续工具处理，都可以基于同一条事件流做自己的事，互不干扰。

现在我们已经能从事件流里拿到完整的工具调用意图了：工具名、参数、ID都有，s02的注册表里也躺着对应的处理函数，但这两头还没接起来。下节课我们就把它们接上，写真正的工具执行循环：模型说要调工具，我们就真的去调，把结果再传回给模型，让它继续生成。

进入下一课：[s04 工具循环 —— 模型说调工具，我们就真的去调](../s04_evented_tool_loop/README.zh.md)
