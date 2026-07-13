import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model

load_dotenv()

# 提示：用 init_chat_model 拿一个 model，模型名从环境变量 LANGCHAIN_MODEL 读
model = ______________________________
query = input("s01 >> ").strip()
# 提示：调 model.invoke(query)，它返回的是一个 AIMessage 对象（不是字符串）
response = ___________________________
print(response.content)
