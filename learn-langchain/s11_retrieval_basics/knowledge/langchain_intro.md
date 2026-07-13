LangChain 是一个用于构建 LLM 应用和 agent 的框架。它的核心理念是可组合性：模型、消息、提示模板、工具、记忆和检索都是独立的组件，可以按需拼装，而不是绑死在一个大而全的类里。

init_chat_model 是统一的模型入口。你给它一个带 provider 前缀的字符串，比如 openai:gpt-4o-mini，它返回一个行为一致的 chat model。不管底层是哪家 provider，你都用同一个 invoke 方法，拿到同一种返回类型，换 provider 只需要改这个字符串。

消息是 LangChain 的基础数据类型。HumanMessage 代表用户输入，AIMessage 代表模型回复，SystemMessage 用于设定行为规则，ToolMessage 携带工具执行结果。每种消息都有 content 字段和 type 字段，模型看到的从来不是一段纯文本，而是一组带角色的消息。

AIMessage 是最丰富的消息类型。除了 content，它还带 tool_calls 字段，记录模型想调用哪些工具；带 usage_metadata 字段，记录这次调用消耗了多少 token。当模型决定调用工具时，工具名和参数就放在 tool_calls 里。

ChatPromptTemplate 把提示的骨架和变量分开。骨架里用花括号写占位符，调用时再填变量。漏传变量会当场报错，而不是把字面的花括号发给模型。模板最终产出的还是一组消息，所以它和手写消息列表无缝衔接。

结构化输出让模型返回程序能直接用的对象。你定义一个 Pydantic 模型描述想要的字段，调用 with_structured_output，模型的返回值就从自由文本变成一个填好的对象，不用再写正则去抠信息。
