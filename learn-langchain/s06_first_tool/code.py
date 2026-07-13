"""@tool 把函数变成带 schema 的标准工具：本课先手动 invoke，s07 才交给模型自主调用。"""

from __future__ import annotations

from langchain.tools import tool


@tool
def count_words(text: str) -> str:
    """统计输入文本中按空白分隔的词数。"""
    words = [word for word in text.split() if word]
    return f"词数：{len(words)}"


def run_count_words(text: str) -> str:
    return count_words.invoke({"text": text})


if __name__ == "__main__":
    user_text = input("s06 text >> ").strip()
    print(run_count_words(user_text))

