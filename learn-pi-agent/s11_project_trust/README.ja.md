# s11 · Project Trust

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：Agent Session の開始前に、Project-local な設定、Resource、Package、Extension の読み込みを制御する Gate です。

```text
project files
  -> detect trust inputs
  -> resolve one project-trusted decision
       +-> first Context candidate in each directory - outside trust gate
       +-> project settings / skills / extensions --- trusted only
       +-> project prompts / packages --------------- trusted only
  -> configure the same MiniCoreRuntime
```

## 問題：Runtime の開始前に、どの Project File を受け入れるか

s10 では複数の Shell が一つの Agent Runtime を共有しました。どの Shell を開始する場合でも、Harness は先に、Working Tree のどの File が Runtime を変更してよいか決める必要があります。

Project には設定、実行可能な Extension、Prompt Template、Skill、Package 宣言が置かれます。すべてを暗黙に読み込むと、新しく開いただけの Repository が Agent の振る舞いを変えられます。一方、すべての Project File を拒否するのも正しくありません。`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` は Context Candidate であり、Pi は Trust Decision とは別に扱います。同じ Directory では、この順序で最初に存在する File を一つ選びます。

必要なのは狭く明確な境界です。Project Trust が決めるのは Project-local Input を読み込めるかどうかだけで、開始後に Tool が何をできるかではありません。

## 考え方：検出、決定、読み込みを分ける

s11 は混同しやすい三つの問いを分離します。

| 問い | レッスンの仕組み |
| --- | --- |
| Trust が必要な Input はあるか | `hasProjectTrustInputs()` |
| 現在の Project は Trusted か | `resolveProjectTrusted()` と `MiniTrustStore` |
| どの Input を Runtime に渡すか | `loadProjectInputs()` と `createProjectTrustRuntime()` |

このレッスンでは、現在の Directory にある `.pi/` Tree、または現在の Directory かその Ancestor にある `.agents/skills/` が Trust Resolution を発生させます。四つの Context Candidate は発生条件ではありません。

Decision 後の読み込み規則は明示的です。

| Input | Untrusted | Trusted |
| --- | --- | --- |
| 各 Ancestor Directory で最初に一致する Context Candidate | 読み込む | 読み込む |
| 現在の `.pi/settings.json` | Skip | 公開 |
| Ancestor の `.agents/skills/**/SKILL.md` | Skip | 公開 |
| 現在の `.pi/extensions/**` | Skip | 公開 |
| 現在の `.pi/prompts/**/*.md` | Skip | 公開 |
| 現在の `.pi/packages/**` | Skip | 公開 |

ここでは意図的に「公開」と書いています。レッスンは Trusted な Skill と Prompt の Path を実際の s10 Runtime へ接続します。Settings、Extension、Package の Path は読み込み Decision を確認できるよう列挙するだけで、設定の解析、Project Extension の実行、Package の Install は行いません。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s11 -- "利用できるプロジェクト指示を要約してください。"
```

Default Policy は `ask` です。この小さな CLI は Pi の Trust Selection UI を実装していないため、Override も Saved Decision もなければ保護対象の Project Input は無効のままです。確実に有効化するには、レッスン用の Switch を使います。

```bash
PI_PROJECT_TRUST=always npm run s11 -- "利用できるプロジェクト Skill と Prompt Template を列挙してください。"
```

Prompt はこれまでのレッスンと同じ、実 Model、Session Tree、Context Resource Loader、Extension Turn、`read_file` Tool を通ります。Trust が変えるのは、その Runtime に渡す Project Input だけです。

## コードの中身

### 1. Trust Decision が必要な Input だけを検出する

`hasProjectTrustInputs()` は現在の `.pi/` Tree を確認し、続いて現在の Directory から File System Root まで `.agents/skills/` を探します。Context File はこの検出に含めません。

CLI の `discoverProjectTrustFiles()` は実 File System に対して Discovery を行います。戻り値は Public な Trust Function へそのまま渡せるため、Host は Runtime を構築する前に同じ Ancestor 探索と読み込み規則を確認できます。

### 2. 固定した優先順位で一つの Decision を得る

`resolveProjectTrusted()` は次の順序で判定します。

```text
explicit override
  -> no trust inputs: trusted
  -> Extension decision, optionally remembered
  -> nearest saved decision for cwd or an ancestor
  -> default policy: always / never / ask
  -> ask without UI: untrusted
  -> interactive prompt decision
```

`MiniTrustStore.get()` は Parent Path へ上がるため、最も近い Saved Decision が適用されます。Pi が `~/.pi/agent/trust.json` へ永続化するのに対し、レッスンの Store は Memory 内だけにあり、Process とともに消えます。

### 3. Context を Gate の外に保つ

`loadProjectInputs()` は Trust に関係なく、File System Root から Working Directory へ進みます。各 Directory では `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` の順に最初に存在する File を選び、s08 の Precedence と一致させます。Trust が false なら保護対象の Collection はすべて空です。true なら、レッスンが許可する Settings、Skill、Extension、Prompt、Package の Path を返します。

これは読み込み境界であり、Context が安全だという意味ではありません。Repository 自体が Untrusted なら、Project Instruction も Untrusted な Text として確認する必要があります。

### 4. 同じ実 Runtime を構成する

`createProjectTrustRuntime()` は Trust Decision を準備してから、Trusted な Skill と Prompt の Path を `MiniCoreRuntime` に追加します。Runtime を置き換えず、別の Agent Core も作りません。

既存の Context Resource Source が、引き続き同じ Per-directory Context Candidate Precedence を適用します。結果は一つの累積 Session のままで、利用可能な Resource だけが Gate によって変わります。

## 手を動かす

1. `.pi/` Tree がなく、どの Ancestor にも `.agents/skills/` がない実 Project Directory を作ります。Path を `discoverProjectTrustFiles()` に渡し、戻った File Map を `prepareProjectTrust()` に渡します。保護対象がないため `projectTrusted` は true になります。
2. その Directory に `AGENTS.md` と `CLAUDE.md` を両方追加し、再度 Discovery します。`projectInputs.contextFiles` には `AGENTS.md` だけが現れ、Context Candidate は Trust Decision を変えません。
3. `.pi/settings.json` を追加し、`defaultProjectTrust: "never"` と `"always"` で `prepareProjectTrust()` を比較します。`projectSettingsLoaded` は false から true に変わります。コースの Working Directory では、`PI_PROJECT_TRUST=never npm run s11 -- "..."` と `PI_PROJECT_TRUST=always npm run s11 -- "..."` が同じ二つの Policy Branch を選びます。
4. Project または Ancestor に `.agents/skills/review/SKILL.md`、Project に `.pi/prompts/review.md` を置きます。両方の Policy で `createProjectTrustRuntime()` を構築し、`projectInputs` を比べます。両方の Runtime へ同じ Prompt を送ると、Trusted Runtime だけが Skill Instruction と選択された Prompt Template Resource を受け取ります。
5. `MiniTrustStore` で実際の Parent Path に `true`、Child Path に `false` を保存し、Child Project を準備します。最も近い Saved Decision が優先され、選択された Context File は Gate の外に残ります。

## 本線につなぐ

| 境界 | s10 | s11 |
| --- | --- | --- |
| Runtime | 一つの累積 `MiniCoreRuntime` | 同じ Runtime |
| Session | すべての Shell が共有 | 引き続き共有 |
| Context | Directory ごとに最初の Candidate を選ぶ | 常に Trust Gate の外 |
| Project Skill と Prompt | Caller が Path を渡す | Trusted のときだけ追加 |
| Settings、Extension、Package | s10 の範囲外 | 発見して Gate に通すが、このレッスンでは有効化しない |
| Decision State | なし | Override、Extension Decision、最も近い Saved Decision、または Default |

## Pi ソースと照合

Pi 0.79.1 も同じ境界を使います。現在の `.pi/` と、現在または Ancestor の `.agents/skills/` が Trust Resolution を発生させ、各 Directory で最初に一致する `AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD` Context Candidate は独立して読み込まれます。保護対象の Project 設定、Resource、Package、Extension は承認後にだけ読み込まれます。Pi は Decision を永続化し、このレッスンが省略する実際の Resource Reload、Package Resolution、Extension Loading を行います。

Project Trust は Permission System でも Sandbox でもありません。Pi の Tool と Extension は Pi Process と同じ権限で動きます。コースの `read_file` Tool にある Working Directory Check は教育用 Tool Policy であり、Pi の Security Boundary でも Project Trust の効果でもありません。強い分離には、外部 Container、VM、micro-VM、Remote Sandbox、または OS Policy が必要です。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s12 · Pi Package](../s12_pi_package/) では、Trust 後の保護対象の一つを追います。Package を、Runtime がすでに理解する Resource Type へどう解決するかを扱います。
