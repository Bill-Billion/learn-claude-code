# s05 · Tool Hooks

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：`pi-agent-core` の Tool Execution 境界を囲む `beforeToolCall` と `afterToolCall` の Policy です。

```text
Tool Call -> before hook -> Handler -> after hook -> Tool Result
```

## 問題：Tool Execution を観察するだけでは足りない

s04 で Tool Execution は観察可能になりましたが、観察だけでは振る舞いを変えられません。製品は操作の拒否、承認済み引数への書き換え、結果の注釈、成功から失敗への変更、次のモデル Turn より前の終了を必要とする場合があります。

すべての規則を各 Handler に書くと Policy が重複します。製品固有の条件を Agent Loop へ直接追加すると、Core を再利用しにくくなります。実行境界には Handler の前後に狭い拡張点が必要です。

## 考え方：二つの任意 Hook で既定の実行を囲む

```text
beforeToolCall
  -> block：Handler を実行せず Error Tool Result を返す
  -> arguments：検証と実行に使う引数を置き換える
  -> その他：続行する

executeDefault

afterToolCall
  -> content または isError を変更する
  -> terminate を要求する
```

Loop は引き続き Message の順序とライフサイクル Event を管理します。Hook は一つの Tool Call に影響できますが、二つ目の Agent Loop にはなりません。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s05
```

次の 1 回だけの依頼は Hook 対応 Loop を通ります。

```bash
npm run s05 -- "read_file で package.json を読み、pi-ai のバージョンを報告してください。"
```

既定の CLI は Policy Hook を設定しないため、このコマンドは新しいインターフェースの基準経路です。回答と Tool Call の詳細は変わる場合があります。次の演習では、同じ `runHookedToolLoop()` 呼び出しへ Hook を加え、Tool Result の変化を観察します。

## コードの中身

### 1. Hook の戻り値を小さく保つ

`beforeToolCall` は次を返せます。

```ts
{
  block?: boolean;
  reason?: string;
  arguments?: Record<string, unknown>;
}
```

`afterToolCall` は次を返せます。

```ts
{
  content?: ToolResultMessage["content"];
  isError?: boolean;
  terminate?: boolean;
}
```

`undefined` は変更なしを意味します。Hook は Registry や Message History を直接変更しません。

### 2. 必要な実行 Context を渡す

両方の Hook は Assistant Message、Tool Call、有効な引数、現在の Message を受け取ります。After Hook は Tool Result とその `isError` 値も受け取ります。Loop のローカル制御変数を公開せずに Policy を判断できる情報です。

### 3. s04 の既定 Executor を囲む

主な入口は一つの Options Object を受け取ります。

```ts
await runHookedToolLoop({
  model,
  prompt,
  registry,
  hooks: { beforeToolCall, afterToolCall },
});
```

内部の `createHookExecutor()` が s04 の `executeToolCall` 関数になります。Before Hook を実行し、引数が置き換えられた場合は Effective Tool Call を作り、実行が許されたときだけ `context.executeDefault(effectiveToolCall)` を呼びます。

### 4. 拒否をモデルから見える形にする

Before Hook が `{ block: true }` を返すと、Handler は呼ばれません。Hook の `reason` が Error `ToolResultMessage` になり、通常のライフサイクルを通して追加され、モデルへ返ります。

拒否された呼び出しでは、完了させる Handler Result がないため、After Hook は実行しません。

### 5. 実行後に結果を完成させる

既定の実行後、`afterToolCall` は `content` の置き換え、`isError` の変更、`terminate: true` の返却を行えます。置き換えた値も通常の Tool Result Message なので、s04 は同じ Tool Execution Event と Message Event を発行します。

`afterToolCall` が例外を投げた時点では、Handler はすでに実行済みです。`applyAfterToolCallHook()` は実行済み Tool Result の Content を保ち、`Post-tool hook failed after the tool executed: ...` を追加し、Result を Error にして Loop を続行します。Handler を再試行したり Side Effect を繰り返したりしません。

一つの Turn に複数の Tool Call がある場合、すべての実行結果が終了を要求したときだけ Loop は早期終了します。混在する Batch は次のモデル Turn へ進みます。

## 手を動かす

1. `runLiveCli()` に `beforeToolCall` Hook を追加し、`args.path === "README.md"` のとき `read_file` を拒否します。そのファイルを依頼し、モデルがファイル内容ではなく Reason を受け取ることを確認してください。
2. モデルが別のパスを要求したとき、`{ arguments: { path: "package.json" } }` を返します。Handler が書き換えたパスを読み、Tool Result が元の Tool Call ID を保つことを確認します。
3. `afterToolCall` Hook を追加し、テキスト内容に `audited:` という接頭辞を付けます。続いて `terminate: true` を返し、通常の後続モデル Turn とライフサイクルを比較してください。

## 本線につなぐ

| 境界 | s04 | s05 |
| --- | --- | --- |
| Loop の入口 | `runEventedToolLoop()` | `runHookedToolLoop({ ... })` |
| 既定の実行 | Registry Runtime | Hook Wrapper 内の `executeDefault()` |
| 実行前 Policy | なし | 拒否または引数置換 |
| 実行後 Policy | なし | 結果変更または終了要求 |
| ライフサイクル | Agent / Turn / Message / Tool | 同じライフサイクルと、完成後の Tool Result |
| モデル接続 | 実プロバイダー経路 | 同じ実プロバイダー経路 |

## Pi ソースと照合

Hook の位置、拒否の振る舞い、結果の完成、Batch の終了規則は Pi 0.79.1 に対応します。このレッスンは実行前の変換を見える形にするため、小さな引数置換フィールドを加えています。Pi の正確な Hook Result Type と、より豊富な Context はソース対応で説明します。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s06 · Harness Turn State](../s06_turn_state/) では Message、Tool、Resource、Model 設定、System Prompt を一つの明示的な Turn Snapshot にまとめます。
