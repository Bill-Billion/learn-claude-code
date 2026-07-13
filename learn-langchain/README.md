# Learn LangChain：从 Model 到 Agent 与 RAG

[返回课程总览](../README-zh.md) | [Learn Claude Code](../learn-claude-code/README.zh.md) | [Learn Pi Agent](../learn-pi-agent/README.zh.md)

13 节课，从一次真实模型调用开始，最后组装出一个能查课程资料、保留对话状态、按需规划并自主调用检索工具的课程助教。

这不是一份 API 速查表。每一课只增加一个机制，并提供课程正文、留空练习、完整实现、流程图和离线测试。你会亲手走完这条路线：

```text
Model -> Messages -> System Prompt -> Prompt Template -> Structured Output
      -> Tool -> Agent -> Streaming -> Memory -> Middleware
      -> Retrieval -> RAG -> Course Assistant
```

## 框架组织 Harness，模型提供判断力

LangChain 经常被介绍成一个 Agent 框架，这句话容易让初学者误会：仿佛调用 `create_agent`，程序就凭空获得了智能。

本课程采用更准确的工程判断：**模型从训练中获得理解、推理和行动选择能力；LangChain 与 LangGraph 把模型周围的 Harness 标准化。** 它们负责消息格式、工具描述、循环执行、状态保存、流式事件和检索接口，却不会替模型决定一个陌生问题该怎么解决。

```text
Agent 应用 = 训练后的模型 + Harness

模型：理解问题、选择工具、判断是否继续、组织回答
Harness：提供消息、工具、知识、状态、执行循环和观察接口
```

固定流程适合写成确定性代码或状态图，需要语义判断的步骤交给模型。好的 Agent 应用通常同时使用两者。框架的价值在于把这些边界做成稳定、可测试的抽象，而不是创造 Agency。

## LangChain、LangGraph 与 RAG 各自负责什么

```text
LangChain 组件层
  Messages + Chat Model + Prompt + Tool + Retriever + Middleware
                              |
                              v
LangGraph 运行时
  state -> model -> tools -> model -> ... -> final state
    |                                      |
    +----------- checkpointer -------------+

RAG 数据流
  files -> chunks -> embeddings -> vector store -> retriever
                                                   |
                    question + retrieved context -> model -> answer
```

- **LangChain** 提供面向应用的统一组件。课程中的模型、消息、提示模板、工具、Retriever 和 Middleware 都从这里进入。
- **LangGraph** 负责有状态的图运行时。`create_agent` 返回的 Agent 底层是一张编译后的状态图，模型节点与工具节点在图中循环；流式更新和 Checkpointer 也建立在这层状态上。
- **RAG** 是检索增强生成的数据流，不是另一个 Agent 框架。s12 用确定性代码先检索再生成，s13 再把 Retriever 包装成工具，由模型决定什么时候查资料。

先学 LangChain 的高层接口，不要求你预先掌握 LangGraph。学到 s07 后，你会知道框架替你运行了怎样的循环；学到 s09 后，再看清状态如何按会话保存。

## 所有 API 最终都映射到同一个 Agent Loop

不用框架时，带工具的最小 Agent Loop 大致如下：

```python
messages = [user_message]

while True:
    response = model(messages, tools)
    messages.append(response)

    if not response.tool_calls:
        return response

    for call in response.tool_calls:
        result = run_tool(call)
        messages.append(result)
```

LangChain 没有消灭这个循环，它只是把每一部分映射成稳定接口：

| 循环中的职责 | 本课程里的 LangChain / LangGraph 映射 |
| --- | --- |
| 保存对话轨迹 | `HumanMessage`、`AIMessage`、`ToolMessage` 与 `messages` 状态 |
| 调用模型 | `init_chat_model(...)` 后执行 `model.invoke(...)` |
| 描述可用动作 | 用 `@tool` 从函数签名和 docstring 生成工具 schema |
| 让模型选择动作 | `create_agent(model=..., tools=[...])` |
| 执行工具并回填结果 | 状态图中的 `tools` 节点与 `ToolMessage` |
| 判断是否结束 | 最后一条不含工具调用的 `AIMessage` |
| 观察执行进度 | `agent.stream(..., stream_mode="updates")` |
| 保存会话状态 | `checkpointer` 与 `thread_id` |
| 插入通用能力 | `middleware=[TodoListMiddleware()]` |
| 接入私有知识 | `retriever.invoke(query)`，或把 Retriever 包装成工具 |

理解这张映射表，比背诵孤立 API 更重要。换框架时，方法名会变；消息、模型、动作、工具结果、状态和终止条件仍然存在。

## 这门课适合谁

这门课适合已经会写基础 Python，希望从可运行代码进入 LangChain 1.x 的开发者。你不需要预先学过 LangChain、LangGraph、向量数据库或 RAG。

开始前最好具备这些基础：

- 会运行 Python 模块，能看懂函数、类、类型注解和字典。
- 会在终端中使用虚拟环境与环境变量。
- 想运行真实模型示例时，准备一个 OpenAI API Key；只做练习和测试不需要 Key。
- 本地 Python 版本为 3.11 或更高，并已安装 `uv`。

建议给每课预留 30 到 60 分钟。只通读完整实现大约需要半天；填写全部 Starter、运行真实示例并完成自检，安排一到两天更合适。

## 快速开始

从仓库根目录进入本课程：

```bash
cd learn-langchain
uv sync --locked --extra dev
cp .env.example .env
```

`.env.example` 默认使用 `LANGCHAIN_MODEL=openai:gpt-4.1-mini`，并把 `OPENAI_API_KEY` 留空等待本地填写。

把自己的 `OPENAI_API_KEY` 写入 `.env` 后，可以运行第一课的真实模型示例：

```bash
uv run python -m s01_first_model.code
```

仓库开箱安装 `langchain-openai`。切换其他 Provider 时，需要另外安装对应的 LangChain 集成包，并按该 Provider 的要求配置密钥。`init_chat_model` 统一调用接口，不会自动安装所有厂商 SDK。

### 没有 API Key 也能学什么

所有课程测试都保持离线，不发起真实模型或 Embedding 请求：

```bash
uv run python scripts/check_lessons.py
uv run pytest -q
```

测试使用 Fake Chat Model、可调用工具的测试替身和 Deterministic Fake Embedding，验证消息结构、工具轨迹、状态隔离和数据流。Fake Embedding 不理解语义，因此测试通过只能说明检索管道接通了，不能证明真实检索质量。

真实运行的边界如下：

- s01-s05 与 s07-s10 默认调用 `LANGCHAIN_MODEL`，需要对应 Provider 的 API Key。
- s06 只执行本地 `count_words` 工具，不需要模型或 API Key。
- s11 默认使用 `OpenAIEmbeddings`，需要 `OPENAI_API_KEY`。
- s12-s13 同时使用真实 Chat Model 和 `OpenAIEmbeddings`，默认需要 `OPENAI_API_KEY`。

## 每一课怎么学

每个课程目录都包含同一组学习材料：

1. 先读 `README.md`，理解本课要解决的问题和相对上一课增加的机制。
2. 打开 `starter.py`，只填写下划线留空处。Starter 是练习脚手架，填完前不保证可运行。
3. 对照 `code.py`，核对输入类型、返回类型和组件边界，不要只比较最终输出。
4. 运行完整实现，再运行本课测试。测试文件也是最短的行为规格。
5. 回答课程 README 末尾的检查点，再进入下一课。

完整实现统一用模块方式运行：

```bash
uv run python -m s01_first_model.code
uv run pytest s01_first_model/tests -q
```

把目录名替换成当前课程即可。所有命令都应在 `learn-langchain/` 目录执行。

## 13 课渐进路线

### 第一阶段：建立模型与程序之间的契约

这一阶段不急着做 Agent。先把模型调用、上下文、规则、提示变量和程序可读输出分开，否则后面的循环只会放大混乱。

### [s01 第一次模型调用](./s01_first_model/)
> **格言：换模型时，业务逻辑不该跟着重写。**
- 新增机制：用 `init_chat_model` 建立统一模型入口，通过 `model.invoke` 得到 `AIMessage`。
- 运行与自测：`uv run python -m s01_first_model.code`；`uv run pytest s01_first_model/tests -q`
- 学习收获：分清模型返回对象与回答文本，并知道统一接口能屏蔽什么、不能屏蔽什么。

### [s02 消息列表](./s02_messages/)
> **格言：多轮上下文要标清角色，不能靠字符串猜。**
- 新增机制：用 `HumanMessage` 和 `AIMessage` 表达有角色的对话历史。
- 运行与自测：`uv run python -m s02_messages.code`；`uv run pytest s02_messages/tests -q`
- 学习收获：理解消息列表是模型、工具和记忆共享的上下文载体。

### [s03 系统提示](./s03_system_prompt/)
> **格言：稳定规则和临时问题应该各有位置。**
- 新增机制：把角色与回答风格放进 `SystemMessage`，把当前问题放进 `HumanMessage`。
- 运行与自测：`uv run python -m s03_system_prompt.code`；`uv run pytest s03_system_prompt/tests -q`
- 学习收获：建立提示的职责边界，同时理解系统提示是行为引导，不是权限系统。

### [s04 提示模板](./s04_prompt_template/)
> **格言：提示应当填变量，不应当到处拼字符串。**
- 新增机制：用 `ChatPromptTemplate` 分离固定消息骨架与动态输入。
- 运行与自测：`uv run python -m s04_prompt_template.code`；`uv run pytest s04_prompt_template/tests -q`
- 学习收获：生成标准消息列表，并让变量缺失在调用模型前明确报错。

### [s05 结构化输出](./s05_structured_output/)
> **格言：程序要处理结果，就先把输出契约写出来。**
- 新增机制：用 Pydantic `BookNote` 与 `with_structured_output` 约束返回结构。
- 运行与自测：`uv run python -m s05_structured_output.code`；`uv run pytest s05_structured_output/tests -q`
- 学习收获：让模型调用直接返回可验证对象，而不是用正则猜自由文本。

### 第二阶段：把模型接入行动与状态

s06 先造一个确定性工具，s07 才把是否调用工具的判断交给模型。之后依次打开执行过程、保存会话状态，并通过 Middleware 注入规划能力。

### [s06 第一个工具](./s06_first_tool/)
> **格言：模型负责判断，函数负责确定性执行。**
- 新增机制：用 `@tool` 把函数名、参数类型和 docstring 转成标准工具 schema。
- 运行与自测：`uv run python -m s06_first_tool.code`；`uv run pytest s06_first_tool/tests -q`
- 学习收获：理解工具只是可描述、可校验、可执行的动作；本课仍由程序手动调用。

### [s07 第一个 Agent](./s07_first_agent/)
> **格言：模型决定下一步，Harness 负责把循环跑完。**
- 新增机制：用 `create_agent` 组合模型、`count_words` 工具和系统提示。
- 运行与自测：`uv run python -m s07_first_agent.code`；`uv run pytest s07_first_agent/tests -q`
- 学习收获：读懂 `model -> tools -> model` 循环，以及最终返回的完整消息轨迹。

### [s08 流式更新](./s08_streaming/)
> **格言：长任务不能只交付答案，也要暴露执行进度。**
- 新增机制：用 `agent.stream(..., stream_mode="updates")` 逐节点消费状态更新。
- 运行与自测：`uv run python -m s08_streaming.code`；`uv run pytest s08_streaming/tests -q`
- 学习收获：区分节点级更新与逐 Token 输出，并从更新中识别模型和工具节点。

### [s09 短期记忆](./s09_short_term_memory/)
> **格言：会话 ID 负责定位，Checkpointer 才真正保存状态。**
- 新增机制：给 Agent 挂上 `InMemorySaver`，用 `thread_id` 隔离并恢复消息状态。
- 运行与自测：`uv run python -m s09_short_term_memory.code`；`uv run pytest s09_short_term_memory/tests -q`
- 学习收获：每轮只传新消息，并验证同一线程累积历史、不同线程互不串话。

### [s10 Todo Middleware](./s10_todo_middleware/)
> **格言：横切能力挂在扩展点上，不要重写 Agent Loop。**
- 新增机制：通过 `middleware=[TodoListMiddleware()]` 注入 `write_todos` 工具与 Todo 状态。
- 运行与自测：`uv run python -m s10_todo_middleware.code`；`uv run pytest s10_todo_middleware/tests -q`
- 学习收获：理解 Middleware 如何扩展 Agent，同时保留原来的模型、消息和调用方式。

### 第三阶段：让回答有可检索的依据

RAG 先从固定数据流学起。s11 只负责找资料，s12 把资料交给模型回答，s13 才让模型自行决定是否调用检索工具。

### [s11 检索基础](./s11_retrieval_basics/)
> **格言：Retriever 的契约是输入问题，返回候选文档。**
- 新增机制：加载 Markdown、切块、生成 Embedding、写入 `InMemoryVectorStore`，再调用 Retriever。
- 运行与自测：`uv run python -m s11_retrieval_basics.code`；`uv run pytest s11_retrieval_basics/tests -q`
- 学习收获：理解 `Document`、来源元数据、切块和 Top-K 检索各自承担的职责。

### [s12 最小 RAG](./s12_minimal_rag/)
> **格言：先检索再生成，数据流不必伪装成 Agent。**
- 新增机制：用确定性代码串起 Retriever、上下文格式化、`RAG_PROMPT` 与 Chat Model。
- 运行与自测：`uv run python -m s12_minimal_rag.code`；`uv run pytest s12_minimal_rag/tests -q`
- 学习收获：看清 RAG 的固定三段式，并保留 `[文件名]` 来源标签。

### [s13 综合课程助教](./s13_comprehensive_project/)
> **格言：机制组装完成后，仍由模型决定何时行动。**
- 新增机制：不再增加新原语，把检索工具、系统提示、Todo Middleware 与 Checkpointer 接到同一个 Agent。
- 运行与自测：`uv run python -m s13_comprehensive_project.code`；`uv run pytest s13_comprehensive_project/tests -q`
- 学习收获：完成一个能保存同线程对话、规划任务、搜索课程笔记并基于资料回答的助教。

## 综合项目最终接成什么

s13 的 `build_assistant` 组装了四条已经分别验证过的能力：

```text
用户问题
  -> create_agent
       -> TodoListMiddleware 提供 write_todos
       -> 模型判断是否调用 search_course_notes
       -> Retriever 返回带 [文件名] 的候选片段
       -> 模型根据工具结果生成回答
  -> InMemorySaver 按 thread_id 保存消息状态
```

这个项目有意保持教学规模。知识库只有本地 Markdown，向量库在内存中，进程退出后状态不会保留；`[文件名]` 是 Prompt 要求模型保留的文本标签，不是经过程序核验的引用系统。把它改成生产服务前，还需要持久化存储、认证授权、限流重试、可观测性、检索评估和真实模型评测。

## 项目结构

```text
learn-langchain/
├── README.md                 # 课程总入口
├── pyproject.toml            # Python 3.11 与依赖约束
├── uv.lock                   # 可复现的锁定依赖
├── .env.example              # 模型与 API Key 示例
├── shared/                   # 消息处理与离线测试替身
├── scripts/check_lessons.py  # 13 课结构检查
├── tests/smoke/              # 课程级冒烟测试
├── s01_first_model/
│   ├── README.md             # 完整课程正文
│   ├── starter.py            # 留空练习
│   ├── code.py               # 可运行完整实现
│   ├── tests/                # 本课离线测试
│   └── assets/flow.mmd       # 流程图源文件
├── ...
└── s13_comprehensive_project/
```

s11-s13 还各自包含小型 `knowledge/` 目录，用于演示从本地 Markdown 到 Retriever 和 RAG 的完整链路。

## 质量检查

提交修改前，在课程目录运行完整检查：

```bash
uv run python scripts/check_lessons.py
uv run ruff check .
uv run mypy .
uv run pytest -q
```

`check_lessons.py` 会确认 13 个目录都具备 README、Starter、完整实现、测试和 Mermaid 图。Ruff 与 Mypy 检查课程代码，Pytest 验证离线行为。真实 Provider 的响应质量和真实 Embedding 的语义排序仍需单独评测，不能用 Fake Model 测试代替。

## 与另外两门课程如何配合

- [Learn Claude Code](../learn-claude-code/README.zh.md) 从一个直接可见的 Python Agent Loop 出发，逐步加入权限、Hook、上下文压缩、Subagent、Team、MCP 和目标闭环。想理解框架底层到底替你做了什么，先读它。
- [Learn Pi Agent](../learn-pi-agent/README.zh.md) 用 TypeScript 展开事件、Session、Extension 和运行时边界。想比较函数式课程代码与事件驱动 Harness，可以把同类章节横向阅读。
- **Learn LangChain** 把模型、工具、状态与检索映射到现成框架接口。近期目标是快速开发 Agent 或 RAG 应用，可以从本课程开始，再回到另外两门课补底层机制。

三门课程依赖彼此独立，不需要一起安装。共同的判断不变：模型提供 Agency，课程代码与框架负责把工具、知识、状态和执行环境组织成 Harness。

## 范围说明

前 13 课不展开 LCEL、LangGraph 自定义图、MCP、多 Agent、Deep Agents、外部向量数据库和生产部署。它们都可以沿着本课程的组件边界继续学习，但不适合挤进第一条主线。

课程也不把 RAG 的固定流水线叫作 Agent。s12 的下一步由代码预先确定；s13 把检索变成工具后，模型才拥有是否检索的选择权。这个区别会直接影响调试、评测和权限设计。

## 许可证

本项目采用仓库根目录的 [MIT License](../LICENSE)。
