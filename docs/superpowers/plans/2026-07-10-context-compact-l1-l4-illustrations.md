# Context Compact L1-L4 Illustrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create four vivid, technically accurate V2 SVG illustrations for the L1-L4 context compaction mechanisms and render them for review.

**Architecture:** Each mechanism is a standalone `760 x 440` SVG using one shared visual grammar: a white worktable, physical paper objects, a single green accent, and a clear before/action/after reading direction. Old SVGs remain untouched; V2 files are independently validated and rendered.

**Tech Stack:** Hand-authored SVG 1.1, `xmllint`, macOS Quick Look (`qlmanage`), Codex image inspection.

## Global Constraints

- Use only `#ffffff`, `#fafafa`, `#1a1a1a`, `#888888`, `#d0d0d0`, and `#22c55e`.
- Use `#22c55e` only for retained or recoverable information and directional emphasis.
- Keep text readable without depending on code knowledge.
- Keep corners at 6px or less and use line art rather than decorative fills.
- Do not overwrite old SVGs or insert V2 images into the article yet.
- L3 must retain exactly the latest three results: `#3`, `#4`, and `#5`.

---

### Task 1: L1 Archive The Oversized Result

**Files:**
- Create: `s08_context_compact/images/draft-l1-tool-result-budget-v2.svg`

**Interfaces:**
- Consumes: color and typography constraints from the design spec.
- Produces: one standalone SVG showing a long tool-result paper moved into `.task_outputs/` while a path-and-preview note remains.

- [ ] **Step 1: Draw the complete L1 composition**

Create a left scratch sheet with an overflowing paper roll, a central archive box receiving the roll, and a right scratch sheet containing a compact green-edged retrieval note. Label the three visual beats `过长输出`, `搬到档案盒`, and `路径 + 预览`.

- [ ] **Step 2: Validate the SVG**

Run: `xmllint --noout s08_context_compact/images/draft-l1-tool-result-budget-v2.svg`

Expected: exit code `0` with no output.

---

### Task 2: L2 Cut The Middle Of The Message Ribbon

**Files:**
- Create: `s08_context_compact/images/draft-l2-snip-compact-v2.svg`

**Interfaces:**
- Consumes: the shared paper and stroke language.
- Produces: one standalone SVG showing a long folded history ribbon whose middle is removed and replaced by a snip marker.

- [ ] **Step 1: Draw the complete L2 composition**

Create one continuous accordion ribbon with a dark-edged task head, a green-edged latest-progress tail, and gray old-process folds in the middle. Place scissors at two safe dotted cut lines, keep a paired `tool_use` and `tool_result` tab together, and reconnect the ends with `[snipped 49 messages]`.

- [ ] **Step 2: Validate the SVG**

Run: `xmllint --noout s08_context_compact/images/draft-l2-snip-compact-v2.svg`

Expected: exit code `0` with no output.

---

### Task 3: L3 Erase Only Older Tool Results

**Files:**
- Create: `s08_context_compact/images/draft-l3-micro-compact-v2.svg`

**Interfaces:**
- Consumes: `KEEP_RECENT = 3` from `s08_context_compact/code.py`.
- Produces: one standalone SVG preserving full result sheets `#3`, `#4`, and `#5` while replacing `#1` and `#2` with small placeholders.

- [ ] **Step 1: Draw the complete L3 composition**

Arrange five timestamped result sheets from old to new. Show an eraser and gray crumbs over `#1` and `#2`, but leave their small placeholder slips in the same positions. Bind `#3`, `#4`, and `#5` with a green paper clip and label them `最近 3 条完整保留`.

- [ ] **Step 2: Validate the SVG**

Run: `xmllint --noout s08_context_compact/images/draft-l3-micro-compact-v2.svg`

Expected: exit code `0` with no output.

---

### Task 4: L4 Rewrite The Full History As A Brief

**Files:**
- Create: `s08_context_compact/images/draft-l4-compact-history-v2.svg`

**Interfaces:**
- Consumes: the transcript-first and summary-replacement behavior from `compact_history()`.
- Produces: one standalone SVG showing the complete history archived before a lossy one-page brief replaces the active context.

- [ ] **Step 1: Draw the complete L4 composition**

Draw a thick clipped transcript stack moving into an archive tray, then a narrowing reading-and-highlighting funnel, then a one-page active brief listing `目标`, `约束`, `发现`, `文件`, and `下一步`. Add faint gray discarded detail marks beside the funnel to make the lossy boundary visible.

- [ ] **Step 2: Validate the SVG**

Run: `xmllint --noout s08_context_compact/images/draft-l4-compact-history-v2.svg`

Expected: exit code `0` with no output.

---

### Task 5: Render And Inspect The Set

**Files:**
- Render: `/tmp/draft-l1-tool-result-budget-v2.svg.png`
- Render: `/tmp/draft-l2-snip-compact-v2.svg.png`
- Render: `/tmp/draft-l3-micro-compact-v2.svg.png`
- Render: `/tmp/draft-l4-compact-history-v2.svg.png`

**Interfaces:**
- Consumes: all four validated V2 SVGs.
- Produces: four PNG previews ready for side-by-side user review.

- [ ] **Step 1: Render all V2 SVG files**

Run one `qlmanage -t -s 1200 -o /tmp <svg>` command per SVG.

Expected: four PNG files in `/tmp`, each with non-zero size.

- [ ] **Step 2: Inspect every preview**

Check each PNG for cropped labels, overlapping objects, ambiguous action direction, accidental colors, and L3's exact three-result retention.

- [ ] **Step 3: Run final structural checks**

Run: `rg -o '#[0-9a-fA-F]{6}' s08_context_compact/images/*-v2.svg | sort -u`

Expected: no colors outside the six-value palette in Global Constraints.
