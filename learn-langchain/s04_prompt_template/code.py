"""ChatPromptTemplate 把消息骨架和变量分开：填充后产出的仍是标准消息列表。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.prompts import ChatPromptTemplate

from shared.messages import message_text

load_dotenv()

PROMPT = ChatPromptTemplate.from_messages(
    [
        ("system", "你是{role}。回答要{style}。"),
        ("human", "请向{audience}解释：{topic}"),
    ]
)


def build_messages(topic: str, audience: str, role: str, style: str):
    prompt_value = PROMPT.invoke(
        {
            "topic": topic,
            "audience": audience,
            "role": role,
            "style": style,
        }
    )
    return prompt_value.to_messages()


def explain(topic: str, audience: str, role: str, style: str, model=None) -> str:
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    response = model.invoke(build_messages(topic, audience, role, style))
    return message_text(response)


if __name__ == "__main__":
    print(explain("向量数据库", "一名大一新生", "耐心的计算机老师", "简洁，少术语"))
