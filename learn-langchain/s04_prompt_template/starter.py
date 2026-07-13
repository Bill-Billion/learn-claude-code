from langchain_core.prompts import ChatPromptTemplate

PROMPT = ChatPromptTemplate.from_messages(
    [
        ("system", "你是{role}。回答要{style}。"),
        ("human", "请向{audience}解释：{topic}"),
    ]
)

# 提示：给模板的每个 {占位符} 填一个值——漏填任何一个，invoke 会当场报错
messages = PROMPT.invoke(
    {
        "topic": ______________________________,  # 要解释的主题
        "audience": ___________________________,  # 解释给谁听
        "role": _______________________________,  # 模型扮演的角色
        "style": ______________________________,  # 回答风格
    }
).to_messages()

