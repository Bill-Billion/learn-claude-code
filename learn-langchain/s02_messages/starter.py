from langchain_core.messages import AIMessage, HumanMessage

messages = [
    HumanMessage(content="我正在学习 LangChain。"),
    AIMessage(content="很好，我们一次只学一个机制。"),
    # 提示：再加一条 HumanMessage，作为这一轮真正的新问题
    ______________________________,
]

