# s03 · Provider Events

[English](README.md) · [中文](README.zh.md) · 日本語

[← s02](../s02_tool_schema/README.ja.md) · [目次](../README.ja.md) · [s04 →](../s04_evented_tool_loop/README.ja.md)

> ひとことで：provider はモデルが文字列を丸ごと吐き終えるのを待つのではなく、生成の過程そのものを、done か error で必ず締まるイベントストリームに変えます。
>
> Pi の中での位置：`@earendil-works/pi-ai` の `AssistantMessageEvent` ストリーム——core が上位層に差し出す出力インターフェースです。

→ イベントには完全なライフサイクルがあります。start が開幕し、text_* / toolcall_* はそれぞれ「start / delta / end」の三段階を踏み、最後は必ず done か error で締まります
→ すべてのイベントが完全な partial スナップショットを背負っているため、consumer はステートレスでいられます——どのイベントを 1 つ受け取っても現在の全体像を描画できます
→ content block の連続性は保証されません。block 0 の途中に block 1 が割り込むことがあり、それらをつなぎ直せるのは contentIndex だけです
→ `ProviderContext` は s02 の tool 契約と systemPrompt をまとめて provider に渡します。toolcall イベントから流れてくるのは呼び出しの意図であって、実行結果ではありません

---

## 問題

s01 の `provider.complete()` は普通の関数のように見えます。messages を入れると assistant message が返る。入門にはこれで十分ですが、Pi の姿ではありません——モデルは回答全体を一気に考えて返すのではなく、token を 1 つずつ生成します。全部生成し終わるまで返さない設計だと、ターミナルは空白の画面を眺めて待つしかありません。

Pi の `pi-ai` が上位層に渡すのは event stream です。モデルの開始、テキストの増分、tool 引数の増分、終了理由——すべてが 1 件ずつのイベントになります。同じストリームには少なくとも 3 種類の consumer がいます。ターミナル UI は受信しながら描画し、RPC モードは同じイベント列を JSONL として書き出し、agent-core は assistant message の完成後に tool 呼び出しの処理へ進みます。出力インターフェースを「1 つの戻り値」から「1 本のイベントストリーム」に替えて初めて、この 3 つの消費スタイルが共存できます。

s03 で見るのは provider イベントだけです。tool は実行しません。

## 考え方

provider のインターフェースを差し替えます。`stream(context)` が `AsyncIterable<ProviderEvent>` を返します。イベントは役割ごとに層になっています：

| イベント | いつ現れるか | 何を持つか |
|------|------------|--------|
| `start` | ストリーム開始 | `partial` |
| `text_start` / `text_delta` / `text_end` | 1 つの text block のライフサイクル | `contentIndex`、増分または確定版、`partial` |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 1 つの tool call block のライフサイクル | `contentIndex`、増分または確定版、`partial` |
| `done` | 正常な締め | `reason` + 完全な `message` |
| `error` | 異常な締め | `reason` + エラーの `message` |

ここには本物の設計トレードオフがあります。すべてのイベントが完全な `partial`——その時点までの assistant message のスナップショット——を背負っています。一見無駄に見えます。delta にはすでに増分が入っているのに、なぜ全量まで持たせるのか。理由は、consumer をステートレスにできるからです。UI は「どこまで組み立てたか」の累積バッファを自前で管理しなくてよく、途中から参加する consumer も過去のイベントを再生する必要がありません。どのイベントを 1 つ拾っても現在の全体像を描画できます。代償はイベント発行のたびに 1 回のクローン——`cloneMessage()` が存在する理由です。provider は内部でずっと同じ partial オブジェクトを mutate し続けるので、yield の前にコピーしなければ、consumer が保存しておいた古いスナップショットが後続の mutation で書き換わってしまいます。

ストリームの締め方は固い約束です。`done` か `error` のどちらか、第三の終わり方はありません。consumer はこの不変条件を頼りに最終結果を受け取ります。

## まず動かす

```sh
npm run session:s03
```

出力：

```text
Text events: start -> text_start -> text_delta -> text_delta -> text_delta -> text_end -> done
Text: Pi streams events.
Tool events: start -> toolcall_start -> toolcall_delta -> toolcall_end -> done
Stop reason: toolUse
Tool call: read {"path":"README.md"}
```

1 行目は text stream の完全なライフサイクルで、3 つの `text_delta` は demo の 3 つの chunk に対応します。3 行目は tool call stream。骨格は同じで、真ん中が `toolcall_*` に入れ替わっています。最後の 2 行に注目してください——ストリームには `read` の呼び出し意図と引数が現れましたが、ファイルは 1 つも読まれていません。

## コードの中身

**ステップ 1**：イベント型を全部書き出します。現在の実装には 9 つのバリアントがあります：

```ts
export type ProviderEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "error" | "aborted">; error: AssistantMessage };
```

前の 7 つはすべて `partial` を持ちます。`done` と `error` が持つのは確定版です。`reason` は `Extract` で絞り込んであります。done は正常終了の 3 種類だけ、error は error か aborted だけ——「ストリームがどう終わるか」の合法な経路はすべて、1 つの union 型に固定されています。

**ステップ 2**：provider の入力も構造化された context に替えます：

```ts
export type ProviderContext = {
  messages: unknown[];
  tools: ToolDefinition[];
  systemPrompt?: string;
};
```

`tools` に入るのは s02 の `listToolDefinitions()` の出力そのものです。provider に見えるのは契約だけで、handler は見えません。`systemPrompt` は省略可能なパススルー用フィールドで、この節のテストには「そのまま provider に届くこと」を守るテストが 1 本あります。

**ステップ 3**：text stream の provider。

```ts
export function createTextProvider(chunks: string[]): EventProvider {
  return {
    async *stream() {
      const partial = createAssistantMessage();
      partial.content.push({ type: "text", text: "" });

      yield { type: "start", partial: cloneMessage(partial) };
      yield { type: "text_start", contentIndex: 0, partial: cloneMessage(partial) };

      for (const chunk of chunks) {
        const block = partial.content[0] as TextContent;
        block.text += chunk;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: chunk,
          partial: cloneMessage(partial),
        };
      }

      const text = (partial.content[0] as TextContent).text;
      yield { type: "text_end", contentIndex: 0, content: text, partial: cloneMessage(partial) };
      yield { type: "done", reason: "stop", message: cloneMessage(partial) };
    },
  };
}
```

完全なライフサイクルが揃っています。`start` で開幕し、`text_start` が block 0 の開始を宣言し、ループ内で chunk を 1 つ追記するごとに `text_delta` を 1 件発行し、`text_end` がブロック全体の確定版を出し、最後に `done` で締めます。すべての yield が `cloneMessage(partial)` を通ります——「考え方」で述べたスナップショットの分離は、この 1 行に集約されています。

**ステップ 4**：tool call stream の provider。冒頭でまず `context.tools` に契約を照会します：

```ts
export function createToolCallProvider(name: string, args: Record<string, unknown>): EventProvider {
  return {
    async *stream(context) {
      if (!context.tools.some((tool) => tool.name === name)) {
        const error = createAssistantMessage();
        error.stopReason = "error";
        yield { type: "start", partial: cloneMessage(error) };
        yield { type: "error", reason: "error", error };
        return;
      }
```

tool が契約リストにない場合、ストリームはそのまま error で締めます——注目すべきは、エラー時でも「必ず締めのイベントを出す」約束が破られていないことです。後半はここでは省略します（完全なコードは code.ts にあります）が、構造は text stream と同型です。`toolcall_start` でブロックを開き、`toolcall_delta` が引数の増分を流し（demo では `JSON.stringify(args)` を一度に全量吐きますが、実際の provider はこの JSON を細かく刻んで流します）、`toolcall_end` が完全な `ToolCall { id, name, arguments }` を出し、最後に `reason: "toolUse"` の `done` で締めます。

**ステップ 5**：交錯するストリーム。Pi のドキュメントは明確に警告しています。1 つの content block のイベントが連続して現れる保証はない、と。`createInterleavedProvider()` はその一文を実行可能な例にしたものです。イベントの順序は：

```text
start
text_start  index=0
text_delta  index=0  "first "
text_start  index=1
text_delta  index=1  "second "
text_delta  index=0  "block"
text_end    index=0  "first block"
text_delta  index=1  "block"
text_end    index=1  "second block"
done
```

block 0 が半分まで出たところで block 1 が割り込み、そのあと block 0 が戻ってきて締めます。consumer が delta を到着順にそのまま連結すると "first second blockblock" のようなものができあがります。だからこそ、すべての content イベントが `contentIndex` を持ち、index ごとに別々に組み立てます：

```text
0 -> first block
1 -> second block
```

**ステップ 6**：消費側。`collectProviderStream()` は `for await` ループそのものです。`text_delta` は contentIndex ごとに Map へ継ぎ足し、`toolcall_end` は完全な ToolCall を回収し、`done` / `error` は最終 message を記録します。`readTextBlocks()` は確定版から text block を抜き出します。ループが終わっても message が得られていなければ `Provider stream ended without done or error event` を投げます——締めの約束はドキュメント上の飾りではなく検査可能なアサーションで、締めのイベントを出さない provider はここで捕まります。

## 手を動かす

1. `createTextProvider()` の `text_delta` の yield にある `cloneMessage(partial)` を裸の `partial` に変え、`runDemo()` に `console.log(JSON.stringify(textResult.events[2]))`（最初の text_delta）を 1 行足してください。変更前のスナップショットには "Pi " しか入っていませんが、変更後は完全な "Pi streams events." になります——初期のスナップショットが後続の mutation に書き換えられたわけで、これが yield のたびにクローンする理由です。
2. demo の `createToolCallProvider("read", ...)` の tool 名を、registry に存在しない `"delete"` に変えて `npm run session:s03` を実行してください。tool stream は 5 イベントから `start -> error` に縮み、stop reason は error になります——契約に見つからない以上、ストリームは存在しない tool をモデルが呼んだことにはしません。
3. `runDemo()` に一段追加します。`collectProviderStream(createInterleavedProvider(), { messages: [], tools: [] })` でストリームを回収し、`textByIndex` を出力してください。続いて `createInterleavedProvider()` の中で、index=0 と index=1 の 2 つの `text_delta`（それぞれ直前の mutation の行ごと）の発行順を入れ替えて再実行します——contentIndex さえ正しく付いていれば、Map の中の 2 つのテキストはどちらも欠けずに揃います。

変更後は `npm run test:s03` を実行して、この節の振る舞いの約束を壊していないことを確認してください。

## 本線につなぐ

| コンポーネント | 前の節 | この節 |
| --- | --- | --- |
| provider インターフェース | s01 の `complete()` を踏襲：assistant message を丸ごと一度に返す | `stream(context)` が `AsyncIterable<ProviderEvent>` を返す。start から done/error まで |
| tool 契約 | `listToolDefinitions()` が契約を切り出したが、受け取る側がまだいない | `ProviderContext.tools` に載り、provider はこれをもとに `toolcall_*` イベントを発行 |
| toolCall | `stopReason: "toolUse"` という大まかな信号だけ | 構造化された `{ id, name, arguments }` を `toolcall_end` から取得 |
| systemPrompt | なし | `ProviderContext` の省略可能フィールドとして provider へそのまま渡る |

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) を見てください。

対応関係をひとことで言うと：`ProviderEvent` は pi-ai の `types.ts` にある `AssistantMessageEvent` に、`EventProvider.stream()` は `streamSimple()` が返す `AssistantMessageEventStream` に対応します。後者は `for await` で消費できるうえ、done/error が届いた時点で最終結果も保持します。つまり `collectProviderStream()` をストリームオブジェクトに内蔵したようなものです。Pi のイベントファミリーには `thinking_*` やさらに多くのフィールドがあり、一覧と項目ごとのアンカーは pi-source にあります。

## 次の節

イベントストリームには完全な toolCall——名前、引数、id——がもう見えていて、s02 の registry には対応する handler も控えています。ただ、この両端はまだつながっていません。

[s04 Evented Tool Loop](../s04_evented_tool_loop/README.ja.md)：`toolcall_end` をローカルの tool 実行につなぎます。そこで初めて `tool_execution_start`、`tool_execution_end`、そして toolResult message が現れます。
