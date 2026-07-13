from langchain_core.messages import HumanMessage, SystemMessage

messages = [
    # 提示：SystemMessage 放行为规则（你是谁、回答风格），固定在列表第一条
    SystemMessage(content=______________________________),
    # 提示：HumanMessage 放这一轮真正的提问
    HumanMessage(content=______________________________),
]
