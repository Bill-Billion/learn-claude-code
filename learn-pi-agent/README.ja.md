# Learn Pi Agent

[English](README.md) · [中文](README.zh.md) · 日本語

このリポジトリでは mini Pi をゼロから作ります。Pi の使い方チュートリアルでも、Pi ソースコードの解説でもありません。[Pi](https://github.com/earendil-works/pi) の核となる設計思想に沿って、簡略化しつつも構造の明快な agent harness の MVP を段階的に組み上げていきます。

13 節を読み終えると、provider を差し替えられ、session を分岐でき、context resource をロードでき、extension を登録でき、trust 境界を制御でき、package を解決できる mini agent harness が手元に残ります。s13 では前の 12 節の仕組みを 1 本の実行可能なリクエスト経路につなぎます。決定的でオフラインな教材実装なので、実モデルの呼び出し、extension の動的 import、package のインストール、context compaction、hot reload、実行サンドボックスは含みません。

Pi のアーキテクチャの主線は明快です：

```text
pi-ai           複数 provider にまたがるモデル・メッセージ・tool call のフォーマットを統一する
pi-agent-core   メッセージ状態の上で agent loop を回し、外へイベントを発行する
pi-coding-agent core をターミナル・session・extension・skill・実行モードにつなぐ
```

Pi のプロダクト思想もはっきりしています：カーネルは小さく保ち、ワークフローは外側の拡張に任せる。Pi には sub-agent、plan mode、permission popup、todo システム、MCP のデフォルト統合が組み込まれていません。これらは extension、skill、pi package、コンテナ、外部ツールで後からつなげます。このコースで Pi のソースコードは検証とトレースの参照にだけ使います。

## 想定読者

- **向いている人**：TypeScript が書けて、どこかの LLM API を使ったことがあり、agent システムがゼロからどう組み上がるかを理解したい開発者。
- **前提知識**：async/await と Promise が読めること、messages 配列が何かを知っていること（知らなくても s01 で一通りなぞります）。
- **不要なもの**：Pi を使った経験も、Pi のソースを読んだ経験も、agent フレームワークの知識も要りません。
- **想定時間**：1 節あたり 30–60 分、13 節でおよそ 9–13 時間。
- **難易度カーブ**：s01–s06 はなだらか。s07 が最初の抽象度ジャンプ（木構造）。s10–s13 はエンジニアリング寄りの組み立てで、s12 が最も重いです。

## 始め方

```bash
npm run session:s01
npm run test:s01
```

各節は 1 つのディレクトリです：

```text
s01_agent_loop/
  README.md        この節の進め方（英語。README.zh.md が中国語、README.ja.md が日本語）
  code.ts          最小実装
  code.test.ts     挙動テスト（コースに手を入れる人のために設計上の不変条件を守る回帰ネット）
  pi-source.md     Pi ソースコードでの検証とトレース（英語。pi-source.zh.md が中国語）
```

各節の構成は固定です：問題 → 考え方 → まず動かす → コードの中身 → 手を動かす → 本線につなぐ → Pi ソースと照合 → 次の節。「まず動かす」の出力はすべて実測したもので、「手を動かす」はテスト実行ではなく、実際にコードを書き換える演習です。

## ロードマップ

この 13 節は独立した 13 個のデモではなく、同じ mini-pi に対する 13 回のイテレーションです。後の節は前の節の export を直接 import します。コースは Pi の 4 層アーキテクチャと統合の 1 節に沿って進みます：

### A. プロトコル層（s01–s03）—— Pi はモデルとどう話すか

```text
s01: Agent Loop
     messages + provider + stopReason。pi-agent-core の最小の状態フローに対応

s02: Tool Schema
     model-visible schema + local handler。pi-ai と coding-agent のツール契約に対応

s03: Provider Events
     start / text_delta / toolcall_delta / done。pi-ai のストリーミングイベントプロトコルに対応
```

### B. Core 層（s04–s06）—— agent-core はどうやってターンを回し続けるか

```text
s04: Evented Tool Loop
     toolCall -> tool execution events -> toolResult -> next turn

s05: Tool Hooks
     beforeToolCall / afterToolCall / terminate

s06: Harness Turn State
     session.buildContext() + active tools + resources + systemPrompt
```

### C. Coding-agent 層（s07–s09）—— ターミナル製品はどう育つか

```text
s07: Session Tree
     JSONL entry + id/parentId + branch navigation

s08: Context Resources
     AGENTS.md・skills・prompt templates・active tools がどうやって 1 回のリクエストに入るか

s09: Extension Runtime
     on(event)、registerTool、registerCommand、custom message
```

### D. シェル層（s10–s12）—— 同じ core を別々の動かし方につなぐ

```text
s10: Runtime Modes
     同じ runtime を interactive、print/json、rpc、sdk の外殻につなぐ

s11: Trust And Execution Env
     project trust が入力のロードを制御し、execution env が読み書きと shell の境界を制御する

s12: Pi Package
     manifest、規約ディレクトリ、filter、scope でリソースをパッケージ化して共有する
```

### E. 統合層（s13）—— ここまでの仕組みを 1 本の経路として走らせる

```text
s13: Integrated Harness
     trust -> package/resources/extensions -> turn state -> hooked tool loop -> session -> runtime modes
```

s13 がやるのはアダプテーションとオーケストレーションだけです。tool loop は引き続き s05 が実行し、session の保存は s07 のまま、resource・extension・trust・package・mode はそれぞれ s08–s12 の公開インターフェースを再利用します。コース全体の設計トレードオフのまとめ表は s13 の末尾にあります。

## 固定ソース参照

- [`earendil-works/pi`](https://github.com/earendil-works/pi/tree/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/)：固定 revision の Pi 上流ソース（0.79.1、commit 2f5066d7）。検証とトレース用
- [`shareAI-lab/claw0`](https://github.com/shareAI-lab/claw0/tree/0090e863bd90aaebc79d244223cc2acc7c284eaf/)：コース構成とゼロから積み上げる展開の参考

書き方は `learn-claude-code` の教え方（問題を先に置く、最小実装、ソーストレースの層分け）を参考にしていますが、内容の主軸はあくまで Pi 自身の設計トレードオフです。
