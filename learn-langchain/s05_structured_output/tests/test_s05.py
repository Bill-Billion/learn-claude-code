from s05_structured_output.code import BookNote, extract_book_note


class FakeStructuredModel:
    def __init__(self) -> None:
        self.schema = None

    def with_structured_output(self, schema):
        self.schema = schema
        return self

    def invoke(self, text: str):
        assert self.schema is BookNote
        assert "结构化读书笔记" in text
        return self.schema(title="LangChain 入门", summary="一套 LLM 应用组件。", tags=["LangChain", "LLM"])


def test_extract_book_note_returns_pydantic_object() -> None:
    note = extract_book_note("LangChain 用组件组织 LLM 应用。", model=FakeStructuredModel())

    assert isinstance(note, BookNote)
    assert note.title == "LangChain 入门"
    assert "LLM" in note.tags
