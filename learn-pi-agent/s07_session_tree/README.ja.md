# s07 · Session Tree

[English](README.md) · [中文](README.zh.md) · 日本語

[← s06](../s06_turn_state/README.ja.md) · [目次](../README.ja.md) · [s08 →](../s08_context_resources/README.ja.md)

> ひとことで：session はメッセージの列ではなく、追記しかしない entry の木です。現在の会話位置は、移動可能な leaf ポインタが決めます。
>
> Pi の中での位置：`@earendil-works/pi-agent-core` harness の session 層（`session.ts` + `jsonl-storage.ts`）。`pi-coding-agent` の `/tree`・`/fork`・`/clone` はすべてこの上に建っています。

→ 古い質問に戻って別の道を試す——コピーも削除もせず、leaf ポインタの記録を 1 行追記するだけ
→ 「leaf を動かす」というナビゲーション動作そのものも JSONL の 1 行。履歴は最初から最後まで書き換えられない
→ モデルが見るのは leaf から root までの一本道だけ。古い branch はファイルに残るが、現在のリクエストには入らない
→ 追記のみで書き換えなしだからこそ、どの JSONL からでも木全体と leaf の位置を完全に再構築できる

---

## 問題

ごく普通の利用シーンを想像してください：

```text
あなた：このリポジトリはどこから読み始めればいい？
Pi：まず README を読んでください。
どうも違う気がして、さっきの質問に戻って別の道を試したくなった。
```

session がただの `messages[]` だったら、目の前にあるのは 3 つの不格好な選択肢です：

```text
古い回答を上書きする              履歴が消える。あとで 2 つの道を見比べたくても、もう比べられない
session を丸ごと複製する          ファイルが倍になり、2 つの履歴はそれぞれ勝手に漂流していく
2 つの道を 1 本のリストに詰める   モデルは矛盾する 2 つの回答を同時に見ることになる
```

3 つとも、同じ欠陥への継ぎ当てです。フラットな配列では「履歴がここで分岐した」を表現できません。

## 考え方

Pi は 4 つ目の道を選びました。履歴は書き換えず、entry はひたすら append する。各 entry は自分の `parentId` を覚えている。現在の会話位置は leaf ポインタが決める。戻って別の道を試したければ、leaf をそこまで移動させ、新しいメッセージをそこにつなげばいい。

だから `/tree`・`/fork`・`/clone` は UI の小機能ではありません。その裏にあるのは同じデータ構造——会話を分岐できる木として扱う、という考え方です。

本物の Pi の entry は種類が多い（`compaction`・`branch_summary`・`custom`・`custom_message`・`label`・`session_info`……）のですが、s07 は `message` と `leaf` の 2 種類だけを残して、木の骨格をつかみます。

## まず動かす

```sh
npm run session:s07
```

出力はだいたいこうなります：

```text
Session: demo-session
Old branch: How should Pi store sessions? -> As a plain message list.
Active branch: How should Pi store sessions? -> As an append-only entry tree with a movable leaf.
Current leaf: e4
Children of question: e2, e4
JSONL row types: session -> message -> message -> leaf -> message
New answer parent: e1
```

`Children of question: e2, e4` に注目してください——同じ質問の下に assistant の回答が 2 つぶら下がっています。これが branch です。古い回答（Old branch）はいまでも丸ごと読み出せますが、現在の branch（Active branch）の中身はすでに入れ替わっています。

`JSONL row types` の真ん中にある `leaf` 行は覚えておいてください。これはナビゲーションの記録で、下の branch の説明でどうやって生まれるかが見えてきます。

## コードの中身

### entry は 2 種類

```ts
export type MessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: SessionMessage;
};

export type LeafEntry = {
  type: "leaf";
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string | null;
};
```

`message` は会話の中身、`leaf` はナビゲーションの記録。どちらも `parentId` を持ちます——木はこのフィールドの上に育ちます。

### appendMessage：新しいメッセージは現在の leaf の後ろにつながる

```ts
appendMessage(message: SessionMessage): string {
  const entry: MessageEntry = {
    type: "message",
    id: this.createEntryId(),
    parentId: this.leafId,
    timestamp: this.now(),
    message: { ...message },
  };

  this.appendEntry(entry);
  this.leafId = entry.id;
  return entry.id;
}
```

現在の `leafId` が誰であれ、それが新しい message の `parentId` になります。append が終わると、leaf は新しい message の上に移動します：

```text
e1 user
└─ e2 assistant  ← leaf
```

### branch：コピーも削除もしない、leaf を動かすだけ

```ts
branch(entryId: string): string {
  if (!this.byId.has(entryId)) {
    throw new Error(`Entry ${entryId} not found`);
  }
  return this.moveLeaf(entryId);
}
```

`branch()` は仕事を `moveLeaf()` に渡します。実際にやることは 2 ステップだけ——`LeafEntry` を 1 件追記し（過去の entry には一切触れない）、メモリ上の `leafId` を `targetId` に向けます：

```ts
private moveLeaf(targetId: string | null): string {
  const entry: LeafEntry = {
    type: "leaf",
    id: this.createEntryId(),
    parentId: this.leafId,
    timestamp: this.now(),
    targetId,
  };

  this.appendEntry(entry);
  this.leafId = targetId;
  return entry.id;
}
```

demo 出力にあった `leaf` 行がまさにこの記録です。`parentId` は移動前の leaf の位置を、`targetId` は戻り先の entry を指します。次の message が追記されるときに読む `leafId` はすでに変わっているので、自然と新しい位置の後ろにつながり、sibling branch として育ちます：

```text
e1 user
├─ e2 assistant
└─ e4 assistant  ← leaf
```

古い branch は微動だにせず、現在の branch だけが変わりました。これが Pi の「古い回答を上書きしない」ことのコストと見返りです。ポインタの記録を 1 行余分に書く代わりに、履歴が丸ごと残ります。

### buildContext：モデルは現在の branch しか見ない

```ts
buildContext(fromId: string | null = this.leafId): SessionContext {
  return {
    messages: this.getBranch(fromId)
      .filter((entry): entry is MessageEntry => entry.type === "message")
      .map((entry) => ({ ...entry.message })),
  };
}
```

モデルに木全体は要りません。leaf から root までの経路上の message だけで十分です。demo の active branch から見えるのはこれだけ：

```text
How should Pi store sessions?
As an append-only entry tree with a movable leaf.
```

古い回答は JSONL の中に残っていますが、現在のリクエストには送られません。

### JSONL：書き出して、読み戻す

```ts
toJSONL(): string {
  return [this.header, ...this.entries].map((row) => JSON.stringify(row)).join("\n") + "\n";
}
```

1 行 1 オブジェクト、常に追記。分岐した後の行タイプはこうなります：

```text
session -> message -> message -> leaf -> message
```

古いメッセージは 1 行も動いていません。`leaf` 行はナビゲーションを 1 回記録しただけです。

読み戻すのは `loadSessionTreeFromJSONL()` です。JSONL を 1 行ずつスキャンし、健全性チェック（親ノードの存在、leaf の target の存在、タイプの正しさ）を済ませたあと、核心はこの 4 行：

```ts
const entry = cloneEntry(row);
entries.push(entry);
byId.set(entry.id, entry);
leafId = entry.type === "leaf" ? entry.targetId : entry.id;
```

message は `byId` に入り、`leaf` は `leafId` を自分の `targetId` に切り替えます。どの entry も `parentId` を持っているので木構造は自然に再構築され、最後の行を読み終えたとき、`leafId` はちょうど現在位置に止まっています。履歴は追記のみで書き換えられないので、どの JSONL からでも木全体を無損失で再構築できます——この節のテストにある round-trip（`toJSONL()` してから `loadSessionTreeFromJSONL()`）が検証しているのはまさにそれです。再構築した木は、branch 構造も leaf の位置も元と寸分違いません。

## 手を動かす

1. 同じ質問に 3 本目の branch を作ってみます。`runDemo()` の `secondAnswerId` の行の直後に追加：

   ```ts
   session.branch(questionId);
   session.appendMessage({ role: "assistant", content: "As a database table." });
   ```

   再実行すると `Children of question` は e2, e4, e6 になります。なぜ e5 が飛ばされたのでしょう？ `branch()` がまた leaf 行を 1 つ書き、e5 はそれに取られたからです——`JSONL row types` の末尾にも `leaf -> message` が増えています。

2. JSONL を丸ごと dump して眺めてみます。`runDemo()` の最後に `console.log(session.toJSONL())` を足し、leaf 行を数え、各行の `parentId` と `targetId` を突き合わせれば、紙の上に木全体を描けます。

3. 古い branch の視点から再構築してみます。JSONL を読み戻し、古い回答の id から遡ります：

   ```ts
   const loaded = loadSessionTreeFromJSONL(session.toJSONL());
   console.log(loaded.buildContext(firstAnswerId).messages.map((message) => message.content).join(" -> "));
   ```

   再構築後の木からも古い branch はちゃんと振り返れます——出力は demo の Old branch の行と完全に一致します。

変更したら `npm run test:s07` で、この節の振る舞いの約束を壊していないか確認できます。

## 本線につなぐ

s06 は session をブラックボックスとして扱いました。必要なのは `buildContext()` と `getMetadata()` の 2 つの口だけ。s07 はそのブラックボックスの正体です：

| コンポーネント | 前節（s06） | 本節（s07） |
| --- | --- | --- |
| session の内部 | フラットな messages 配列 | append-only の entry tree + 移動可能な leaf |
| `buildContext()` | 全メッセージをコピーして返す | leaf -> root の経路に沿って現在の branch の message を抽出 |
| `getMetadata()` | id のみ | id・createdAt・cwd。JSONL のヘッダ行から |
| 永続化 | なし、メモリのみ | `toJSONL()` / `loadSessionTreeFromJSONL()` の round-trip |

本物の Pi では、`agent-harness.ts` の `createTurnState()` が呼んでいるのはまさにこの session tree の `buildContext()` と `getMetadata()` です——s06 がスナップショットを撮るときに session へ求めるものを、この木はすべて差し出せます。分岐の能力は上の層から完全に透明です。

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) へ。

見どころは 3 つ。`Session.appendMessage()` も同じく現在の leaf を `parentId` に使います。`JsonlSessionStorage.setLeafId()` は leaf の移動を leaf entry として書き出します。mini の `moveLeaf()` と同じ書き方です。`getPathToRoot()` は `parentId` を辿って root まで歩きます。buildContext の土台です。この 3 つをつなげると、Pi の session tree の最小の閉ループになります。

## 次の節

s07 は「現在の branch にどんなメッセージがあるか」に答えました。しかし s06 のスナップショットには、まだ展開していないフィールドがひとつあります。resources です。skills・prompt templates・AGENTS.md といったプロジェクトの中のリソースを、Pi はどうやって発見し、どうやってターンに積み込むのでしょうか。

[s08 Context Resources](../s08_context_resources/README.ja.md)：プロジェクトのリソースを現在の turn に集めます。
