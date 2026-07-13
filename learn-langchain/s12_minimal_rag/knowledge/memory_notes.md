短期记忆使用 checkpointer 保存线程状态。调用 agent 时，同一个 thread_id 会看到同一线程的历史消息。历史不再靠你手动拼进消息列表，而是 checkpointer 按 thread_id 自动存取。

InMemorySaver 把 checkpoint 存在内存里，按 thread_id 分区。它是开发和测试用的实现，进程退出数据就丢失。生产环境换成 SqliteSaver 或数据库 checkpointer，agent 的构造代码几乎不用改。

流式输出把一次性的返回换成逐步的更新。agent.stream 返回一个迭代器，每段是某个节点的一次状态更新。stream_mode 等于 updates 时按节点给更新，等于 messages 时给 token 级增量，适合做实时聊天界面。

检索的第一步是把资料变成可查的形态。一个 Document 是一段文本加一份 metadata。RecursiveCharacterTextSplitter 把长文档切成小块，chunk_overlap 让相邻块重复一部分边界内容，从而保留切分处附近的上下文，但不能保证句子永远不被切开。

向量存储保存切好的文本块。每块先过 embedding 变成向量，再存进 InMemoryVectorStore。检索时必须用同一个 embedding 模型把问题也变成向量，再用余弦相似度找最接近的几个块。无阈值 top-k 只表示库里最相似的结果，不保证它们足够相关。向量检索是 retriever 的一种实现，不是唯一实现。

RAG 是检索和生成两段程序接起来。先用 retriever 找回相关片段，再把片段塞进 prompt 的上下文，并请求模型根据片段回答。系统提示可以要求资料不足时说不知道，但这是软行为约束，不是 grounding 或引用正确性的证明。
