LangChain 的核心学习路径可以从 messages、models、tools 和 agents 开始。Runnable 和 classic chains 更适合作为后续的抽象对照，不是初学者的第一站。先把消息到 agent 的主干走稳，再去看更高阶的组合方式。

模型调用的统一入口是 init_chat_model。它接受 provider 前缀的模型名，返回一个统一接口的 chat model。你的代码只认 invoke 和 AIMessage，认不得也不需要认底层是哪家 provider，这让换模型的成本降到只改一个字符串。

提示模板 ChatPromptTemplate 把固定的骨架和每次变化的变量分开管理。骨架写一次反复复用，变量在调用时填。它用 from_messages 定义一组带角色的消息模板，invoke 时传字典填空，to_messages 得到最终的消息列表。

结构化输出通过 with_structured_output 实现。你用 Pydantic 定义想要的字段和类型，模型的返回就从自由文本变成一个可验证的对象。字段的 description 不是给人看的注释，而是喂给模型、告诉它每个字段该填什么的说明。

工具让模型可以调用确定性的 Python 逻辑。@tool 装饰器读取函数名、参数类型和 docstring，自动生成模型能看懂的工具说明。docstring 直接影响模型判断什么时候该用这个工具，写清楚它比写函数体本身还重要。

Agent 是模型和工具的循环。create_agent 把模型、工具、系统提示组装成一个循环：模型自己决定要不要调工具，调完看结果够不够，不够再调一次，直到收尾。你只给零件，循环由框架替你跑。
