# s07: Skill Loading — 必要なときにだけ読み込む

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → `s07` → [s08](../s08_context_compact/) → s09 → ... → s20
> *"必要なときに読み込み、すべてを prompt へ詰め込まない"* — 全文は system prompt ではなく `tool_result` から注入する。
>
> **Harness レイヤー**: 知識 — コンテキストを埋めず、必要に応じて読み込む。

---

前章の最後に一つの問題が残った。タスクごとに必要な知識が違う。プロジェクトには React component 規約、SQL style guide、API 設計文書があり、Agent は作業中にそれらを守らなければならない。規則はどこから与えるべきか。

最も直接的な発想は、すべて system prompt へ入れることだ。

```python
SYSTEM = (
    f"You are a coding agent. "
    + open("docs/react-style.md").read()       # 2,000 行
    + open("docs/sql-style.md").read()         # 1,500 行
    + open("docs/api-design.md").read()        # 3,000 行
)
```

6,500 行の system prompt になる。s01 で見たようにモデルはステートレスなので、この 6,500 行は呼び出すたびに丸ごと再送される。今は CSS の色を一つ変えているだけでも、無関係な SQL guide と API 文書が毎ターン課金される。計算してみよう。一つの規約が約 2,000 token なら、十個で固定費 20,000 token。その 99% が現在のタスクに関係ない。

![Skill Overview](images/skill-overview.svg)

---

## 自分でファイルを読ませればよいのでは？

次に思いつくのは、文書をプロジェクト内のファイルへ分け、必要なものを Agent 自身に `read_file` させる方法だ。

あと一歩足りない。Agent はどんな文書が存在するかを知らない。まず「何があるか」を知って初めて、「どれを使うか」を選べる。タスクのたびにプロジェクト全体を `glob` して文書を探させるのは、設計ではなく運任せだ。

二つの要件を分けると答えが出る。**「何があるか」は常駐させ、「中身は何か」は必要なときだけ読めばよい。** 常駐部分は名前と一文の説明だけなので安い。大きいのは規約の全文だ。

| レイヤー | 場所 | タイミング | コスト |
|----------|------|------------|--------|
| カタログ | system prompt | 起動時に注入 | 約 100 token/skill、毎ターン保持 |
| 内容 | `tool_result` | Agent が `load_skill` を呼んだとき | 約 2,000 token/skill、使うときだけ |

---

## 第 1 層：起動時に走査し、カタログを SYSTEM へ入れる

skill は一つのディレクトリと一つの `SKILL.md` で、frontmatter に名前と一文の説明を書く。

```
skills/
  agent-builder/SKILL.md
  code-review/SKILL.md
  mcp-builder/SKILL.md
  pdf/SKILL.md
```

harness は起動時にディレクトリを走査し、frontmatter を解析して registry へ入れる。

```python
SKILL_REGISTRY: dict[str, dict] = {}

def _scan_skills():
    for d in sorted(SKILLS_DIR.iterdir()):
        manifest = d / "SKILL.md"
        if manifest.exists():
            raw = manifest.read_text()
            meta, body = _parse_frontmatter(raw)          # YAML frontmatter を解析
            name = meta.get("name", d.name)
            desc = meta.get("description", ...)
            SKILL_REGISTRY[name] = {"name": name, "description": desc, "content": raw}

_scan_skills()   # 起動時に一度だけ実行

def build_system() -> str:
    catalog = "\n".join(f"- **{s['name']}**: {s['description']}"
                        for s in SKILL_REGISTRY.values())
    return (
        f"You are a coding agent at {WORKDIR}. "
        f"Skills available:\n{catalog}\n"
        "Use load_skill to get full details when needed."
    )

SYSTEM = build_system()
```

これでモデルは毎ターン「自分に何ができるか」を見られる。四行のカタログで、各行は名前と一文の説明だけ。常駐させてもほとんど負担にならない。

しかしカタログには一文しかない。実際に code review をするとき、完全な review checklist にはまだ届かない。

---

## 第 2 層：load_skill で本文を必要なときだけ取る

モデル自身が「このタスクには code-review skill が必要」と判断し、ツールを呼んで全文を取得する。

```python
def load_skill(name: str) -> str:
    skill = SKILL_REGISTRY.get(name)      # registry を引き、ファイルパスは組み立てない
    if not skill:
        return f"Skill not found: {name}"
    return skill["content"]
```

接続はこれまでどおり、定義を一つ、登録を一行、ループは変更しない。

この数行には二つの設計判断が隠れており、それぞれ悪い実装を防いでいる。

**registry を引き、ファイルパスを組み立てない。** `open(f"skills/{name}/SKILL.md")` のように実装すると、`name` がパス注入点になる。`load_skill("../../.env")` で鍵を読み、モデルへ渡せてしまう。registry は起動時に固定される。実行時の名前は辞書の中だけを探し、なければ `Skill not found` を返す。

**内容は `messages` へ入れ、SYSTEM へ入れない。** skill 全文はファイル読取結果と同じ `tool_result` として会話へ入る。system prompt に追加すれば永久に残り、使い終わっても毎ターン再送される。`messages` に置けば、会話履歴に対するすべての管理規則に従う。次章ですぐにこの性質を使う。

もう一つ境界を明確にしよう。**Subagent には skill system がない。** `SUB_SYSTEM` にカタログはなく、`SUB_TOOLS` に `load_skill` もない。委任するタスクに分野知識が必要なら、重要な点をタスク説明へ書いて渡す。これは s06 の「要約にない情報は存在しない」の鏡像であり、コンテキスト分離は双方向だ。

> 実際の Claude Code は、ユーザーディレクトリ、プロジェクトディレクトリ、plugin、MCP remote skill、built-in など十数種類の出所を統合する。カタログ注入には約コンテキスト window の 1%、最大 8,000 文字という予算がある。`SKILL.md` は `context: fork` を宣言し、skill 自体を Subagent として実行することもできる。教学版は一つのディレクトリと一つのツールだが、二層構造は同じだ。

---

## s06 からの変更

| コンポーネント | 変更前 (s06) | 変更後 (s07) |
|----------------|--------------|--------------|
| ツール数 | 7 (bash, read, write, edit, glob, todo_write, task) | 8 (+`load_skill`) |
| 知識の読み込み | なし | 二層：カタログは SYSTEM、内容は必要時に `messages` |
| SYSTEM prompt | 静的な文字列 | 起動時に `skills/` を走査してカタログを注入 |
| skill registry | なし | 起動時に構築する `SKILL_REGISTRY`、パス注入を防止 |
| ループ | 変更なし | 変更なし |

---

## 試してみる

```sh
cd learn-claude-code
python s07_skill_loading/code.py
```

1. `What skills are available?`：モデルは四つの skill を直接答える。ターミナルに `[HOOK]` は出ない。カタログが最初から SYSTEM にあり、ツールを呼ばないためだ。
2. `Without loading anything, tell me the exact review steps the code-review skill prescribes`：正確には答えられず、一文の説明から推測するしかない。カタログ層の情報が一文だけなのは意図した境界だ。
3. `Load the code-review skill and use it to review s02_tool_use/code.py`：今度は `[HOOK] load_skill` が出て、その後の review は `SKILL.md` の構造に従う。実験 2 と比べれば、「カタログ常駐、内容は必要時」という二層の差がわかる。

---

## 次へ

`messages` に何が住んでいるか数えてみよう。ツール結果、ファイル内容、コマンド出力、そしてこの章で skill 文書の全文も入るようになった。入る一方で出ていかない。タスクが長くなれば、いつか呼び出しが `prompt_too_long` にぶつかる。

s08 Context Compact → 四段階の整理パイプライン。安い処理を先に、高い処理を後に。整理で済むなら要約しない。

<!-- translation-sync: zh@v4, en@v4, ja@v4 -->
