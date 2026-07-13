import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.prompts import ChatPromptTemplate

from s12_minimal_rag.code import build_retriever

load_dotenv()

model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
retriever = build_retriever()
question = input("s12 question >> ").strip()

RAG_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "只能根据给定上下文回答；如果上下文没有答案，就说不知道。"
            "回答时保留 [文件名] 来源标签。",
        ),
        ("human", "问题：{question}\n\n上下文：\n{context}"),
    ]
)

# 上面的要求是软行为约束；[文件名] 也是文本标签，不是程序验证过的 citation。

# 提示：用用户的问题去检索相关片段
docs = retriever.invoke(______________________________)
# 提示：把 docs 拼成 "[文件名] 内容"，让模型能看到候选来源
context = ______________________________
messages = RAG_PROMPT.invoke({"question": question, "context": context}).to_messages()
answer = model.invoke(messages)
