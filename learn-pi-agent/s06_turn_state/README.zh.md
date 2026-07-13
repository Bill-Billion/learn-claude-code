# 第6课 每轮开始先拍快照——别让中途改配置搞崩整轮请求

[English](README.md) · 中文 · [日本語](README.ja.md)

[← s05](../s05_tool_hooks/README.zh.md) · [目录](../README.zh.md) · [s07 →](../s07_session_tree/README.zh.md)

前面五节课我们写的循环，一直活在一个理想世界里：参数传进来是什么，跑完还是什么，中间不会有人改。但真实运行的时候根本不是这样——一轮请求跑到一半，外面的世界随时可能变：
- 用户中途切换了模型
- 扩展动态加载了新的skill，改了system prompt
- 别的线程改了请求超时、headers这些配置

如果循环每一步都直接读全局变量，就会出现非常诡异的bug：前半轮请求发给模型A，后半轮发给模型B；system prompt是按旧工具生成的，实际请求却带了新工具；两次请求的超时时间不一样，出了问题日志根本对不上。这种bug最烦人的地方在于：单看每一步代码都没错，错的是两步之间世界变了。

这节课我们就来解决这个问题：每轮开始前先把所有配置拍个快照，整轮执行只读快照，外面怎么改都影响不到当前轮。

---

## 先搞懂：靠约定"别在轮次中间改配置"为什么不行？

很多人第一反应是：这还不简单？立个规矩，告诉大家一轮执行的时候别改配置不就行了？

这个约定根本守不住。

第一，**你管不住所有人**。扩展是第三方写的，用户想什么时候切模型就什么时候切，你不可能要求所有人都遵守这个约定。

第二，**外部根本不知道一轮什么时候开始什么时候结束**。循环什么时候在跑、什么时候在等工具执行、什么时候在等模型返回，只有循环自己知道，外面根本判断不了"现在改配置安不安全"。

第三，**这种时序bug根本没法debug**。出了问题你看日志，每一行单独看都是对的，拼起来就是不对，复现都复现不了。

正确的做法非常简单，就像装修队开工前一定会做的事：把甲方签字确认的所有图纸、材料单、施工要求全部拍照存档，这一期施工从头到尾只认这一套照片。开工之后甲方改主意了？可以，新要求收下来，但这一期还是按老图纸干，下一期开工再拍新照片用新要求。

我们的每一轮请求就是一期施工，turn state就是那套拍好的照片。

---

## 快照里都有什么？

一轮请求需要的所有配置，全部在拍快照的时候确定下来，整轮不会变：

| 字段 | 内容 |
|------|------|
| messages | 当前会话的所有历史消息 |
| systemPrompt | 这一轮的系统提示词 |
| model | 这一轮用哪个模型 |
| tools | 所有注册过的工具（本地执行用） |
| activeTools | 这一轮真正给模型看的工具子集 |
| resources | 这一轮可用的skill、prompt模板等资源 |
| streamOptions | 超时、headers、metadata等请求选项 |
| sessionId | 会话ID，用于日志和缓存 |

这里有两个非常重要的设计细节：

### 两份工具名单：全量注册和本轮启用
你可能会问：tools和activeTools为什么要分开？直接把要给模型的工具传进来不就行了？
因为本地执行工具的时候，需要知道所有注册过的工具（不然怎么dispatch？），但给模型看的时候，不一定每次都要把所有工具都列出来——比如有些工具是内部用的，有些工具这一轮用不上，就没必要给模型看，避免干扰。

就像装修队的仓库里什么工具都有，但这一期施工只带需要用的几样去工地，不会把整个仓库都搬过去。

注册的时候还会校验activeTools里的名字是不是都在tools里，有不存在的直接在开工前报错，不会等请求发给模型了才发现工具不存在。

### systemPrompt可以是函数，拍快照时才生成
systemPrompt不一定是写死的字符串，也可以是个函数。因为这一轮有哪些activeTools、哪些resources，只有拍快照的这一刻才确定，动态生成的systemPrompt才能准确反映当前轮次的情况。

比如demo里的systemPrompt就是动态生成的，会把当前启用的工具和skill都列进去，保证systemPrompt里说的和实际给模型的永远一致。

---

## 快照必须是断开引用的深拷贝

很多人写快照容易犯一个错：把所有字段塞进一个对象里就以为是快照了。不对——如果对象里的字段还是外面的引用，外面改了，你的"快照"还是会跟着变，那根本不叫快照，只是换了个地方引用全局变量而已。

所以拍快照的时候，每个字段都要做拷贝，彻底断开和外部的引用：
- 数组要map一遍复制每个元素
- 对象要展开复制
- 消息要cloneMessage
- 嵌套的配置也要深拷贝

就像你拍照片，照片里的内容是定格的，现实中东西怎么动，照片里的内容不会变。如果你的"照片"是个实时直播，那叫什么快照？

拍好快照之后，这一轮和外部世界的连线就彻底断了：外面再怎么改配置、加工具、换资源，当前轮次都看不见，所有修改只会在下一轮拍新快照的时候生效。

---

## 补充：内部消息和发给模型的消息不是一回事

这里提一个真实Pi里有、我们简化版没做的设计，避免你看源码的时候困惑：
Pi内部用的AgentMessage和发给大模型的标准LLM Message不是同一个东西。内部消息可以带很多额外信息：UI提示、扩展的自定义数据、分支摘要、内部标记等等，这些东西是不能发给模型的。

所以每轮真正发请求之前，会有一步转换：先把内部的AgentMessage整理一遍，再转换成模型认识的标准消息格式。就像项目部内部的台账什么都记——会议纪要、内部备注、私人笔记，但报给甲方的只有整理好的正式报告。

这层转换让Pi内部可以随便扩展消息类型，不用担心污染给模型的请求。我们的教学版为了简单，消息类型直接用了模型认识的格式，所以没有这一步，但你要知道真实Pi里有这个设计。

---

## 代码怎么写的

首先harness初始化的时候，就把全量工具列表和active工具名单确定好，提前做校验：
```ts
export function createMiniHarness(options: MiniHarnessOptions) {
  // 复制全量工具列表
  const tools = options.registry.tools.map((tool) => ({ ...tool }));
  // 确定本轮启用的工具，默认全部启用
  const activeToolNames = options.activeToolNames 
    ? [...options.activeToolNames] 
    : tools.map((tool) => tool.name);
  
  // 开工前校验：启用的工具必须都存在
  validateActiveToolNames(tools, activeToolNames);

  return {
    async createTurnState() {
      // 拍快照的逻辑
    }
  };
}
```

拍快照的逻辑就是把所有需要的字段都收集齐，每个字段都做拷贝：
```ts
async createTurnState() {
  // 从session取当前消息和元数据
  const context = await options.session.buildContext();
  const metadata = await options.session.getMetadata();
  
  // 按active名单选出这轮给模型看的工具
  const activeTools = activeToolNames.map((name) => 
    tools.find((tool) => tool.name === name)!
  );

  // 生成systemPrompt（支持函数动态生成）
  const resolvedSystemPrompt = typeof options.systemPrompt === "function"
    ? options.systemPrompt({ activeTools, resources: options.resources })
    : options.systemPrompt;

  // 每个字段都拷贝，彻底断开引用
  return {
    messages: context.messages.map(cloneMessage),
    resources: cloneResources(options.resources),
    streamOptions: cloneStreamOptions(options.streamOptions),
    sessionId: metadata.id,
    systemPrompt: resolvedSystemPrompt,
    model: { ...options.model },
    tools: tools.map((tool) => ({ ...tool })),
    activeTools: activeTools.map((tool) => ({ ...tool })),
  };
}
```

就这么简单。没有什么黑魔法，就是在每轮开始的时候把所有配置冻住，整轮都用这份冻住的配置。

---

## 先跑起来看看

```sh
npm run session:s06
```

输出长这样：
```text
Session: demo-session
Messages: 1
Active tools: read
System prompt: tools=read skills=audit
Timeout: 30
```

注意看：注册表里其实有read和bash两个工具，但我们只启用了read，所以active tools只有read，system prompt里也只列了read——两处永远一致，不会出现"prompt说有bash实际没给"的错位。

---

## 动手试一试

### 实验1：启用所有工具
把activeToolNames改成["read", "bash"]再跑。
你会看到active tools变成了read,bash，system prompt里也同步变成了read,bash，两处永远是一致的。

### 实验2：启用不存在的工具
把activeToolNames改成["not-exist"]再跑。
你会看到程序在创建harness的时候就直接报错Unknown active tool: not-exist，根本走不到拍快照那一步。
体会一下：图纸有问题开工前就发现，比墙砌到一半才发现图纸错了好处理得多。

### 实验3：修改第一张快照，看会不会影响第二张
连续拍两张快照，把第一张快照里的工具名改成"hacked"，再看第二张快照里的工具名是什么。
你会发现第二张快照里还是read，完全不受第一张修改的影响。如果把代码里的拷贝去掉，直接返回引用，第二张快照也会变成hacked——这就是为什么必须深拷贝断开引用。

跑完三个实验，你应该能回答下面检查点的问题。改完可以用`npm run test:s06`确认没破坏行为约定。

---

## 本节课打下的地基

s06我们给每轮请求加上了稳定的快照，彻底解决了轮次中间配置变化导致的不一致问题：

| 这节课立的约定 | 后面会怎么用 |
|----------------|--------------|
| 每轮开始前拍TurnState快照，整轮只读快照 | s07 session、s08资源加载、s09扩展、s10运行模式都基于快照工作 |
| tools是全量注册工具，activeTools是本轮给模型的子集 | 内部工具、上下文相关的工具可以选择性展示给模型 |
| systemPrompt支持拍快照时动态生成 | 工具、资源变化时systemPrompt自动同步，不会错位 |
| 快照必须深拷贝断开引用 | 外部修改配置不影响当前轮，下轮才生效 |
| 开工前校验配置合法性 | 错误尽量早发现，不把问题留到发请求的时候 |

**本课引入的核心原语**：`TurnState` / `createMiniHarness` / `createTurnState`

---

## 检查点

学完这节课，你应该能脱口回答这几个问题：
- 为什么不能靠约定"轮次中间别改配置"来保证一致性？
- tools和activeTools为什么要分成两个字段？
- 为什么拍快照的时候必须深拷贝，直接把对象塞进去不行吗？

---

## 本节课小结

这节课我们其实只讲了一个核心道理：
> 一轮请求的起点必须是稳定的，开工只认拍好的快照，中途世界怎么变都等下一轮再说。

看起来只是多了个创建快照的步骤，实际上这彻底解决了多线程、动态配置、扩展加载带来的时序不一致问题，让每一轮请求的行为都是可预测、可复现的。

但到现在为止，我们的session还只是个简单的消息数组，只能线性往前走。真实使用的时候，你经常需要回到之前的某个问题，换个问法重新走一条分支，这时候简单的数组就不够用了——总不能为了试个新问法把之前的历史都删了吧？下节课我们就把session改成可分支的树结构，想回哪就回哪，历史永远不丢。

进入下一课：[s07 会话树 —— 想回滚就回滚，历史永远不丢](../s07_session_tree/README.zh.md)
