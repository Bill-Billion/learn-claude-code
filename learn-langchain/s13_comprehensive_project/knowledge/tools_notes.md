LangChain 的 tool 来自普通 Python 函数。函数名、参数和 docstring 会成为模型选择工具时的重要上下文。@tool 装饰器读这三样东西，自动生成模型能看懂的工具说明，工具本质上还是一个可以直接 invoke 的函数。

docstring 不是可有可无的注释。它是模型看到的工具描述，直接决定模型什么时候选择调用这个工具。一个含糊的 docstring 会让模型用错工具或者不用；写清楚工具做什么、什么时候用，比写函数体还重要。

工具的参数类型注解会变成 JSON schema。模型根据这个 schema 知道每个参数要填什么类型。用 @tool(parse_docstring=True) 还能把 Google 风格 docstring 里的 Args 段落变成逐参数的描述，让模型填参数时更准确。

Agent 通过 tool_calls 调用工具。模型在 AIMessage 里给出想调用的工具名和参数，框架执行工具，把结果包成 ToolMessage 放回消息列表，模型再看完整历史决定下一步。这一整条轨迹都记录在 result 的 messages 里。

工具执行出错时可以优雅处理。默认情况下工具抛出的异常会中断 agent 循环，但把 handle_tool_error 设为 True，异常会被转成一段文本返回给模型，让 agent 有机会换个方式重试，而不是直接崩溃。

检索也可以包成工具交给 agent。create_retriever_tool 把一个 retriever 包成标准的搜索工具，agent 就能自己决定什么时候去查资料。它默认只格式化 page_content；如果答案必须保留 source metadata，需要传入包含 `{source}` 的 document_prompt，或手写工具格式。模型是否真的选择搜索仍需用真实模型评估。
