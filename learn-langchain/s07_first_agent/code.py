"""s06 的 count_words 原样交给 create_agent：何时调用工具由模型决定，循环由框架执行。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langchain.tools import tool

from shared.messages import message_text

load_dotenv()


# 来自 s06（原样搬来）：这个 @tool 函数和 s06 的完全一致。
# s07 不改工具本身，只是把它交给 agent 循环自己决定何时调用。
@tool
def count_words(text: str) -> str:
    """统计输入文本中按空白分隔的词数。"""
    words = [word for word in text.split() if word]
    return f"词数：{len(words)}"


def build_agent(model=None):
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    return create_agent(
        model=model,
        tools=[count_words],
        system_prompt="你是一个会在需要时调用工具的 LangChain 助教。",
    )


def run_agent(query: str, model=None):
    agent = build_agent(model=model)
    return agent.invoke({"messages": [{"role": "user", "content": query}]})


def answer(query: str, model=None) -> str:
    result = run_agent(query, model=model)
    return message_text(result["messages"][-1])


if __name__ == "__main__":
    user_query = input("s07 >> ").strip()
    print(answer(user_query))
