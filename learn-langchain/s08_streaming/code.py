"""同一个 agent 换用 stream(stream_mode="updates") 消费：逐节点看到 model → tools → model 的进度。"""

from __future__ import annotations

import os
from collections.abc import Iterator

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langchain.tools import tool

from shared.messages import message_text

load_dotenv()


@tool
def count_words(text: str) -> str:
    """统计输入文本中按空白分隔的词数。"""
    words = [word for word in text.split() if word]
    return f"词数：{len(words)}"


def build_agent(model=None, tools=None):
    if model is None:
        model = init_chat_model(os.environ["LANGCHAIN_MODEL"])
    return create_agent(
        model=model,
        tools=[count_words] if tools is None else tools,
        system_prompt="你是一个回答简洁的 LangChain 助教。",
    )


def stream_updates(query: str, model=None, tools=None) -> Iterator[dict]:
    agent = build_agent(model=model, tools=tools)
    yield from agent.stream(
        {"messages": [{"role": "user", "content": query}]},
        stream_mode="updates",
    )


def collect_final_text(query: str, model=None, tools=None) -> str:
    final_text = ""
    for update in stream_updates(query, model=model, tools=tools):
        for node_update in update.values():
            for message in node_update.get("messages", []):
                final_text = message_text(message)
    return final_text


if __name__ == "__main__":
    for event in stream_updates(input("s08 >> ").strip()):
        print(event)
