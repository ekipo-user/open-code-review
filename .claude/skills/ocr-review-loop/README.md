# OCR Review-to-Approval Loop

A project skill that drives a pull request to an **approved** OCR review automatically.

## What it does

Loops OCR's multi-agent review and address steps:

```
/ocr:review  →  post review to PR  →  verdict?
                                        ├─ APPROVE          → final /ocr:address (suggestions) → done
                                        ├─ NEEDS DISCUSSION → stop, ask the human
                                        └─ REQUEST CHANGES  → /ocr:address (fix + verify + commit + push)
                                                              → post address comment → re-review
```

Every review and every address round is posted to the GitHub PR, so the whole iteration is an
auditable trail. It is an orchestrator only — the actual review and fixing are done by the
existing [`/ocr:review`](../../../.ocr/commands/review.md) and
[`/ocr:address`](../../../.ocr/commands/address.md) skills.

## Usage

```
/ocr-review-loop                       # current branch's PR, default team, max 5 rounds
/ocr-review-loop 54                    # target PR #54
/ocr-review-loop --team principal:2,security:1
/ocr-review-loop --max-rounds 3 --no-final-suggestions
/ocr-review-loop --no-post             # run locally, present the trail in-chat
```

## Requirements

- A feature branch (not the default branch) with an open GitHub PR.
- `gh` CLI authenticated (unless `--no-post`).
- OCR set up in the repo (`/ocr:doctor` to check).

## Files

- `SKILL.md` — the orchestration loop, arguments, and guardrails (loaded when the skill runs).
- `reference/loop-mechanics.md` — per-round CLI/session details, verdict gating, and the
  GitHub comment templates (loaded on demand).

## Design notes

- **Bounded** by `--max-rounds` (default 5) — it never loops forever.
- **`NEEDS DISCUSSION` is a human gate** — the loop pauses for a decision rather than
  fabricating a fix.
- **Corroborate, don't obey** — feedback is verified against the code before it is acted on;
  wrong findings are declined with evidence.
- **Never pushes red** — typecheck + lint + tests run before every commit.
