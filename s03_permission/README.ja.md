# s03: Permission — 実行前に権限を判断する

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → `s03` → [s04](../s04_hooks/) → s05 → ... → s20
> *"ツールを実行する前に権限を判断する"* — 権限パイプラインが、承認を必要とする操作を決める。
>
> **Harness レイヤー**: 権限パイプライン（deny / ask / allow）。

---

前章の最後には穴が残っていた。ファイルツールは `safe_path` によってワークスペース内へ制限されたが、bash は自由なままだ。Agent に「プロジェクトを整理して」と頼めば、`rm -rf ./src` を実行するかもしれない。

s01 の `run_bash` に隠してあった拒否リストでは防げない。リストにあるのは `rm -rf /` であり、`rm -rf ./src` ではない。それでも削除されるのはあなたのコードだ。

この章では、安全性を個々のツール実装から取り出し、すべての実行前に通る共通の関門にする。

![Permission Overview](images/permission-overview.svg)

---

## 拒否リストをツール内に書くと、なぜ駄目なのか

s01 と s02 は最も直感的な方法を使った。`run_bash` の先頭で危険な文字列リストを調べ、一致すれば拒否する。しかし三つの問題がある。

**二段階しかなく、最もよく使う第三の段階がない。** 拒否リストの世界には「許可」と「拒否」しかない。現実の危険な操作の多くは状況次第だ。`rm /tmp/cache.txt` は問題なくても、`rm src/main.py` は致命的になる。コードだけでは区別できなくても、人なら判断できる。必要なのは二択ではなく、**常に不可（deny）、状況を見て確認（ask）、そのまま許可（allow）** の三段階だ。

**安全ロジックの置き場所が違う。** チェックを `run_bash` に書いたなら、`write_file` のチェックはどこに置くのか。ツールを増やすたびに安全ロジックを実装へ書き足せば、いつか必ず一つ漏れる。遮断は全ツールが必ず通る場所、つまりディスパッチの直前でまとめて行うべきだ。

**黙って拒否すると、誰にも伝わらない。** 拒否リストが無言で操作を止めれば、ユーザーには Agent が何をしようとしたか見えず、モデルには失敗だけが返る。人の承認が必要な操作なら、「何を、なぜ」実行したいかを提示すべきだ。

そこでこの章では `run_bash` 内の拒否リストを削除し、実行前の三つの門に置き換える。

![Permission Pipeline](images/permission-pipeline.svg)

---

## 第 1 の門：ハード拒否リスト

最初の門が扱うのは「常に不可」の操作だ。議論の余地はなく、ユーザーを煩わせる理由もない。

```python
DENY_LIST = [
    "rm -rf /", "sudo", "shutdown", "reboot",
    "mkfs", "dd if=", "> /dev/sda",
]

def check_deny_list(command: str) -> str | None:
    for pattern in DENY_LIST:
        if pattern in command:
            return f"Blocked: '{pattern}' is on the deny list"
    return None   # 一致しなければ次の門へ
```

一致すれば即座に拒否し、ターミナルに ⛔ を出す。ユーザーには尋ねない。

正直な注意点もある。単純な文字列照合は、信頼できるセキュリティ機構ではない。コマンドの変形や shell 展開で回避できる。教学版がこれを使うのは、パイプラインの構造を明確に見せるためだ。

この門は「常に不可」を扱えるが、「状況次第」は扱えない。`rm ./src` を止めるべきかは、そのときのユーザーの意図で決まり、静的な表には書けない。

---

## 第 2 の門：確認すべき場面を見つけるルール

第二の門はルールの集合だ。各ルールには、対象ツール、一致条件、ユーザーに見せる理由の三つを書く。

```python
PERMISSION_RULES = [
    {"tools": ["write_file", "edit_file"],
     # 解決後の対象パスがワークスペースの外へ出ている
     "check": lambda args: not (WORKDIR / args.get("path", "")).resolve().is_relative_to(WORKDIR),
     "message": "Writing outside workspace"},
    {"tools": ["bash"],
     # 削除、システムディレクトリへの書き込み、権限変更を含む
     "check": lambda args: any(kw in args.get("command", "") for kw in ["rm ", "> /etc/", "chmod 777"]),
     "message": "Potentially destructive command"},
]

def check_rules(tool_name: str, args: dict) -> str | None:
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return rule["message"]
    return None
```

ルールの責任範囲に注意しよう。ルールがするのは「この場面は人に確認すべきだ」と識別するところまでで、最終判断はしない。判断するのは次の門だ。

---

## 第 3 の門：ユーザーに判断を委ねる

ルールに一致すると、プログラムは止まり、人の判断を待つ。

```python
def ask_user(tool_name: str, args: dict, reason: str) -> str:
    print(f"\n⚠  {reason}")
    print(f"   Tool: {tool_name}({args})")
    choice = input("   Allow? [y/N] ").strip().lower()
    return "allow" if choice in ("y", "yes") else "deny"
```

`[y/N]` で N が大文字なのは意図的だ。何も入力せず Enter を押すと拒否になる。一度タスクを中断する代償は、一度の誤操作を許可する代償よりはるかに小さい。

三つの門を一本のパイプラインへつなぐ。

```python
def check_permission(block) -> bool:
    if block.name == "bash":
        reason = check_deny_list(block.input.get("command", ""))   # 第 1 の門
        if reason:
            print(f"\n⛔ {reason}")
            return False
    reason = check_rules(block.name, block.input)                  # 第 2 の門
    if reason:
        decision = ask_user(block.name, block.input, reason)       # 第 3 の門
        if decision == "deny":
            return False
    return True   # どの門にも止められなければ許可
```

---

## ループへ戻す：拒否にも結果が必要

ループ側の変更はおなじみの形だ。実行前に判断を一つ追加する。

```python
for block in response.content:
    if block.type != "tool_use":
        continue

    # s03 で追加：実行前に権限パイプラインを通す
    if not check_permission(block):
        results.append({"type": "tool_result", "tool_use_id": block.id,
                        "content": "Permission denied."})
        continue

    handler = TOOL_HANDLERS.get(block.name)
    output = handler(**block.input) if handler else f"Unknown: {block.name}"
    results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
```

この短いコードには、破ってはいけない二つの規則がある。

**拒否は省略ではない。** 止めた呼び出しにも、`"Permission denied."` を含む `tool_result` を返す。s01 で見た対応規則どおり、各 `tool_use` には対応する `tool_result` が必要で、黙って飛ばすと API は 400 エラーを返す。また、拒否という情報自体にも価値がある。モデルはそれを見て、待ち続けるのではなく別の方法を選べる。

**deny を ask より先に置く。** 門の順序は逆にできない。先にユーザーへ聞き、後からハード拒否リストを見る設計では、`sudo rm -rf /` まで「許可しますか」と尋ねることになり、絶対的な境界を一度の押し間違いに委ねてしまう。

> 実際の Claude Code では、ルールは一枚の表ではない。ユーザー、プロジェクト、ローカル、企業ポリシー、CLI 引数、セッション内の許可など八つの設定元から優先順位に従って統合される。判断動作も四種類あり、ツール自身が判断しないとき共通パイプラインへ渡す `passthrough` が加わる。auto モードでは分類モデルが先に判断し、安全な操作は自動許可し、迷うものだけを人に聞く。教学版は構造を一目で見せるため、一枚の表と三つの門に絞っている。

---

## s02 からの変更

| コンポーネント | 変更前 (s02) | 変更後 (s03) |
|----------------|--------------|--------------|
| 安全モデル | `run_bash` 内の拒否リスト | 三つの門からなる権限パイプライン |
| 判断 | 許可 / 拒否 | deny / ask / allow |
| 新しい関数 | — | `check_deny_list`, `check_rules`, `ask_user`, `check_permission` |
| ループ | すべてのツールを直接実行 | 実行前に `check_permission()` を挿入 |

---

## 試してみる

```sh
cd learn-claude-code
python s03_permission/code.py
```

ターミナルには三つの結果が現れる。何も表示せず直接実行、第二の門に一致したときの ⚠ と `Allow? [y/N]`、第一の門に一致したときの ⛔ だ。それぞれを発生させてみよう。

1. `Create a file called test.txt in the current directory`：ワークスペース内への書き込みなのでルールに一致せず、そのまま実行される。
2. `Delete the file test.txt`：モデルは bash で `rm test.txt` を実行しようとし、`"rm "` ルールに一致して y または N を待つ。
3. `Run sudo whoami`：ハード拒否リストに一致し、質問せず ⛔ で拒否される。
4. `Try to write a file to /etc/something`：ワークスペース外への書き込みなので第二の門が確認する。あえて y を押してみよう。実行時には `safe_path` がなお `Path escapes workspace` を返す。対話層の許可はパス境界の許可ではない。二つの防御は互いを信用しない。

拒否された後、モデルの次の動きを見る。`Permission denied.` を受け取ると、通常は理由を説明するか、別の方法へ切り替える。これが「拒否にも結果が必要」な理由だ。

---

## 次へ

権限チェックはできたが、まだループ内に直接書かれた一回の関数呼び出しだ。すべてのツール実行を記録したい、ファイル変更後に formatter を動かしたい、といった要求を一つずつループへ追加すれば、すぐに特殊処理の塊になる。

s04 Hooks → ループに取り付け口を作る。拡張ロジックを hook に掛け、ループ自体はきれいなまま保つ。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
