# Learn LangChain：从 Model 到 Agent 与 RAG

这是一个面向初学者的 LangChain 中文课程仓库。它沿用 [learn-claude-code](../learn-claude-code/) 的教学机制：一课一个目录、一课一个新机制、每课可运行、每课有离线测试；但课程内容只围绕 LangChain 真实公开 API，不复制 Claude Code 的产品主线。

本课程包含 13 节主线课：

| 章节 | 新增机制 | 核心 API |
|---|---|---|
| `s01_first_model` | 第一次模型调用 | `init_chat_model`, `model.invoke` |
| `s02_messages` | 消息列表 | `HumanMessage`, `AIMessage` |
| `s03_system_prompt` | 系统提示 | `SystemMessage` |
| `s04_prompt_template` | 提示模板 | `ChatPromptTemplate` |
| `s05_structured_output` | 结构化输出 | `with_structured_output`, `BaseModel` |
| `s06_first_tool` | 第一个工具 | `@tool` |
| `s07_first_agent` | 第一个 Agent | `create_agent` |
| `s08_streaming` | 流式更新 | `agent.stream(..., stream_mode="updates")` |
| `s09_short_term_memory` | 短期记忆 | `checkpointer`, `InMemorySaver` |
| `s10_todo_middleware` | Todo 规划中间件 | `TodoListMiddleware` |
| `s11_retrieval_basics` | 检索基础 | `Document`, `RecursiveCharacterTextSplitter`, `InMemoryVectorStore` |
| `s12_minimal_rag` | 最小 RAG | retriever + prompt + model |
| `s13_comprehensive_project` | 综合课程助教 | retrieval tool + agent + memory |

## 运行

```bash
uv sync --locked --extra dev
cp .env.example .env
uv run python -m s01_first_model.code
uv run pytest -q
```

没有 API key 也可以跑测试。每节课的单测都使用 LangChain fake model、fake embedding 或小型测试替身，不调用真实模型。

仓库默认安装并开箱支持 OpenAI：设置 `OPENAI_API_KEY` 后即可运行示例。若要换成其他 provider，需要另行安装对应的 LangChain 集成包并设置它要求的密钥。另请注意，s11-s13 默认使用 `OpenAIEmbeddings`；除非你在代码中注入其他 embeddings 实现，否则这三课仍需要 `OPENAI_API_KEY`。

## 每课怎么学

1. 先读本课 `README.md`，只抓住“本课新增的一个机制”和相对上一课的差分。
2. 打开 `starter.py` 完成带提示的留空处；它是练习脚手架，填完前不保证可运行。
3. 再对照完整的 `code.py`，确认输入类型、调用方式和返回类型。
4. 运行本课测试；离线测试验证结构和数据流，不替代真实 provider 的行为评估。

## 两条稳定主线

整个课程有两条互相配合、但不要混为一句口号的主线：

1. **model / agent 用消息承载对话上下文。** `HumanMessage`、`AIMessage`、`SystemMessage` 和 `ToolMessage` 让每段上下文的角色与来源保持清楚；agent 也是在消息轨迹上追加模型决定、工具结果和最终回答。
2. **LangChain 组件遵守统一的可调用约定，并公开明确的类型契约。** 单次调用通常使用 `.invoke(input)`，流式场景使用 `.stream(input)`；但不同组件的输入输出并不都叫“消息”：结构化 model 返回 Pydantic 对象，tool 返回工具结果，retriever 返回 `Document` 列表，agent 返回包含消息轨迹的状态。

所以学习时可以一直问两个问题：**这一组件怎样调用？它接收什么、返回什么？** 后面的模板、工具、记忆、检索和 RAG，都是在这两条主线上逐层组合。

## 学习边界

主线故意不讲 LangGraph 深层编排、MCP、多智能体、Deep Agents 和生产级外部向量数据库。它们不是不重要，而是不适合作为初学者前 13 课的主干。这里先把 Message -> Model -> Tool -> Agent -> Memory -> Retrieval -> RAG 的骨架走稳。

也**不讲 LCEL**（`prompt | model | parser` 那套管道）。原因很具体：`create_agent` 内部并不用管道，它直接用 `StateGraph` 编排——所以初学者用 `create_agent` 构建 agent 完全不需要先学管道。LCEL 是一个进阶话题，s13 结课的"进阶路线图"里有说明。
