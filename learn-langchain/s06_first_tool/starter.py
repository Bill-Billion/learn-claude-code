from langchain.tools import tool


@tool
def count_words(text: str) -> str:
    # 提示：docstring 是模型看到的工具说明——写清楚这个工具做什么
    """______________________________"""
    # 提示：按空白切分数词数，返回一句带词数的文本
    return ______________________________


print(count_words.invoke({"text": "LangChain teaches tools"}))
