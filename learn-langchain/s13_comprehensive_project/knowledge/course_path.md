本课程主线是 Message 到 Model 到 Tool 到 Agent 到 Memory 到 Retrieval 再到 RAG。Runnable、classic chains 和 LangGraph 适合作为后续对照，不放进初学者主线。这条主线的目标是把一条最小可运行的骨架走稳。

s01 到 s05 是输入和输出的控制。s01 打通第一次模型调用，s02 引入消息列表，s03 用系统提示分离规则，s04 用模板管理变量，s05 用结构化输出让返回值变成程序能用的对象。这五课都还没有 agent。

s06 到 s10 是能力和状态。s06 第一次把 Python 函数变成工具，s07 用 create_agent 把工具交给循环，s08 用流式看到执行过程，s09 用 checkpointer 给同一线程加记忆，s10 用 middleware 在 agent 生命周期中注册规划工具、状态和规则。

s11 到 s13 是知识增强。s11 打通检索的最小链路，把文档切分、向量化、存储、检索走一遍；s12 把检索结果交给模型组成最小 RAG；s13 把前面的零件焊成一个能自己决定何时查资料的课程助教。

这门课程的不变核心是：先看清组件的输入输出约定，再用 `.invoke()` 调用。chat model 接收字符串或消息并返回 `AIMessage`，retriever 接收查询字符串并返回 `Document` 列表，agent 接收消息状态并返回包含完整轨迹的状态字典。工具、记忆和检索是在这些明确类型边界上组合起来的。

学完主线再去看 LangGraph 深层编排、LangSmith、MCP 和多智能体会更稳。它们是进阶，不是初学者的第一条主线；先建立消息到 agent 的心智模型，再揭开 create_agent 底下那层状态图。
