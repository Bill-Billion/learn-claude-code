# s09: Memory — 圧縮は細部を失う。重要なことはコンテキストの外へ記録する

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s07 → s08 → `s09` → [s10](../s10_system_prompt/) → s11 → ... → s20
> *"圧縮は細部を失う。重要なことはコンテキストの外へ記録する"* — ファイル保存、index、必要時の読込によって圧縮と session を越える。
>
> **Harness レイヤー**: Memory — 圧縮や session をまたいで知識を蓄積する。

---

前章の最後に残った問いは、どの情報を長く残す価値があるかだった。

現実的な例を見よう。あなたは Agent に「indent は space ではなく tab にして」と伝えた。40 ターン後に s08 の要約が動けば、この文はおそらく「ユーザーにはコード style の好みがある」となり、具体的な好みは消える。翌日はさらに厳しい。新しい session は新しい `messages` から始まり、前日の要約すら存在しない。昨日教えた規則は、今日は教えていないのと同じになる。

下書き用紙の比喩に最後の一枚を足そう。下書きは満杯になり、整理される。それは避けられない。しかし「この先生は採点が厳しい」「この種類の問題では符号を間違えやすい」といった経験は、そもそも下書きに置く情報ではない。個々の問題を越える知識は別のノートへ記録し、問題を解く前に読み返す。

この章では Agent にそのノートを与える。

![Memory Overview](images/memory-overview.svg)

---

## system prompt へ書けばよいのでは？

直感的には、重要な好みを固定ファイルへ書き、起動時に system prompt へ入れる。

方向は正しいが、二つ問題がある。第一に、誰が書くのか。好みは日常会話に散らばっている。「space より tab がよい」は何気なく言うもので、form に記入するものではない。ユーザーに好みファイルを手動管理させるなら、実質的に記憶システムはない。第二に、すべてを常駐させると s07 と同じ費用問題へ戻る。記憶が増えるほど毎ターン全量を再送し、その 90% は現在のタスクに関係ない。

s07 はすでに答えの形を示した。**index は常駐させ、本文は必要なときに読む。** Memory は skill system の書き込み可能版と考えられる。s07 の skill は人が書く read-only の知識。s09 の memory は Agent 自身が書き、増え、代謝する知識だ。

自分で書くなら、四つの問いに答えなければならない。どの形で保存し、どう読み、いつ書き、増えすぎたらどうするか。

![Memory Subsystems](images/memory-subsystems.svg)

---

## 保存：一つの memory を一ファイルへ、さらに index を一つ

各 memory は `.memory/` 内の Markdown ファイルで、frontmatter に metadata を持つ。

```markdown
---
name: user-preference-tabs
description: User prefers tabs for indentation
type: user
---

User prefers using tabs, not spaces, for indentation.
**Why:** Consistency with existing codebase conventions.
**How to apply:** Always use tabs when writing or editing files.
```

`type` は四種類で、それぞれ別の問いに答える。

| type | 問い | 例 |
|------|------|----|
| user | あなたは誰か | 「space ではなく tab」 |
| feedback | どう仕事をするか | 「database を mock しない」 |
| project | 何が起きているか | 「auth rewrite は compliance のため」 |
| reference | どこを探すか | 「pipeline bug は Linear INGEST」 |

`MEMORY.md` は index で、一つの memory を一行にし、書き込み後に毎回再構築する。

```python
def write_memory_file(name, mem_type, description, body):
    slug = name.lower().replace(" ", "-")
    (MEMORY_DIR / f"{slug}.md").write_text(
        f"---\nname: {name}\ndescription: {description}\ntype: {mem_type}\n---\n\n{body}\n"
    )
    _rebuild_index()   # index とファイルを常に同期
```

---

## 読み込み：index は常駐、本文は一時的に注入

index は s07 と同じく SYSTEM へ入れる。

```python
def build_system() -> str:
    index = read_memory_index()
    memories_section = f"\n\nMemories available:\n{index}" if index else ""
    return (
        f"You are a coding agent at {WORKDIR}."
        f"{memories_section}\n"
        "Relevant memories are injected below. Respect user preferences from memory."
        ...
    )
```

本文は必要なときだけ読む。各 user turn の開始時、`select_relevant_memories()` は最近の会話と memory catalog を軽量な side query へ渡し、明確に関係する項目だけを最大 5 件選ばせる。

```python
prompt = (
    "Given the recent conversation and the memory catalog below, "
    "select the indices of memories that are clearly relevant. "
    "Return ONLY a JSON array of integers, e.g. [0, 3]. ..."
)
```

API や JSON 解析で side query が失敗したら、keyword match へ fallback する。荒い選択でも、何も選べないよりよい。

最も間違えやすいのは、選んだ本文を会話へ入れる方法だ。教学版では、**現在リクエストの copy へ差し込み、`messages` の履歴へは書かない。**

```python
request_messages = messages.copy()
request_messages[memory_turn] = {
    **messages[memory_turn],
    "content": memories_content + "\n\n" + messages[memory_turn]["content"],
}
response = client.messages.create(..., messages=request_messages, ...)
```

直接 `messages.append()` すると二つの問題がすぐ起きる。同じ memory を毎ターン注入して履歴が膨らみ、さらに s08 の圧縮パイプラインが memory 本文を普通のメッセージとして placeholder 化、切り詰め、要約する。注入は一時的にし、リクエストごとに組み立て、履歴はきれいなまま保つ。

---

## 書き込み：終了時に、圧縮前の会話から抽出する

ユーザーは毎回「これを覚えて」とは言わない。好みは普通の会話に散らばるため、横で聞いている仕組みが必要だ。`extract_memories()` がその役割を持ち、モデルがツール呼び出しを止めた turn の終了時に動く。

```python
if response.stop_reason != "tool_use":
    extract_memories(pre_compress)   # 圧縮前の snapshot を使う
    consolidate_memories()
    return
```

`pre_compress` は厳格な要件だ。ループは毎回 s08 の圧縮を実行する。終了時の `messages` では、古い会話が切られ、placeholder に変わっているかもしれない。「space より tab」という文が削除領域にあったら、圧縮後の履歴から抽出するのは断片からの推測になる。そこで各 iteration で圧縮前 snapshot を取り、抽出は常に全文を見る。s08 と s09 はこの実行順で噛み合う。圧縮は自由に縮められるが、抽出は元の文を読まなければならない。

抽出 prompt には既存 memory の一覧も渡し、「本当に新しい内容」があるときだけ返させる。同じ好みを十回保存しないためだ。ただし、モデルの返答は候補であって、書き込み許可ではない。各候補には `scope` を持たせる。`persistent` は次の session にも残す内容、`current_task` は今回だけの command、一時 path、一時的な制約を表す。

最後の判定は `should_store_memory()` が行う。完全なフィールドを持つ `scope="persistent"` だけを書き込み、「この session」「現在の task」といった一時性を示す文言を拒否する。さらに既存 memory と名前、説明、本文を比較し、重複も保存しない。抽出モデルが誤っても、「今回だけファイルを作らない」という指示が翌週の規則として残らないための境界だ。

---

## 整理：増えたら統合する。ただし順序は変えない

memory ファイルには重複、古い情報、矛盾が増える。件数がしきい値、教学版では 10 件に達すると、モデルに全 memory の重複排除と統合をさせ、重要な好みを残す。

```python
try:
    response = client.messages.create(...)          # 1 まず統合後の一覧を得る
    items = json.loads(match.group())               # 2 解析成功を確認
    for f in MEMORY_DIR.glob("*.md"):               # 3 ここで初めて旧ファイルを削除
        if f.name != "MEMORY.md":
            f.unlink()
    for mem in items:
        write_memory_file(...)                      # 4 新ファイルを書く
except Exception:
    pass                                            # どこか失敗したら旧ファイルを残す
```

この順序は s08 の「要約前に保存」と同じ発想だ。**新しいものを取得し、検証してから古いものを破棄する。** 逆にして先に削除すれば、一回の network error で全 memory が backup なしに消える。

> 実際の Claude Code では整理を Dream と呼び、前回から 24 時間以上、scan throttling、5 session 以上に変更、並行実行を防ぐ file lock という四つの gate を持つ。権限を制限した fork Agent が作業する。memory 選択も vector search ではなくモデルの side query だ。また user memory は session を越え、session memory は圧縮を越える。教学版は一つのしきい値と三関数に縮めるが、四つの役割は同じだ。

---

## s08 からの変更

| コンポーネント | 変更前 (s08) | 変更後 (s09) |
|----------------|--------------|--------------|
| Memory | なし、要約で好みが劣化 | 保存 + 読込 + 抽出 + 整理 |
| 新しい関数 | — | `write_memory_file`, `select_relevant_memories`, `load_memories`, `extract_memories`, `consolidate_memories` |
| 保存 | — | `.memory/MEMORY.md` index + `.memory/*.md` |
| ツール | 9 | 6、本章では bash, read_file, write_file, edit_file, glob, task に絞る |
| ループ | 圧縮だけ | memory 注入 + 圧縮 + 終了時抽出 + 定期整理 |

---

## 試してみる

```sh
cd learn-claude-code
python s09_memory/code.py
```

1. `I prefer using tabs for indentation, not spaces. Remember that.`：終了時の `[Memory: extracted N new memories]` を確認する。`.memory/` に `.md` ファイル、`MEMORY.md` に index 行が一つ増えるはずだ。
2. `Create a Python file called test.py`：indent に tab を使うかを見る。
3. `q` で終了し、**プログラムを再起動**して `What are my preferences?` と聞く。新しい session と新しい `messages` でも答えられる。これが s08 との境界だ。要約は session を越えず、memory は越える。
4. 関係ない話題を数ターン続ける。side query は関係する memory だけを注入し、無関係なものはディスクに残したままにする。

---

## 次へ

Memory、圧縮、ツールが揃った。SYSTEM prompt を振り返ると、identity はハードコードされた文字列、skill catalog は別の断片、memory index も別で、各章が独自に連結している。プロジェクトやツールを変えるたびにコードを直さなければならない。

s10 System Prompt → section に分け、実行時に組み立てる。プロジェクトとツールに応じて異なる prompt を作る。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
