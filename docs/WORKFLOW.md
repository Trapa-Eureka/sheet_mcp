# WORKFLOW — the AI-native rules that run this repo

Source: Clare Liguori (AWS), "From AI-Assisted to AI-Native: Building a Frontier Development Team"
(https://youtu.be/Ry0WHNxDbYA · the same research's AWS blog: https://aws.amazon.com/blogs/machine-learning/how-frontier-teams-are-reinventing-ai-native-development/)
This translates the "frontier team" habits derived from long-term observation of general teams inside Amazon into terms for this one-person project.

## 0. The 3 frontier-developer behaviors → my role definition

| Behavior (video 1:34~)                                 | In this repo                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Hands-off Coding — direct coding 1-2%                  | Jin only writes/revises SPEC/DESIGN, reviews, and approves live sending. The agent implements                   |
| Infrequent Interaction — hours of autonomous execution | Embed executable completion criteria into tasks so they run to completion without intervention during a session |
| Minimized Idle Time — parallel agents                  | From T1 onward, lanes A-D run concurrently as worktrees. The human only works through the review queue          |

## 1. Rules per habit

**Habit 1 — Invest in Agent Context (08:02)**

- Write all tribal knowledge into `CLAUDE.md` and `docs/`. A rule explained only in conversation is not a rule at all.
- **Pruning**: review CLAUDE.md every two weeks, delete stale rules, and leave a dated entry in the Pruning Log. A document growing longer is itself a context cost.

**Habit 2 — Slow Down to Speed Up (10:19)**

- Batch tool setup at T0: strict TS (the cheapest feedback loop for the agent), gate scripts, linting.
- Error messages must convey "what's wrong and why + how to fix it." The agent should be able to self-correct from the error string alone.
- Code structure: small, split files + interface boundaries = an agent-friendly codebase.

**Habit 3 — Feed Agents, Don't Babysit (12:38)**

- No vibe coding (short back-and-forth conversations). Assignment prompts end with the single template in TASKS.md.
- The fuel for autonomy is **a means of self-verification**: write every task's completion criteria so they can be judged mechanically via `npm run check` + the specified tests.
- Parallel execution:
  ```bash
  git worktree add ../sheet_mcp-t4 -b t4 && cd ../sheet_mcp-t4 && claude
  # Do the same for t5, t6 in other terminals — different lanes don't conflict
  ```

**Habit 4 — Make Intent Explicit (13:46)**

- Documentation comes before code. New feature/change = ① diff SPEC or DESIGN → ② add a task based on that diff → ③ agent implements.
- Going back and forth with AI over the design document is cheaper than fixing code changes scattered across the repo. Because of this principle, this repo started with 7 documents and 0 lines of code.

**Habit 5 — Shift Testing Left (14:57)**

- The core technique is local, deterministic mock services: replace both Google Sheets and the email API with mocks to iterate without a live cloud (`docs/TESTING.md`).
- Live-dependent tests are not put in the gate. Real-world verification is done by a human via smoke tests.

## 2. Daily operating routine

1. Morning: check TASKS.md for tasks ready to start → assign an agent per lane's worktree
2. While agents are running: refine or review the next version of SPEC/DESIGN (do not intervene)
3. When a completion report arrives: re-run `npm run check` → review the diff → merge, update task status
4. Every two weeks: prune CLAUDE.md + clean up TASKS.md

## 3. Boundaries of autonomy (what the human holds onto)

- Switching to `SEND_MODE=live` and approving actual sends — always a human.
- Spec change decisions — the agent can only propose; approval of document changes is a human's call.
- Secret management and the scope of service account sharing.
