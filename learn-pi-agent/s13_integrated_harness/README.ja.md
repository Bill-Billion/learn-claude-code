# s13 · Integrated Harness

[English](README.md) · [中文](README.zh.md) · 日本語

[← s12](../s12_pi_package/README.ja.md) · [目次](../README.ja.md)

> ひとことで：s13 は新しい仕組みを書きません。前 12 節の公開インターフェースを、実行可能な 1 本のリクエスト連鎖につなぐだけです——つながるなら、境界は正しく引けていたということです。
>
> Pi の中での位置：`pi-coding-agent` のプロダクト層オーケストレーション（agent-harness + resource loader + session + modes の合流点）に対応します。

→ 統合は機能追加ではなく検収です：2 つの部品が互いの内部をまさぐらないと協調できないなら、境界の引き方が間違っています
→ 連鎖全体に「グルー」は 3 箇所だけ：provider を包む adapter、hook と extension のフィールド対応付け、session への tagged JSON エンコード
→ s10 で残した宿題をここで返します：本物の core が 4 つの外殻に刺さるのは、`prompt()/getState()` というインターフェースだけの力です

---

## 問題

s01 から s12 までで部品が 1 つずつ立ちました。tool loop は s05（tool hooks）、会話は s07（session tree）、リソースは s08（context resources）、拡張は s09（extension runtime）、外殻は s10（runtime modes）、読み込み境界は s11（trust）、配布は s12（package）。どの部品にも自前のテストはありますが、これらのインターフェースが互いに噛み合うことを証明する 1 本の連鎖はまだありません。

harness の設計が一番こけやすいのがまさにここです。モジュール単体ではどれもきれいなのに、統合した途端、A が B の内部に手を突っ込まないと協調できないと分かる。そこで s13 は自分にルールを 1 つ課します：**adapter とオーケストレーションだけ。新しい実装は作らない**。tool loop は引き続き s05 が実行し、session は s07 が保存し、resource・extension・trust・package・mode はそれぞれ s08–s12 の公開インターフェースを再利用します。つながらない箇所には薄いグルーを 1 層だけ許し、しかもどのグルーも「なぜ元のインターフェースにこれがないのか」を説明できなければなりません。

## 考え方

1 回の `prompt()` はこの連鎖を通ります：

```text
prompt
  -> s11 trust:      resolveProjectTrusted() / loadProjectInputs()
  -> s12 package:    resolvePiPackages() がリソースと extension のパスを算出
  -> s09 extension:  loadMiniExtensions() + createExtensionTurnState()
  -> s07 session:    user message を append し、現在のブランチを取得
  -> グルー① adapter: provider に session branch と systemPrompt を注入
  -> s05 tool loop:  runHookedToolLoop() がツールループを実行
  -> グルー② 対応付け: s09 の tool_call handler を s05 の beforeToolCall に接続
  -> グルー③ エンコード: assistant/toolResult を tagged JSON で s07 に書き戻す
  -> s10 shell:      print / json / rpc / sdk が同じ runtime を消費
```

`createIntegratedHarnessRuntime()` は初期化時に trust、project inputs、package のリソース、extension factory を解決します。`prompt()` のたびに turn state を作り直すので、現在の session ブランチ、AGENTS.md、skill、prompt template、extension hook が同じ 1 ターンに入ります。

この節で得られるのは、決定的でオフラインな教材用 harness です。provider もファイルもすべてメモリ上の fixture で、モデル API・ネットワーク・本物の shell・プロジェクトのファイルシステムには触れません。

## まず動かす

```bash
npm run session:s13
```

出力：

```text
Session: s13-demo
Final text: Integrated harness ready.
Events: session -> agent_start -> message -> agent_end
Stored messages: 2
```

4 行はそれぞれ 4 つの部品から来ています。session id は s07 の session tree から、final text は s05 のツールループを通り抜けた結果、events は s10 外殻のイベント投影、stored messages は s07 に書き戻された記録の数です。連鎖は 1 本、出どころは 4 つ。

## コードの中身

### グルー①：provider の外側になぜもう 1 層 adapter があるのか

s05 のループが管理するのは、そのターンで新しく生まれた assistant と tool-result の message だけです。s07 は読まないし、s08 が生成する system prompt のことも知りません——これは s05 の境界であって、欠陥ではありません。s13 は provider を 1 層包みます：

```ts
provider.stream({
  ...loopContext,
  messages: [...sessionPrefix, ...extensionMessages, ...context.messages],
  systemPrompt,
});
```

最初のリクエストは現在の session ブランチを見ます。ツール実行後、s05 が新しい message を `loopContext.messages` に入れるので、次の provider リクエストは履歴とこのターンの結果を同時に見ます。tool loop は相変わらず s05 の 1 つだけです。

### グルー②：extension はどうやってツール実行を止めるのか

s09 の `tool_call` handler と s05 の `beforeToolCall` は、返り値の形がもともと一致しています。s13 がやるのはフィールドの対応付けだけです：

```ts
beforeToolCall: ({ toolCall, args }) =>
  runner.emitToolCall({ toolName: toolCall.name, input: args })
```

handler が `{ block: true, reason }` を返すと、s05 はローカルツールを dispatch せず、代わりに `isError: true` の構造化された tool result を生成します。provider は次のターンでそれを読めます。2 つの節のインターフェースが 1 行でつながるのは、それぞれの章で同じ Pi のセマンティクス（`agent-loop.ts` の hook プロトコル）に沿って実装してきたからです。

### グルー③：session はなぜ tagged JSON を保存するのか

s07 の教材用 contract は message content を文字列に単純化していますが、s03–s05 の assistant / tool-result message は tool call id、引数、エラーフラグ、タイムスタンプも持っています。s13 は s05 の `message_end` イベントを購読し、完全な message を 1 件ずつプレフィックス付きの JSON 文字列にエンコードして即座に s07 へ書き込み、次のターンの provider context を組み立てるときにデコードします。s07 の API を広げる必要はなく、tool call のフィールドも失いません。ツールが実行済みで、その後の provider リクエストが失敗しても、完了済みの assistant と tool-result の記録は append-only な session に残り、監査できます。

user message は普通のテキストのまま保存します。s10 の `MiniRunResult.messages` が投影するのは user とテキストを持つ assistant message だけで、完全な記録は s07 の session tree が正です。

### trust と extension factory

package の extension パスは s12 の resolver が決めますが、project package と `.pi/extensions` はさらに s11 の trust を通ります。`extensionFactories` はメモリ上の path-to-factory マップで、「すでに読み込み済みのモジュール」を表します：

```ts
extensionFactories: {
  "/packages/review/extensions/review.ts": reviewFactory,
}
```

resolver がある extension パスを選んだのに、マップに対応する factory がない場合、初期化は即座にエラーになります。教材実装は TypeScript の動的 import をせず、欠けたモジュールを黙って飛ばすこともしません。trusted な project の `.pi/extensions` は s12 のエントリ発見ルールを再利用します：トップレベルの `.ts`/`.js` がエントリ、サブディレクトリは `index.ts`/`index.js` かサブ manifest に列挙されたエントリだけを認め、隣にある helper module は factory マップに入りません。

## 手を動かす

demo の provider は素のテキストを一言返すだけで、連鎖のツール部分は動いていません。`code.ts` 末尾の `demo()` を書き換えます：

1. provider を s04 のツール呼び出し provider に差し替えます：

   ```ts
   import { createToolLoopProvider } from "../s04_evented_tool_loop/code.ts";
   // ...
   provider: createToolLoopProvider({
     toolName: "read",
     args: { path: "README.md" },
     finalText: "Read the file through the integrated loop.",
   }),
   ```

   `npm run session:s13` を再実行して、`Stored messages` が 2 からいくつになるかを見てください。増えた 1 件ずつは何でしょうか。s07 の視点で説明してみてください（ヒント：assistant の toolCall、tool result、最終回答が、それぞれ tagged JSON としてディスクに落ちます）。

2. `demo()` の最後で、同じ runtime を s10 の外殻に渡します：

   ```ts
   import { runJsonMode } from "../s10_runtime_modes/code.ts";
   // ...
   console.log(await runJsonMode(runtime, "hello from the json shell"));
   ```

   2 回の prompt のあとで `runtime.getState().messageCount` を見てください——異なる外殻が駆動しているのは同じ 1 つの session 状態です。s10 の不変条件「mode shell は独立した agent 状態を持たない」が、本物の core の上で動いている姿です。

3. `code.test.ts` の 4 本のエンドツーエンドテストは、そのまま使える 4 つの改造レシピです（package skill の全連鎖、extension によるツールのブロック、trust の拒否、4 つの外殻での runtime 共有）。何か足したくなったら、その fixture を demo に写して改造してください。

書き換えたら `npm run test:s13` を実行して、連鎖が切れていないことを確認します。

## 本線につなぐ

s13 は本線そのものの合流なので、いつもの差分表は部品リストに替わります：

| 部品 | 出どころ | 連鎖の中での位置 |
| --- | --- | --- |
| ツール契約と registry | s02 | baseRegistry + extension ツールの統合 |
| provider のイベントストリーム | s03 | adapter で包んで s05 が消費 |
| ツールループとイベント順序 | s04/s05 | `runHookedToolLoop()` をそのまま実行 |
| turn state のスナップショット | s06/s09 | `prompt()` のたびに再構築 |
| session tree | s07 | user/assistant/toolResult を追記し、次ターンのブランチを供給 |
| リソースの読み込み | s08 | AGENTS.md/skill/template が system prompt に入る |
| extension runtime | s09 | hook・ツール・custom message をこのターンに接続 |
| runtime modes | s10 | 4 つの外殻が同じ runtime を消費 |
| trust | s11 | project の入力と extension を読み込むかを決定 |
| package resolver | s12 | リソースと extension のパスを算出 |

## Pi ソースと照合

ソースの対応関係は [pi-source.md](pi-source.md) にあります。まず `agent-harness.ts` が turn state を構築し、hook をつなぎ、message を保存する流れを見て、次に coding-agent の `resource-loader.ts`、`agent-session.ts`、extension runner がプロダクト層のオーケストレーションを仕上げる部分を見てください——本物の Pi の「グルー層」は、まさにこの数ファイルです。

この節で実装していないもの：context compaction、token budget、本物の provider、モジュールの動的 import、package install、ターミナル UI、hot reload、sandbox。`files`・provider・tool handler・extension factory はすべてメモリ上の fixture です。

## 結び

13 節の裏にあった選択はすべて「何を選んだか / 何を選ばなかったか / その代償」でできています。最後に 1 枚の表に回収します：

| 観点 | Pi の選択 | 選ばなかった代替 | 代償 |
| --- | --- | --- | --- |
| モデル接続 | 統一 provider プロトコル | 単一 SDK への固定 | モデルごとに adapter を 1 層書き、プロトコル自体の保守も必要 |
| メッセージ構造 | `AgentMessage` と LLM message の分離 | 生の配列をそのまま送る | 変換が 1 層増え、デバッグ時にどの層にいるかを見分ける必要がある |
| 出力インターフェース | イベントストリーム（stream） | 同期で文字列を返す | 呼び出し側は stream を消費する必要があり、`await` 1 行では結果を取れない |
| 会話の保存 | append-only な session tree | 上書き可能な message 配列 | 履歴は不変、ブランチは明示的に管理、ストレージは増える一方 |
| 能力の拡張 | extension / skill / package 優先 | 組み込みの plan mode / sub-agent | コア機能はエコシステム頼みで、新人はまず外層の仕組みを学ぶ必要がある |
| セキュリティ境界 | trust と実行環境の分離 | 組み込み sandbox | 実行 sandbox は自分で用意する。trust は入力の読み込みだけを管理 |
| 能力の配布 | package を配布単位に | core への能力のハードコード | manifest / resolver という工学が 1 層増えるが、配布できるなら見合う |

この表がこの講座の本線です。Pi core は小さく保つ。イベントは明瞭に。拡張は開かれたまま。隔離はプロセス内で解決したふりをしない。ここから先、mini-pi に本物の provider を足すにせよ、ターミナル UI をつなぐにせよ、この講座で触れなかった Pi ソースを読むにせよ、表のどの行からでも掘り下げていけます。
