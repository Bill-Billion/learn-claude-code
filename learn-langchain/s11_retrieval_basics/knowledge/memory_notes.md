LangChain 的短期记忆依赖 checkpointer 保存线程级状态。调用 agent 时，需要在 config 的 configurable.thread_id 中传入线程标识。同一个 thread_id 的多轮调用会自动接上历史，换一个 thread_id 就是另一条干净的记忆线。

InMemorySaver 是最简单的 checkpointer，把状态存在内存里。一轮结束它保存当前消息历史，下一次同一线程进来先恢复存档再继续。它只适合开发和测试，进程一退出数据就没了；真实场景换成数据库 checkpointer，代码不用改，只换这一个对象。

记忆绑在线程上，不绑在 agent 对象上。同一个 agent 跑两个不同的 thread_id，是两条互不相干的记忆线。这就是为什么记忆的关键是 thread_id，而不是 agent 实例本身。

当对话变长，消息历史会不断累积，最终可能超出模型的上下文窗口。trim_messages 用来裁剪消息，可以保留最近的若干条，也可以始终保留 SystemMessage，从而把上下文控制在预算之内。

流式输出让 agent 一边执行一边把中间结果吐出来。把 invoke 换成 stream，agent 会按节点更新一段段返回，用户不用干等到全部算完。stream_mode 参数控制返回的粒度，updates 模式按节点给状态更新，messages 模式给 token 级的增量。

middleware 是 agent 的生命周期扩展点，可以注册工具、扩展 state，并在模型或工具调用前后介入。TodoListMiddleware 会注册 write_todos、加入 todos state、追加 system prompt，并检查并行更新冲突；底层模型对象不变，但 agent 发给模型的请求已经扩展。是否使用规划能力仍由模型决定。
