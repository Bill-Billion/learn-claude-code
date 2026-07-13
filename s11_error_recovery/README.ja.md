# s11: Error Recovery — エラーは終わりではなく、リトライの始まり

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s09 → s10 → `s11` → [s12](../s12_task_system/) → s13 → ... → s20
> *"エラーは終点ではなく、回復の開始点"* — token 上限を上げ、context を圧縮し、model を切り替える。
>
> **Harness レイヤー**: resilience — main loop がエラーを分類し、回復する。

---

最初の十章のコードには共通の仮定がある。API 呼び出しは毎回成功する。次の一行で崩れる。

```
Error: 529 overloaded
```

Agent はその場で crash する。retry も fallback もなく、20 分間の作業が消える。本番環境では 429 rate limit、529 overload、network の揺れは例外ではなく日常で、一日に何度か遭っても不思議ではない。

![Error Recovery Overview](images/error-recovery-overview.svg)

---

## 万能 retry を一つ置くだけでは、なぜ駄目なのか

最初に思いつくのは `try/except` で包み、失敗したら繰り返すことだ。

```python
while True:
    try:
        response = client.messages.create(...)
        break
    except Exception:
        time.sleep(1)   # もう一度なら成功する？
```

三つの悪い結果がすぐ見える。`prompt_too_long` は一万回 retry しても変わらない。瞬間的な故障ではなく、request 自体が大きすぎるからだ。固定間隔 retry は 429 を悪化させる。すべての client が同じ秒に失敗し、同じ秒に戻り、server が回復する前にもう一度踏みつける。最も危険なのは本当の bug も隠すことだ。コード内の `TypeError` まで無限 retry され、直すべきエラーが見えない。

原則を先に置く。**回復動作はエラーの性質に合わせる。** 教学版は四分類に分ける。回答の切断、request の肥大、待てば直る一時故障、回復不能なその他だ。

---

## 経路 1：出力が切れたら、空間を増やしてから続きを書かせる

モデルが回答途中で token を使い切ると、`stop_reason` は `"max_tokens"` になる。回復は二段階だ。

```python
if response.stop_reason == "max_tokens":
    # 第 1 段階：64K へ上げて同じ request を再送。切れた出力は messages に入れない
    if not state.has_escalated:
        max_tokens = ESCALATED_MAX_TOKENS      # 8000 -> 64000
        state.has_escalated = True
        continue
    # 第 2 段階：64K でも不足なら断片を保存し、最大 3 回続きを書かせる
    messages.append({"role": "assistant", "content": response.content})
    if state.recovery_count < MAX_RECOVERY_RETRIES:
        messages.append({"role": "user", "content": CONTINUATION_PROMPT})
        state.recovery_count += 1
        continue
    return
# 正常終了した応答だけをここで追加
messages.append({"role": "assistant", "content": response.content})
```

第 1 段階には逆にしやすい細部がある。上限を上げて retry するとき、切れた出力は **`messages` に入れない**。8K から 64K へ増やし、同じ clean な request を再送すれば、多くは一回で完了する。先に不完全な出力を保存すれば、履歴には半端な下書きと再送後の完全版が重複して残る。

第 2 段階で初めて連結する。断片を保存し、「そのまま続け、謝らず、繰り返さない」という prompt を追加し、切断点から再開させる。上限は三回。それ以上必要ならタスク自体を分割すべきで、継続では解決しない。

確認順も重要だ。`max_tokens` は応答を追加する **前** に判断する。この順序を逆にすると、第 1 段階の「追加しない」を実現できない。

---

## 経路 2：request が大きすぎたら、一度だけ細くする

API の `prompt_too_long` は、context が hard limit を超えたという意味だ。治療は retry ではなく圧縮になる。

```python
except Exception as e:
    if is_prompt_too_long_error(e):
        if not state.has_attempted_reactive_compact:
            messages[:] = reactive_compact(messages)   # 最後の 5 件と一文だけ残す
            state.has_attempted_reactive_compact = True
            continue
        # 一度細くしても超えるなら終了。繰り返しても小さくならない
        ...
        return
```

教学上の単純化として、この `reactive_compact` は先頭を切り、最後の 5 メッセージを残すだけで、モデルによる要約は作らない。LLM を使う緊急要約は s08 で扱ったため、ここでは回復 framework に集中する。

一度だけ試す理由も s08 と同じだ。切り詰めても超えるなら、残った一件が極端に大きい可能性が高い。圧縮を繰り返しても「圧縮して超え、超えてまた圧縮」という無限 loop になる。

---

## 経路 3：一時故障には正しく backoff する

本当に retry すべきなのは 429 と 529 だが、二つの要素が必要になる。指数 backoff と jitter だ。

```python
def retry_delay(attempt, retry_after=None):
    if retry_after:                                   # server 指定の待ち時間を優先
        return retry_after
    base = min(BASE_DELAY_MS * (2 ** attempt), 32000) / 1000   # 0.5s, 1s, 2s ... 最大 32s
    jitter = random.uniform(0, base * 0.25)           # 0-25% の random jitter
    return base + jitter
```

指数的な増加は server への礼儀だ。すでに過負荷なので、retry 間隔を倍々に伸ばして回復時間を与える。jitter は他 client への礼儀だ。何千もの client が同じミリ秒に失敗し、正確な間隔で一斉に戻れば、次の波も同じ高さになる。少しずつ random にずらせば峰を平らにできる。

529 にはもう一段の escalation がある。三回連続 overload なら現在の model は短期的に期待できないため、`FALLBACK_MODEL_ID` が設定されていれば fallback へ切り替える。なければ backoff を続ける。

```python
if state.consecutive_529 >= MAX_CONSECUTIVE_529:
    if FALLBACK_MODEL:
        state.current_model = FALLBACK_MODEL
        state.consecutive_529 = 0
```

成功すれば counter は必ず zero に戻り、散発的な 529 は蓄積しない。全体の retry は十回で終わり、`Max retries exceeded` を投げる。無限には待たない。

---

## その他：回復させず、記録して終了する

三分類に入らないエラー、認証失敗、無効な引数、本当のコード bug に対する正しい処理は一つだけだ。回復しようとしない。

```python
messages.append({"role": "assistant", "content": [
    {"type": "text", "text": f"[Error] {name}: {str(e)[:200]}"}]})
return
```

ただし終了前にエラーを会話へ記録する。黙って crash するのが最悪で、戻ったユーザーには Agent が消えた理由がわからない。`messages` に残せばユーザーに見え、次のターンのモデルにも見える。

三つの仕組みが別の層を受け持ち、越境しない。最内層の `with_retry` は一時エラーを吸収し、外側の `except` は context overflow と回復不能エラーを受け、`stop_reason` が切断を処理する。分類が明確なら各経路は一目で読めるほど短い。

> 実際の Claude Code は各呼び出し後に十数種類の reason/transition を判断し、stream abort、画像エラー、hook block、token budget continuation などに専用経路を持つ。fallback model へ切り替えると pending message を空にし、「高負荷のため切替」とユーザーへ伝える。継続には収益逓減検出もあり、三回連続の追加が 500 token 未満なら、続けても無益と判断して停止する。

---

## s10 からの変更

| コンポーネント | 変更前 (s10) | 変更後 (s11) |
|----------------|--------------|--------------|
| エラー処理 | なし、どのエラーでも crash | 四分類の回復 + 指数 backoff |
| 新しい定数 | — | `ESCALATED_MAX_TOKENS=64000`, `MAX_RETRIES=10`, `BASE_DELAY_MS=500`, `MAX_CONSECUTIVE_529=3` |
| 新しい関数 | — | `with_retry`, `retry_delay`, `reactive_compact`, `is_prompt_too_long_error`, `RecoveryState` |
| ツール | bash, read_file, write_file (3) | 変更なし |
| ループ | LLM を直接呼ぶ | `try/except` と `continue` の retry 経路 |

---

## 試してみる

```sh
cd learn-claude-code
python s11_error_recovery/code.py
```

1. **切断経路（確率的だが再現しやすい）：** `Write a single Python file implementing a complete tic-tac-toe game with an AI opponent, full docstrings and type hints, at least 500 lines`。出力が 8K token を超えると `[max_tokens] escalating 8000 -> 64000` が出る。
2. **回復不能経路（確実に再現）：** `.env` の `MODEL_ID` を `claude-nonexistent` のような存在しない名前にし、何か質問する。`[unrecoverable]` log と、会話に残る `[Error] NotFoundError: ...` を確認する。終了後は model 名を戻す。
3. **一時経路（任意には作れない）：** 実際の 429/529 に遭うと `[429 rate limit] retry 1/10, wait 0.5s` のような log が出て、間隔は倍になる。この label を知っていれば、本番で停止ではなく自己回復中だとすぐわかる。

---

## 次へ

Agent は失敗に強くなったが、タスクはまだ一回限りだ。仕事を受け、終え、終了する。A の後に B という依存関係、process restart 後の永続化、複数 worker による同じ task pool の claim は、s05 の memory 上 TODO には表現できない。

s12 Task System → task は依存、状態、永続化を持つ graph になる。multi-Agent 協調の土台だ。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
