import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langchain.tools import tool

load_dotenv()


# 来自 s07（原样搬来）：工具和 agent 构造都不变，本课只练习 streaming。
@tool
def count_words(text: str) -> str:
    """统计输入文本中按空白分隔的词数。"""
    words = [word for word in text.split() if word]
    return f"词数：{len(words)}"

agent = create_agent(
    model=init_chat_model(os.environ["LANGCHAIN_MODEL"]),
    tools=[count_words],
    system_prompt="你是一个回答简洁的 LangChain 助教。",
)

for update in agent.stream(
    {"messages": [{"role": "user", "content": "请统计 LangChain streams updates 的词数"}]},
    # 提示：只填本课的新机制——"updates" 会按 model/tools 节点返回进度
    stream_mode=______________________________,
):
    print(update)
