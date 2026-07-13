import os

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

load_dotenv()

model = init_chat_model(os.environ["LANGCHAIN_MODEL"])


class BookNote(BaseModel):
    title: str = Field(description="书名或材料标题")
    # 提示：description 是喂给模型的字段说明，写清楚这个字段要填什么
    summary: str = Field(description=______________________________)
    tags: list[str] = Field(description=___________________________)  # 例如："主题标签"


# 提示：把 schema（BookNote 这个类）传给 with_structured_output
structured_model = model.with_structured_output(__________________)
# 提示：invoke 一段材料文本，返回的是一个填好的 BookNote 对象（不是 AIMessage）
result = structured_model.invoke(_________________________________)
