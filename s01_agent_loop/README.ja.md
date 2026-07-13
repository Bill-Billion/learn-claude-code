# s01: Agent Loop — ループ一つで十分

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

`s01` → [s02](../s02_tool_use/) → s03 → s04 → ... → s20
> *"One loop & Bash is all you need"* — ツール一つ + ループ一つ = 一つの Agent。
>
> **Harness レイヤー**: ループ — モデルと現実世界をつなぐ最初の接点。

---

チャット画面のモデルに、こんなタスクを渡してみる。「ローカルのディレクトリにどんな Python ファイルがあるか確認して、hello.py を実行してほしい」。

モデルはそれらしい bash コマンドを返し、そこで止まる。コマンドをターミナルにコピーして実行するのはあなたで、出力を貼り戻すのもあなた。モデルが出力を読んで次のコマンドを返したら、また実行して貼り戻す。

タスクを計画するのはモデルだが、実作業はすべてあなたがしている。実際の開発タスクでは、何十回もコマンドを往復するのは珍しくない。つまり何十回も人が伝言することになる。この章でやることは一つだけだ。この往復から「あなた」を外し、代わりに `while` ループを置く。それだけで Agent が生まれる。

![Agent Loop](images/agent-loop.svg)

---

## まず理解する：モデルとの一回の対話とは何か

ループを書く前に、手元に何があるかを確認しよう。モデル API の呼び出しは、本質的にはリストを送り、一つの応答を受け取ることだ。

```python
messages = [{"role": "user", "content": "ディレクトリ内の Python ファイルを確認して"}]
response = client.messages.create(model=MODEL, messages=messages, ...)
```

`messages` の各要素には二つのフィールドがある。`role` は誰の発言か（`user` または `assistant`）を表し、`content` は内容そのものだ。

必ず覚えておきたい前提がある。モデルはステートレスだ。前回の呼び出しを記憶しておらず、毎回が初対面になる。いわゆる「複数ターンの会話」とは、呼び出すたびにそれまでの履歴を丸ごと送り直すことにすぎない。モデルは全履歴を読み、その続きから話す。

したがって「会話を続ける」とは、コード上では `messages` の末尾に新しい内容を追加し、リスト全体をもう一度送ることだ。

この仕組みの裏側も覚えておこう。履歴は毎ターン丸ごと再送されるため、長くなる一方だ。s08 では、これが現実の問題になる。

---

## モデルには手がない

モデルはクラウド上のサーバーで動き、あなたのターミナルはローカルにある。応答に `ls *.py` と書くことはできても、shell に触れることも、一行のコマンドを実行することもできない。実行できるのは、ローカルで動いている Python プログラムだけだ。

そこで API には、tool use と呼ばれる「注文」のプロトコルが用意されている。

1. リクエストの `tools` 引数で、利用できるツール、その名前、役割、引数の形をモデルに伝える。
2. モデルがツールを使いたいときは、通常のテキストではなく `tool_use` ブロックを返す。中身はツール名、引数、そして識別子 `id` だ。
3. プログラムは `tool_use` を見て実際に処理し、出力を同じ識別子付きの `tool_result` ブロックに入れて返す。
4. モデルは結果を読み、推論を続ける。

今のメニューにあるのは `bash` 一つだけだ。

```python
TOOLS = [{
    "name": "bash",
    "description": "Run a shell command.",
    "input_schema": {                       # 引数の JSON Schema
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    },
}]
```

実行側は普通の関数だ。三つの保護には、それぞれ明確な理由がある。

```python
def run_bash(command: str) -> str:
    # 拒否リスト：これらの文字列を含むコマンドは拒否する（s03 で本格的な権限システムに置き換える）
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(d in command for d in dangerous):
        return "Error: Dangerous command blocked"
    try:
        r = subprocess.run(command, shell=True, cwd=os.getcwd(),
                           capture_output=True, text=True, timeout=120)
        out = (r.stdout + r.stderr).strip()
        # 50,000 文字で切る。500 KB のログ一つで後続の会話を押し出さないため
        return out[:50000] if out else "(no output)"
    except subprocess.TimeoutExpired:
        # 固まったコマンドは 120 秒で諦め、ループを先へ進める
        return "Error: Timeout (120s)"
```

役割分担はここで決まる。モデルは判断だけを担う（実行するか、何を実行するか）。プログラムは実行を担う（本当にコマンドを動かし、結果を持ち帰る）。モデルが要求しただけでは実行にならない。あなたのコードこそが手だ。以降の各章で追加する機能も、すべてこの分担に従う。

---

## 人手の往復をループに変える

冒頭の「コマンドを実行し、結果を貼り戻す」という作業をコードに置き換える。全部で五段階だ。

**ステップ 1**：ユーザーの質問を最初のメッセージにする。

```python
messages = [{"role": "user", "content": query}]
```

**ステップ 2**：メッセージとツールメニューをモデルへ送る。

```python
response = client.messages.create(
    model=MODEL, system=SYSTEM, messages=messages,
    tools=TOOLS, max_tokens=8000,
)
```

`system` はモデルの役割と仕事の進め方を伝える常設の指示だ。ここでは「Coding Agent として bash で作業し、説明より行動を優先する」と伝える。s10 では、この指示の組み立て方を詳しく扱う。

**ステップ 3**：モデルの応答を履歴へ追加し、作業を続けたいのか、もう話し終えたのかを見る。判断材料は `stop_reason` だ。ツールを要求したときは `"tool_use"`、要求していなければタスクを終えたとみなし、ループを抜ける。

```python
messages.append({"role": "assistant", "content": response.content})
if response.stop_reason != "tool_use":
    return
```

**ステップ 4**：モデルが注文したツールをすべて実行し、識別子を対応させて結果を集める。

```python
results = []
for block in response.content:
    if block.type == "tool_use":
        output = run_bash(block.input["command"])
        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,   # どの呼び出しの結果かを識別子で対応させる
            "content": output,
        })
```

**ステップ 5**：結果を新しい `user` メッセージとして追加し、ステップ 2 に戻る。

```python
messages.append({"role": "user", "content": results})
```

プログラムが作ったツール結果なのに `role` が `user` なのは、最初は不思議に見える。モデルの視点では、`assistant` は「自分が言ったこと」、`user` は「外の世界から届いた情報」だ。コマンド出力は、まさに外の世界から返ってきた反響である。

一つの関数にまとめるとこうなる。

```python
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

具体的なタスクを一つ通し、`messages` がどう増えるかを見てみよう。タスクは `Create a file called hello.py that prints "Hello, World!"`。典型的な実行は次の形になる（毎回まったく同じとは限らない）。

```text
messages[0]  user       Create a file called hello.py ...
messages[1]  assistant  tool_use: bash("echo 'print(...)' > hello.py")   ← 第 1 ターン
messages[2]  user       tool_result: (no output)
messages[3]  assistant  tool_use: bash("python hello.py")                ← 第 2 ターン
messages[4]  user       tool_result: Hello, World!
messages[5]  assistant  text: ファイルを作成し、検証しました。             ← tool_use なし、ループ終了
```

第 2 ターンで検証するように指示した人はいない。モデルは第 1 ターンの成功を見て、自分で次の一手を決めた。ループの価値はここにある。モデルが結果を見てから次を考えられるため、計画、実行、確認が一本につながる。ループが認識するシグナルは二つだけだ。

| シグナル | 意味 | ループの動作 |
|----------|------|--------------|
| `stop_reason == "tool_use"` | モデルがツールを要求 | 実行し、結果を返して続行 |
| `stop_reason != "tool_use"` | モデルがツールを要求しない | 生成終了、ループを抜ける |

> 実際の Claude Code は `stop_reason` を見ない。ストリーミング応答では、`tool_use` ブロックがすでに届いていてもこのフィールドがまだ更新されていないことがあるため、本番のループは応答内容に `tool_use` があるかを直接確認する。教学版では、非ストリーミング呼び出しなら十分正確で、判断もわかりやすい `stop_reason` を使う。

---

## 陥りやすい三つの落とし穴

**`tool_result` は必ず `tool_use` と対にする。** 各結果には `tool_use_id` が必要で、直後の `user` メッセージに置かなければならない。欠けたり位置がずれたりすると、API は即座に 400 エラーを返す。この対応関係は s08 までついてくる。履歴を切り詰めるときも、この二つを分離してはいけない。

**エラーも含め、結果をそのまま返す。** `command not found` や Python の traceback といった失敗出力を捨てず、`tool_result` に入れる。モデルが方針を修正するには、何が失敗したかを見る必要がある。

**`while True` にはヒューズがない。** 教学版は意図的にターン上限を設けず、止まるかどうかを完全にモデルへ任せている。大半のタスクは終われば止まる。止まらなければ `Ctrl+C` だ。本番システムをこのまま走らせることはできない。s11 と s22 で、ターン上限や予算制御などの保護を追加する。

---

## 試してみる

> **教学デモの注意**：このコードはモデルが生成した shell コマンドを実行する。プロジェクトファイルへの影響を避けるため、一時テストディレクトリで実行してほしい。s03 では本格的な権限システムを扱う。

**準備**（初回のみ）：

```sh
pip install -r requirements.txt
cp .env.example .env
# .env を編集し、ANTHROPIC_API_KEY と MODEL_ID を設定
```

**実行**：

```sh
python s01_agent_loop/code.py
```

次の三つを試そう。黄色い `$ ...` の行はループが実行したコマンドだ。各タスクに何ターンかかったか数えてみる。

1. `Create a file called hello.py that prints "Hello, World!"`：通常は二ターン。作成後、自発的に一度検証する。
2. `List all Python files in this directory`：通常は一ターン。リストを受け取れば、そのまま回答できる。
3. `What is the current git branch?`：一ターン。その後 `Now count how many commits this branch has` と続け、同じ履歴の上で作業を継続する様子を見る。

観察するのは、モデルがいつ次のツールを呼び出してループを続け、いつ直接回答してループを終えるかだ。コードがターン数を固定しているわけではない。ループを抜けるのはモデルの判断である。

---

## 次へ

今のモデルが持つツールは bash だけだ。ファイルを読むには `cat`、書くには `echo ... >`、探すには `find` が必要で、直感的ではなく間違えやすい。

s02 Tool Use → 本格的なツールを五つ与えたらどうなるか。モデルは一度に複数のツールを呼ぶのか。並行実行するツール同士が干渉することはないのか。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
