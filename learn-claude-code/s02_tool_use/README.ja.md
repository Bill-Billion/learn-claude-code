# s02: Tool Use — ツールを一つ増やすたび、追加するのは一行だけ

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → `s02` → [s03](../s03_permission/) → s04 → ... → s20
> *"ツールを一つ増やすたび、handler を一つ追加する"* — ループは変えず、新しいツールを dispatch map に登録するだけ。
>
> **Harness レイヤー**: ツールディスパッチ — ツール名で対応する処理関数を引き、呼び出す。

---

前章の Agent は自分で作業できるようになったが、手元には bash という一本の万能ナイフしかない。ファイルを書くときの姿はこうだ。

```bash
echo 'print("hello")' > hello.py
```

内容が単純なら問題ない。だが一重引用符、二重引用符、改行が混ざると、コマンドはエスケープだらけになる。モデルが一文字でも間違えれば、ディスクに書かれるのは壊れたファイルで、修正にもう一ターンかかる。

この章では、五つの専用ツールを与える。重要なのはツールそのものではなく、追加の仕方だ。ループは一行も変更しない。

![Tool Dispatch](images/tool-dispatch.svg)

---

## bash だけでは、なぜ足りないのか

bash は理論上、何でもできる。問題は別のところにある。

**翻訳が一段増える。** モデルの意図は「このファイルを読む」なのに、まず `cat path/to/file` へ翻訳しなければならない。翻訳するたびに失敗の機会が増え、引用符の処理はとりわけ壊れやすい。

**出力量を制御できない。** `cat` には行数制限がないため、5,000 行のファイルが丸ごと会話へ流れ込む。専用の読取ツールなら `limit` 引数を持たせ、先頭 N 行だけ返せる。履歴を無制限に増やしたときの代償は s08 で詳しく扱う。

**プログラムにはコマンドの意味がわからない。** コードから見れば bash の文字列はブラックボックスで、`cat` も `rm -rf` も同じ文字列にすぎない。対して `read_file` と `write_file` は名前の違うツールなので、読み書きの区別が明示される。今は小さな違いに見えるが、s03 の権限制御では決定的だ。操作が読み取りか書き込みかを知らなければ、止めるべきか判断できない。

方針は明快だ。よく使う操作にはそれぞれ名前付きのツールを用意し、bash は最後の手段として残す。

---

## 定義を一つ、登録を一行

s01 のメニューは一品だけだった。今度は五品に増やす。それぞれが `TOOLS` の一つの定義だ。

```python
TOOLS = [
    {"name": "bash",       "description": "Run a shell command.", ...},
    {"name": "read_file",  "description": "Read file contents.",  ...},   # limit を指定できる
    {"name": "write_file", "description": "Write content to a file.", ...},
    {"name": "edit_file",  "description": "Replace exact text in a file once.", ...},
    {"name": "glob",       "description": "Find files matching a glob pattern.", ...},
]
```

各ツールの裏には普通の関数がある。まず、すべてのファイルツールが通る門を見てみよう。

```python
def safe_path(p: str) -> Path:
    path = (WORKDIR / p).resolve()
    if not path.is_relative_to(WORKDIR):    # 解決後もワークスペース内でなければならない
        raise ValueError(f"Path escapes workspace: {p}")
    return path
```

モデルが `../../etc/passwd` のような越境パスを渡すこともある。`safe_path` はまず絶対パスへ解決し、作業ディレクトリの外へ出ていないか確認する。これは本コース最初の本格的なセキュリティ境界だ。ただし守るのはファイルツールだけで、bash はここを通らない。その穴は s03 で塞ぐ。

四つの新しいツールはどれも短い。

```python
def run_read(path, limit=None):
    lines = safe_path(path).read_text().splitlines()
    if limit and limit < len(lines):
        lines = lines[:limit] + [f"... ({len(lines) - limit} more lines)"]
    return "\n".join(lines)

def run_write(path, content):
    file_path = safe_path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)   # 親ディレクトリがなければ作る
    file_path.write_text(content)
    return f"Wrote {len(content)} bytes to {path}"

def run_edit(path, old_text, new_text):
    file_path = safe_path(path)
    text = file_path.read_text()
    if old_text not in text:                 # 元のテキストがなければ明示的に失敗
        return f"Error: text not found in {path}"
    file_path.write_text(text.replace(old_text, new_text, 1))   # 最初の一致だけ置換
    return f"Edited {path}"
```

`edit_file` の二つの設計には意味がある。元のテキストは完全一致が必須で、見つからなければ失敗する。これによりモデルは、記憶だけを頼りに変更せず、先に読まざるを得ない。記憶がずれていれば、エラーがファイルの再読へ戻してくれる。置換を最初の一箇所に限定するのは、同じ文字列を含む無関係な箇所まで一度に変えないためだ。

次は登録だ。ツール名から関数への対応は、一つの辞書で済む。

```python
TOOL_HANDLERS = {
    "bash":       run_bash,
    "read_file":  run_read,
    "write_file": run_write,
    "edit_file":  run_edit,
    "glob":       run_glob,
}
```

ループ内の変更も一行だけ。s01 のハードコードされた呼び出しを、s02 では表引きに変える。

```python
for block in response.content:
    if block.type == "tool_use":
        handler = TOOL_HANDLERS.get(block.name)                       # ツール名で表を引く
        output = handler(**block.input) if handler else f"Unknown: {block.name}"
        results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
```

`while True`、`stop_reason` の判定、メッセージの追加はすべてそのままだ。この章の要点は一文で言える。**ループは変えず、メニューだけを増やす。** 以後の章で機能を足すときも、型は同じだ。`TOOLS` に一つ定義し、`TOOL_HANDLERS` に一行登録する。

---

## モデルが一度に何品も注文する

s01 の最後に二つの問いが残った。モデルは一度に複数のツールを呼ぶのか。それらは互いに干渉しないのか。

最初の答えは「呼ぶ」で、しかも珍しくない。「a.py と b.py を読んで」と頼むと、一つの応答に二つの `tool_use` ブロックが入ることがある。ループに特別な処理は要らない。`for block in response.content` はもともと全ブロックを走査し、順に実行して結果を集め、すべての `tool_result` を一つの `user` メッセージへ入れて返す。

二つ目について、教学版は元の順番どおり一つずつ実行する。互いに干渉しない代わりに遅い。独立した二つの読取処理なら、本来は同時に走らせられる。

> 実際の Claude Code は単純な逐次実行ではない。連続する「並行実行して安全な」呼び出しを一つのグループにまとめ、並列に走らせる。安全性は具体的な入力から判断するため、`ls` のような読み取り専用 bash も安全になり得る。状態を変更する呼び出しに出会うとそこでグループを切り、その呼び出しだけを直列実行する。グループ間の順序は厳密に保つ。教学版が順次実行を選ぶのは、用途には十分で、読みやすいからだ。

---

## s01 からの変更

| コンポーネント | 変更前 (s01) | 変更後 (s02) |
|----------------|--------------|--------------|
| ツール数 | 1 (bash) | 5 (+read, write, edit, glob) |
| ツール実行 | `run_bash()` をハードコード | `TOOL_HANDLERS` でディスパッチ |
| パスの安全性 | なし | ファイルツールに `safe_path` 検証 |
| ループ | `while True` + `stop_reason` | s01 と完全に同じ |

---

## 試してみる

```sh
cd learn-claude-code
python s02_tool_use/code.py
```

ターミナルの黄色い `> tool_name` 行には、完全なコマンドではなくツール名が表示される。次を試してみよう。

1. `Read the file README.md and tell me what this project is about`：`cat` ではなく `read_file` を選ぶかを見る。
2. `Create a file called test.py that prints "hello", then read it back`：書き込みと読み取りが一ターンずつで、引用符の問題もない。
3. `Find all Python files in this directory`：`glob` が一ターンで結果を返す。
4. `Read both README.md and requirements.txt, then create a summary file`：一つの応答に二つの `read_file` が入るかを見る。ターミナルには `> read_file` が二行続けて出る。

次に越境パスを試す。`Use read_file to read ../../etc/passwd` と頼むと、`safe_path` は `Path escapes workspace` を返す。その後のモデルの動きを見よう。素直に止まればよい。bash の `cat` に切り替えて読めてしまったなら、ファイルツールと bash の保護の差を目撃したことになる。次章でこの穴を塞ぐ。

---

## 次へ

Agent は五つの専用ツールを持ち、ファイル操作は `safe_path` によってワークスペース内へ制限された。しかし bash はまだ無制限だ。古い拒否リストは数個の文字列しか止めず、`rm -rf ./src` のようなコマンドは実行できてしまう。

s03 Permission → ツール実行の前に一つの門を置く。この操作は安全か。ユーザーの承認が必要か。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
