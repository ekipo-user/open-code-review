# Loop Mechanics (detailed reference)

Read this when executing the OCR Review-to-Approval Loop. It captures the exact
session/round handling, how to read the verdict, the address-pass policy, and the
GitHub comment templates. The `/ocr:review` and `/ocr:address` skills own their own
internals — this file only covers the **orchestration** around them.

---

## 0. Preconditions (resolve once, up front)

```bash
BRANCH="$(git branch --show-current)"
# Refuse to run on the default branch — this skill commits and pushes.
DEFAULT="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ "$BRANCH" = "${DEFAULT:-main}" ] && { echo "Refusing to run on the default branch."; exit 1; }

# Resolve the PR (arg wins; else the open PR for this branch).
PR="${ARG_PR:-$(gh pr view --json number -q .number 2>/dev/null)}"   # needs gh unless --no-post
```

- If posting is requested but no PR exists, ask the user whether to `gh pr create` first, or
  fall back to `--no-post` (local-only).
- Confirm OCR is set up (`.ocr/` present, `ocr` CLI on PATH). `/ocr:doctor` if unsure.
- Resolve the team: default is `ocr team resolve --json`; with `--team`, forward the spec
  verbatim to `/ocr:review` (it calls `ocr team resolve --team "<spec>" --json`).

---

## 1. Per-round mechanics

### a. Review

Invoke `/ocr:review` (pass `--team <spec>` only if the user supplied one). It runs the full
8-phase pipeline and finalizes the round, writing:

- `.ocr/sessions/{YYYY-MM-DD}-{branch}/rounds/round-{n}/final.md`
- `.ocr/sessions/{YYYY-MM-DD}-{branch}/rounds/round-{n}/round-meta.json`  (verdict + counts)

**Round/session handling across iterations** — every loop iteration is a **new round in the
same session**:

- Round 1 creates the session (`ocr state begin`) and walks `context → … → synthesis →
  complete-round → finish`.
- After a round finalizes, `/ocr:review`'s Phase 8 calls `ocr state finish` (session
  `closed`). For the next round, `ocr state begin` again on the **same** `--session-id`
  starts `round-{n+1}` and resets the phase to `context`; then **advance the phase graph one
  step at a time** (`context → change-context → analysis → reviews …`) — the CLI rejects
  illegal jumps. Reuse the existing `discovered-standards.md` and `context.md`; only the
  `rounds/round-{n+1}/` artifacts are new.
- Regenerate the diff each round (the branch has new commits from the prior address pass).

### b. Read the verdict (the loop gate)

```bash
META=".ocr/sessions/{id}/rounds/round-{n}/round-meta.json"
VERDICT="$(jq -r .verdict "$META")"   # "APPROVE" | "REQUEST CHANGES" | "NEEDS DISCUSSION"
```

The verdict is the **merge gate** and the loop condition:

| Verdict | Blockers | Loop action |
|---|---|---|
| `APPROVE` | 0 | **Exit loop** → final suggestions pass |
| `REQUEST CHANGES` | ≥1 | **Address**, then re-review |
| `NEEDS DISCUSSION` | n/a | **Stop & ask the user** (human gate — don't auto-resolve) |

### c. Address (only on `REQUEST CHANGES`)

Invoke `/ocr:address` on `rounds/round-{n}/final.md`. Its own guardrails apply
(`.ocr/commands/address.md`): corroborate every item against the actual code, implement valid
findings, decline incorrect ones with evidence, propose a better fix when the suggested one is
suboptimal.

**Loop-specific address policy:**
- **Always** address **blockers** and **should-fixes** this round — they're what clears the
  gate to APPROVE.
- You **may defer pure suggestions** to the final pass (keeps each round focused on the gate).
  This is a judgment call; addressing a cheap suggestion inline is fine too.
- **Verify before committing:** run the project's typecheck + lint + tests (e.g.
  `pnpm nx run-many -t typecheck lint`, the relevant `nx test`/`nx e2e`). Fix until green.
- **Commit** atomically with conventional messages (see the repo's `/atomic-commits` style),
  then **push**. End commit bodies with the repo's required `Co-Authored-By` trailer.

---

## 2. Verification expectations

Never push red. For this repo specifically, the relevant gates per change are typically:
`nx typecheck`, `nx lint`, plus the affected `nx test <project>` / `nx e2e <project>` (rebuild
the CLI with `nx build cli` before running `*-e2e` if CLI source changed). Mirror whatever the
underlying address pass touched.

---

## 3. Final suggestions pass (after APPROVE)

Once a round returns `APPROVE`, run `/ocr:address` **one more time** against the approving
round's `final.md` to clear remaining **suggestions** (the items deferred during the loop).
Verify, commit, push. Then post the final comment with the loop-summary table (template below).

Skip this pass if `--no-final-suggestions` was given.

---

## 4. GitHub comment templates

Post with `gh pr comment <PR> --body-file <file>`. Write bodies to a temp file rather than
inline `-m` to avoid shell-escaping issues with backticks/`$()`.

### Review comment (each round)

````markdown
🤖 **OCR multi-agent review — Round {n}** ({team summary, e.g. principal×2, quality×2}, independent parallel sub-agents)

{paste the round's final.md verbatim}
````

### Address comment (each round)

````markdown
## 🔧 OCR Address — Round {n} response (commit {sha})

Addressed the round-{n} review. Each point corroborated against the code before acting.

### Blockers — fixed ✅
{per blocker: what was wrong, the fix, the verification}

### Should-fix — {fixed/partially} ✅
{per item}

### Declined / Deferred
{declined items with evidence; suggestions deferred to the final pass}

### Verification
{typecheck/lint/test results}
````

### Final comment (after APPROVE)

````markdown
## 🔧 OCR Address — Final pass (commit {sha})

Cleared the remaining suggestions from the approving review (comments/tests only — no behavior change):
{list}

Left as-is by reviewer consensus: {items the reviewers explicitly said to leave}

**Verification:** {results}

---

### 🔁 Loop summary

| Round | Verdict | Outcome |
|-------|---------|---------|
| 1 | **REQUEST CHANGES** (… blockers) | {one-line} |
| — | address | {one-line} |
| 2 | **✅ APPROVE** | {one-line} |
| — | final address | {one-line} |
````

---

## 5. Stop conditions & edge cases

- **Approved on round 1** → skip the loop body; go straight to the final suggestions pass.
- **`max-rounds` reached without APPROVE** → stop, post/print the outstanding blockers, and
  hand back to the user. Do not loop indefinitely.
- **`NEEDS DISCUSSION`** → stop; present the review's Clarifying Questions and await the user.
- **A blocker that can't be auto-fixed** (needs a product/architecture decision) → stop and
  say so; do not force an APPROVE by mis-categorizing it.
- **`--no-post`** → run the whole loop locally and present the review/address trail (and the
  summary table) in-chat instead of on the PR.
- **Convergence sanity** → if a re-review reintroduces the *same* blocker the prior address
  claimed to fix, treat the fix as unverified: re-open it, don't just loop.
