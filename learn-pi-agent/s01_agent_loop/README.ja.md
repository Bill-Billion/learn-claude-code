# s01 · Agent Loop

[English](README.md) · [中文](README.zh.md) · 日本語

[目次](../README.ja.md) · [s02 →](../s02_tool_schema/README.ja.md)

> ひとことで：agent loop はまず、messages と stopReason を軸にした制御フローです——user が入り、状態が一巡し、assistant が出てくる。
>
> Pi の中での位置：`@earendil-works/pi-agent-core` の最小の状態フロー。

→ Pi を開いてまず目に入るのはターミナルとコマンドですが、その下にあるのは数十行で書ける制御フローです
→ 1 リクエストの最小スライス：user message が入り、状態が一巡して、assistant message が出てくる
→ stopReason のシグナルは 3 つ：stop / toolUse / error。toolUse はこの節では記録されるだけで、実行はされません

---

## 問題

Pi を開くと、まずターミナル UI、モデル選択、session、extension、そして大量のコマンドが目に入ります。初学者はそのままそれらを追いかけて、agent の本体はコマンドと UI の中にあると思い込みがちです。

しかし Pi の層構造では、その下にあるのが `@earendil-works/pi-agent-core` です。この層はターミナルの見た目に関心がなく、ツールがどう実行されるかにも関心がありません。問うのはもっと小さいことだけです：いまどの `AgentMessage` があるか、次のリクエストをどの provider に送るか、そして assistant が返ってきたあと、このターンは終了なのか、エラーなのか、ツールを呼びたいのか。

ここが見えないままだと、この先のイベントストリーム、ツール、session tree、extension runtime の話が、ぜんぶ仕組みの名前の羅列になってしまいます。s01 がやることは 1 つだけ：user message から assistant message までの状態変化を 1 ターン動かすことです。

## 考え方

![Agent Loop](images/agent-loop.svg)

最小の `runOneTurn()` を書きます：まず user message を状態に入れ、状態全体を provider に渡し、最後に assistant message を状態に戻す。

この節で残すシグナルは 3 つだけです：

| シグナル | 意味 | この節での動作 |
|------|------|---------|
| `stopReason == "stop"` | assistant が正常に終了した | assistant message を記録する |
| `stopReason == "toolUse"` | assistant がツールを呼びたい | シグナルを保持するだけで、ツールは実行しない |
| `stopReason == "error"` | provider が正しい入力を受け取れなかった | エラーメッセージを記録する |

この節ではツール実行も、session ファイルも、イベントストリームも、ターミナル UI も扱いません。

## まず動かす

```sh
npm run session:s01
```

出力はこんな感じです：

```text
User: hello
Assistant [stop]: Received: hello
User: does this lesson have tools?
Assistant [toolUse]: I want to call a tool, but this lesson has no tool executor yet.
Messages: 4
```

この 4 件のメッセージが現在の状態です：

```text
user
assistant
user
assistant
```

2 ターン目に注目してください：`stopReason=toolUse` は provider から流れてきましたが、ツールは何も実行されていません。s01 はそれをメッセージに残すだけで、本物の tool executor につながるのは s04 です。

## コードの中身

4 ステップです。

**ステップ 1**：agent state を作る。s01 の state は `messages` だけです。

```ts
export function createInitialState(): AgentState {
  return { messages: [] };
}
```

**ステップ 2**：ユーザー入力を `AgentMessage` に包んで、状態に追加する。

```ts
const userMessage = createUserMessage(userInput);
state.messages.push(userMessage);
```

**ステップ 3**：現在の messages を provider に渡す。ここの `DemoProvider` は偽物のモデルで、API key がなくてもコースが安定して動くようにするためのものです。入力に `tool` という単語が含まれるかを見て toolUse を擬似的に発生させます——実際の provider ではツールを呼ぶかどうかをモデル自身が決めます。ここの文字列マッチは、stopReason というシグナルを安定して再現させるためだけのものです。

```ts
const assistantMessage = await provider.complete(state.messages);
```

**ステップ 4**：assistant message を状態に戻し、このターンの結果を返す。

```ts
state.messages.push(assistantMessage);
return assistantMessage;
```

全体を組み上げると：

```ts
export async function runOneTurn(
  state: AgentState,
  provider: Provider,
  userInput: string,
): Promise<AssistantMessage> {
  const userMessage = createUserMessage(userInput);
  state.messages.push(userMessage);

  const assistantMessage = await provider.complete(state.messages);
  state.messages.push(assistantMessage);

  return assistantMessage;
}
```

10 行足らずです。これはまだ完全な agent loop ではなく、1 リクエストの最小スライスにすぎません。Pi の実際の loop は、この線の上に provider event stream、tool execution、hook、session、runtime mode を積み重ねていきます。

## 手を動かす

`--demo` を付けずに実行すると、対話 REPL に入ります：

```sh
node s01_agent_loop/code.ts
```

まず適当に何往復か話してから、`tool` を含む一文を入力して、`[stop]` が `[toolUse]` に変わるのを観察してください。

続けて、少し書き換えてみます：

1. `DemoProvider` に 3 つ目のトリガーを追加する——入力に `fail` が含まれたら `stopReason: "error"` を返す。REPL に入り直して、3 つのシグナルがすべて発火することを確認します。
2. `provider.complete()` の先頭に `console.log(messages.length)` を 1 行足して、何ターンか話してみる。1、3、5……と増えていくのが見えるはずです——provider は毎ターン完全な履歴を見ていて、最後の一文だけを見ているのではありません。この事実が、この先すべての節の土台になります。

書き換えたら `npm run test:s01` で、この節の挙動の約束を壊していないか確認できます。

## 本線につなぐ

s01 には比較できる前の節がありません。ここで立てるのは、この先の全節が踏むことになる土台です：

| この節で立てた部品 | この先どこで使うか |
| --- | --- |
| `AgentMessage` / `AgentState` | s04 の tool loop、s06 の turn state、s07 の session tree はすべてこれの拡張 |
| `Provider` インターフェース | s03 がイベント化し、s04 からはループで呼び出す |
| `stopReason` | s04 の tool loop がこれを見て、ターンを続けるか終えるかを決める |

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) を見てください。

対応関係をひとことで：s01 の `runOneTurn()` は、Pi の `agent-loop.ts` にある `runAgentLoop()` と `runLoop()` の最小経路に対応し、`AgentState.messages` は `AgentContext.messages` に対応します。Pi の実際の loop にはさらに event stream、context の変換、tool execution があります——provider event stream が出てきたら s03 まで飛んでかまいません。tool execution が出てきたらそこで止めてください。それは s04 の内容です。

## 次の節

これで core は user/assistant の 1 ターンを回せるようになりましたが、assistant はまだ外部の能力を実際には呼べません。モデルがファイルを読みたい、書きたい、コマンドを実行したいなら、まずどんなツールが使えるのか、各ツールの入力がどんな形なのかを知る必要があります。

[s02 Tool Schema](../s02_tool_schema/README.ja.md)：Pi はローカル関数をそのままモデルに渡すのではなく、まずツールを provider が読める schema として記述します。
