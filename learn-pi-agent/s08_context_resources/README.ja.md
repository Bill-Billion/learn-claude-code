# s08 · Context Resources

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：Context File、Skill、Prompt Template を Harness へ渡す Coding Agent の Resource Loader と System Prompt Builder です。

```text
filesystem source -> context files + skills + prompt templates
                                  |
                                  +-> system prompt + TurnState resources -> real Harness Turn
```

## 問題：Tool Loop だけでは Project を理解できない

Repository 内で作業するには Tool Loop だけでは足りません。モデルには Project Instruction、必要なときに読める専門 Skill の一覧、再利用できる Prompt Template も必要です。

それらを Agent Loop にハードコードすると Product Policy と実行が混ざります。候補ファイルをすべて毎回の Request へ入れると Context を浪費し、出所も説明しにくくなります。Resource には独立した Loading 境界が必要です。

## 考え方：Context File、Skill、Prompt Template を別々に読み込む

s08 は三つの Resource Type を導入します。

```text
ContextFile     System Prompt に入る Project Instruction
ContextSkill    Skill File から読む Name、Description、Location、Body
PromptTemplate  位置引数を置換できる再利用可能な Prompt Text
```

`ResourceSource` が Text を提供します。レッスンの実際の入口は `createFileSystemResourceSource()` で実ファイルを読みます。`prepareContextResources()` は読み込んだ Resource を s06 Harness の形と動的 System Prompt に変換します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s08
```

1 回の Prompt を直接渡すこともできます。

```bash
npm run s08 -- "read_file で Repository README を確認し、その Project Instruction に従ってください。"
```

CLI は実際の Filesystem から Context File を読み、Turn Snapshot を作り、同じ実 `read_file` Loop を走らせます。モデルの表現と Tool 選択は変わる場合があります。明示的な Skill と Prompt Template Path は API から渡し、既定 CLI 設定とは分けて学びます。

## コードの中身

### 1. 実際の Source から Context File を読む

`createFileSystemResourceSource()` は `readFile(path, "utf8")` を包み、ファイル不存在だけを「なし」と扱います。`loadProjectContextFiles()` は Agent Directory を先に確認し、その後 Filesystem Root から `cwd` までの各 Ancestor を調べます。

各 Directory では、最初に存在する候補が選ばれます。

```text
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

返される `ContextFile` は Path と Content の両方を保持するため、System Prompt は各 Instruction の出所を示せます。

### 2. Skill と Prompt Template を parse する

Skill と Prompt Template の Path は明示的な入力です。`loadSkill()` は小さな Frontmatter を解析し、Description を必須とし、Body と File Path を保持します。`disable-model-invocation: true` の Skill は読み込まれますが、モデルには表示されません。

`loadPromptTemplate()` はファイル名から Name を作り、Body を保持します。`formatPromptTemplateInvocation()` は `$1`、`$2`、`$@`、`$ARGUMENTS` を 1 回だけ展開するので、引数内の Placeholder らしい文字列を再展開しません。

### 3. Snapshot 時に System Prompt を組み立てる

`buildContextSystemPrompt()` は現在の Working Directory を加え、各 Context File を Path 付き `project_instructions` Block で包みます。モデルが参照ファイルを開けるよう、`read` または `read_file` が Active のときだけモデル向け Skill を列挙します。

`prepareContextResources()` は次を返します。

```ts
{
  contextResources, // Product 層向けの完全な読み込み値
  harnessResources, // TurnState 向け Skill / Prompt Template Metadata
  systemPrompt,     // Active Tool Set で解決される Callback
}
```

Resource Loading は Agent Loop の外に保たれますが、最終 Prompt は現在の Turn に依存できます。

### 4. 同じ実 Harness Turn を走らせる

`runContextResourceTurn()` は Resource を準備し、得られた System Prompt と Harness Resource を `runHarnessTurn()` へ渡します。別の Loop は作りません。

実行経路はそのままです。

```text
filesystem Context -> TurnState -> model -> read_file -> Tool Result -> model
```

User、Assistant、Tool Result Message は引き続き s07 Session Tree を通して永続化されます。

## 手を動かす

1. Parent Directory に `AGENTS.md`、Working Directory に `CLAUDE.md` を置き、`contextResources.contextFiles` と System Prompt の順序を確認します。
2. `disable-model-invocation: true` を持つ Skill File を渡し、次にその Flag を外します。読み込まれた Skill List と `available_skills` Block を比較します。
3. `Fix $1 with focus on $@` を含む Prompt Template を読み、二つの引数で `formatPromptTemplateInvocation()` を呼びます。

## 本線につなぐ

| 境界 | s07 | s08 |
| --- | --- | --- |
| Session Context | Active `AgentMessage[]` | 同じ Active History |
| Project Instruction | なし | Filesystem-backed Context File |
| 専門 Guidance | なし | 必要時に示す明示的 Skill File |
| 再利用 Prompt | なし | 1 回だけ置換する Prompt Template |
| System Prompt | 一般形または Caller 指定 | `cwd`、Active Tool、Context File、Skill から構築 |
| 実行経路 | Session Tree と `runHarnessTurn()` | Prepared Resource を持つ同じ経路 |

## Pi ソースと照合

Context File の順序、Path 付き System Prompt Section、Skill の可視性、Prompt Template の置換は Pi 0.79.1 に対応します。レッスンは明示的な Skill / Prompt Path を使い、Pi の Package Resolution、Diagnostic、Trust、Reload 機構は再構築しません。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s09 · Extension Runtime](../s09_extension_runtime/) では、外部 Factory が Tool、Command、Event を登録し、Extension が出所付き Resource Path を提供できるようにします。
