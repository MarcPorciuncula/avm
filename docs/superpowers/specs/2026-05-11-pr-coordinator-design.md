# PR Coordinator — Design Spec

Date: 2026-05-11

## Problem

A common host-side workflow today is babysitting open pull requests
that are ready for review:

1. Open the PR list.
2. For each PR with the base branch ahead of HEAD, start Claude in the
   relevant worktree and invoke the `update-branch` skill to rebase
   and force-push.
3. Repeat as new commits land on `main` or as automated reviewers
   (Copilot, Cursor bugbot) post comments that need addressing.

The work itself is well-defined — the skills already encapsulate it.
The tedium is the scheduling: noticing a PR needs attention, opening a
worktree, starting an agent, invoking a skill. That's a job for the
machine.

avm has the primitives needed to own this: a long-running daemon, a
container lifecycle CLI, an in-container bridge that can phone home,
and authenticated credential mounts. This spec proposes a "PR
coordinator" subsystem of the daemon that polls GitHub, dispatches
ephemeral avm containers running `claude` headless against well-defined
skills, and tracks state durably across daemon restarts.

## Goals (v1)

- Provide a coordinator framework that polls GitHub, dispatches
  ephemeral avm containers to perform user-defined tasks against
  opt-in PRs, and tracks state durably across daemon restarts.
- Make task types user-configurable: each declares its hotword,
  trigger predicate, and prompt (inline or a file path under
  `~/.avm/`). The framework is task-agnostic; no task is hardcoded.
- Ship one example task type — `update-branch` with hotword
  `/avm update` — as the v1 reference and the only validated task.
- Enforce a strict trust boundary: the in-container agent only
  mutates the working tree; the coordinator owns every destructive
  remote operation (backup pushes, branch promotion, ref deletion,
  comment posting). Pushes are gated on lock + PR-state re-checks
  and use `--force-with-lease` against the recorded pre-rebase SHA.
- Opt-in is per-PR via the configured hotword in a PR comment,
  requiring no repo configuration and invisible to other contributors.
- Coordinator state lives in two places: a per-PR "control comment"
  (durable, GitHub-side) and a host-side SQLite database (cache and
  scheduling).
- Marking a PR draft pauses coordination and cancels any in-flight
  task; marking it ready resumes and re-evaluates dispatch.
- A per-branch lock prevents concurrent tasks racing on the same
  branch.
- Before any history-rewriting operation, push a backup branch to
  origin and record it so manual recovery is possible.
- Classify task failures with built-in patterns so a single expired
  Claude credential trips a circuit breaker rather than burning the
  whole retry budget.

## Non-goals (v1)

- `/avm address` (review-comment automation). Designed-for but not
  implemented in v1.
- Webhook-based ingestion. Polling only.
- Stack-aware locking beyond what the `update-branch` skill already
  handles internally.
- Automated merge after green CI.
- Multi-user / shared coordinator. Single-user, single-host only.
- A restore-from-backup CLI. Backups exist for manual recovery only.
- Warm container pooling. One ephemeral container per task.

## Background — what exists

The orchestrator builds on existing avm primitives. A short
inventory:

- **`avm-daemon`** (`packages/avm-daemon/src/`) — long-running
  Connect RPC server bound to `127.0.0.1:6970`. Auto-starts on demand.
  Hosts both a host-facing API (container registry, services) and a
  bridge-facing API (services, editor, browser, notifications, repos).
  Persists state to `~/.avm/daemon/state.json`.
- **`avm create / start / exec / clean`** (`packages/avm/src/cli/commands/`)
  — programmatic container lifecycle. `avm create` boots a container,
  registers it with the daemon, and runs post-creation setup. `avm exec`
  is a non-interactive `docker exec -i -u agent` wrapper. `avm clean`
  unregisters and removes the container plus its volumes. The
  coordinator drives these same code paths in `lib/` directly (not via
  the interactive CLI).
- **`avm-bridge`** (`packages/avm-bridge/src/`) — in-container CLI for
  agents to call back to the host. The bridge's `Notify` RPC
  (`NEEDS_ATTENTION` / `COMPLETE`) is reused for desktop alerts when
  the coordinator needs human attention.
- **Credential mounts** (`packages/avm/src/lib/session.ts`,
  `getDockerMountArgs()`) — Claude credentials at
  `~/.avm/system/.claude/` and `~/.avm/system/claude.json` are mounted
  read-only into every container. SSH keys and git config likewise.
  All coordinator-spawned containers inherit these unchanged.
- **`update-branch` skill** — already exists in the user's
  `~/.claude/skills/update-branch/SKILL.md`. The coordinator does not
  ship a new skill; the example v1 task type's prompt instructs the
  agent to invoke it (and to leave the working tree at the desired
  state without pushing — see *Trust model* below).

## Trust model

A hard boundary splits responsibility between the in-container agent
and the host-side coordinator:

- **Agent** mutates only the container's working tree under
  `/home/agent/work/<repo>`. It rebases, restacks, edits files. It
  never invokes `git push`, `gh pr ...`, or any other operation that
  touches origin or GitHub state.
- **Coordinator** owns every destructive remote operation: backup-ref
  pushes, branch promotion (force-with-lease), ref deletion, control-
  comment posts and edits, reactions. These are initiated host-side
  via `docker exec` against the container's git workspace, after gate
  checks (lock still held, PR not flipped to draft).

This isn't a soft convention — the system is structured so the agent
has no path to a destructive remote operation:

- The agent's prompt (which the user configures) instructs it not to
  push and to write its result to a known file. The example
  `update-branch.md` prompt enforces this in plain text.
- Even if the agent ignores that instruction, the coordinator's
  `git push --force-with-lease=<head>:<pre_rebase_sha>` is the final
  safety net — origin will reject any push that overwrites a SHA the
  coordinator didn't record.

The agent's only output channel for "what did you do" is a structured
result file at `/home/agent/avm-task/result.json`, which the
coordinator reads via `docker exec` after the agent process exits.
The schema is fixed by the framework (see *Task type configuration*),
not by individual task types.

Cancellation falls out of this design rather than being added on top:
SIGTERM at any container step means no result file is written, so the
coordinator's promote step never runs. There is no half-promoted state
to roll back.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  HOST — avm-daemon (long-running)                                  │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │ poll loop    │─▶│ dispatcher   │─▶│ task driver            │    │
│  │ - discovery  │  │ - criteria   │  │ host-initiated phases  │    │
│  │ - per-PR     │  │ - per-branch │  │ via docker exec:       │    │
│  │   poll       │  │   lock       │  │  1. avm create         │    │
│  └──────┬───────┘  └──────┬───────┘  │  2. clone + checkout   │    │
│         │                 │          │  3. record pre-SHA     │    │
│         │                 │          │  4. backup-ref push    │    │
│         │                 │          │  5. claude -p <prompt> │    │
│         │                 │          │  6. read result.json   │    │
│         │                 │          │  7. gate re-check      │    │
│         │                 │          │  8. force-with-lease   │    │
│         │                 │          │     promote            │    │
│         │                 │          │  9. avm clean          │    │
│         ▼                 ▼          └────────────┬───────────┘    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  SQLite state store (~/.avm/daemon/state.db)                 │  │
│  │  watched_prs · tasks · branch_locks · backup_branches ·      │  │
│  │  coordinator_state · containers · service_pids               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│         ▲                 ▲                                        │
│         │                 │                                        │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌────────────────────────┐    │
│  │ control      │  │ classifier   │  │ failure router +       │    │
│  │ comment mgr  │  │ (built-in    │  │ circuit breaker +      │    │
│  │              │  │  patterns)   │  │ daily sweep            │    │
│  └──────────────┘  └──────────────┘  └────────────────────────┘    │
└──────────────────────────────────────────────┬─────────────────────┘
                                               │ all destructive
                                               │ remote ops via
                                               │ docker exec
                                               ▼
                ┌─────────────────────────────────────────────┐
                │  ephemeral avm container                    │
                │  ┌───────────────────────────────────────┐  │
                │  │ workspace at /home/agent/work/<repo>  │  │
                │  │   (agent edits here only — never      │  │
                │  │    pushes; never touches origin)      │  │
                │  └───────────────────────────────────────┘  │
                │  ┌───────────────────────────────────────┐  │
                │  │ result file                           │  │
                │  │   /home/agent/avm-task/result.json    │  │
                │  │   { status, head_sha, notes }         │  │
                │  │   (agent writes; host reads)          │  │
                │  └───────────────────────────────────────┘  │
                └─────────────────────────────────────────────┘
                                               │
                                               ▼
                                  GitHub (origin remote)
                                  - PR head ref (promoted)
                                  - avm-backup/* refs
                                  - control comment + reactions
```

The coordinator is a subsystem of the existing daemon, not a new
process. Responsibility lives in the daemon because that's where
container state and the bridge already live; a sibling
`avm-orchestrator` would duplicate the registry and create a second
state file with its own consistency problems.

The host never maintains a local git workspace of its own. The
container's clone is the only one — the host orchestrates git
operations against it via `docker exec`, never runs `git` locally.

## Components

### Task type configuration

The coordinator framework is task-type-agnostic. Task types are
declared in `~/.avm/config.yaml`:

```yaml
coordinator:
  enabled: true
  allowlist: [marc]
  task_types:
    update-branch:
      hotword: /avm update
      auto_trigger: branch-behind-base   # also: ready-transition, none
      timeout: 5m
      prompt_file: prompts/update-branch.md
      # OR (mutually exclusive with prompt_file):
      # prompt: |
      #   inline prompt text...
```

Fields:

- `hotword` — the comment trigger for this task type. Must be unique
  across configured task types.
- `auto_trigger` — predicate evaluated during polling. v1 supports
  `branch-behind-base`, `ready-transition`, and `none`.
- `timeout` — wall-time cap on the agent step (step 5 in the task
  driver). On timeout: SIGTERM the container; classify as
  `needs-human`.
- `prompt` — inline prompt text passed to `claude -p ...`.
- `prompt_file` — path to a file containing the prompt. Resolved
  relative to `~/.avm/` (e.g., `prompts/update-branch.md` →
  `~/.avm/prompts/update-branch.md`); absolute paths also accepted.
  Read fresh at each dispatch so prompt edits take effect on the
  next task without daemon restart.
- Exactly one of `prompt` or `prompt_file` must be set.

**Frame contract — what every prompt must do.**

The prompt is the user's primary control surface for what the agent
does. The framework imposes only one contract on it: on completion,
the agent must write a JSON object to
`/home/agent/avm-task/result.json`:

```json
{
  "status": "ok" | "skipped" | "failed",
  "head_sha": "<git rev-parse HEAD>",
  "notes": "human-readable summary"
}
```

- `ok` — work performed; `head_sha` is the new tip the coordinator
  should promote.
- `skipped` — agent decided no work was needed; `head_sha` should
  equal `pre_rebase_sha`. Coordinator records this and does not push.
- `failed` — agent could not complete; `notes` explains why.
  Coordinator marks the task `needs-human`.

The prompt is also responsible for telling the agent NOT to push (see
*Trust model*). The example `update-branch.md` prompt shipped under
`examples/prompts/` enforces both halves of the contract in plain
text.

v1 ships:

- The coordinator framework (poll, dispatch, task driver, classifier,
  breaker, sweep, control-comment manager).
- One example task type in `examples/config.yaml`: `update-branch`
  with hotword `/avm update`, `auto_trigger: branch-behind-base`,
  and `prompt_file: prompts/update-branch.md`.
- One example prompt at `examples/prompts/update-branch.md` invoking
  the existing `/update-branch` skill with the frame contract
  appended.

Adding `/avm address` in v2 is a config + prompt-file change — no
daemon code.

### Trigger format

The set of recognised hotwords is derived from the configured task
types' `hotword` fields. For each configured hotword, a comment line
matching that exact string (case-insensitive, leading and trailing
whitespace allowed) registers as a trigger for the associated task
type.

Two exclusions apply to all hotwords:

- Lines whose first non-whitespace character is `>` (quoted reply
  text) are ignored.
- Lines inside fenced code blocks (\`\`\` or `~~~`) are ignored.

Authorization: the comment author must be the PR author or appear in
the configured allowlist (`coordinator.allowlist: [<gh-login>, ...]`
in `~/.avm/config.yaml`). Comments from non-allowlisted users are
silently ignored — no reaction, no log entry, to avoid leaking the
coordinator's existence to drive-by contributors.

In v1 the only blessed example task type is `update-branch` with
hotword `/avm update`, so the only hotword the example config
recognises is that one. Adding a new hotword is a configuration
change — no daemon code.

### Discovery and polling

Two-tier polling:

1. **Discovery search** every 60s — narrow query for PRs that may have
   new triggers:

   ```
   gh api search/issues -X GET -f q="commenter:<me> is:pr is:open
   draft:false updated:>=<watermark>"
   ```

   `<me>` is the gh-authenticated user. `<watermark>` is the timestamp
   of the most recent comment processed in any prior poll, persisted in
   `coordinator_state.last_search_watermark`. Result PRs are checked for
   trigger comments newer than the watermark and registered if matched.

2. **Per-watched-PR poll** every 60s — for each row in `watched_prs`,
   fetch comments and the PR's `isDraft` field. Detect new triggers,
   detect ready/draft transitions, detect base-branch advancement.
   Watched PRs in draft are still polled (cheaply) so transitions are
   noticed.

The per-PR poll runs even for drafts because the ready transition
itself is a dispatch trigger (see *Draft / ready transitions* below).

Watermark is updated only after all candidate comments from a poll
cycle have been processed, so a daemon crash mid-cycle re-processes
that cycle on restart rather than skipping comments.

### Dispatch criteria

A trigger is one of:

- An explicit hotword comment matched by the trigger parser.
- A predicate evaluated during the per-PR poll. Built-in predicates
  (v1):
  - `branch-behind-base` — the PR's `mergeStateStatus` is `BEHIND`
    or `DIRTY`, or `gh api repos/.../compare/<base>...<head>` reports
    `behind_by > 0`.
  - `ready-transition` — fires once on each draft → ready transition.
  - `none` — no auto-trigger; only the explicit hotword.

Each task type's `auto_trigger` field selects which predicate (if any)
runs during polling. Hotword triggers are always recognised regardless
of `auto_trigger`.

When a trigger fires, the dispatcher re-evaluates the task type's
predicate (if any) at dispatch time so a fast race — predicate true
at trigger, false by dispatch — doesn't queue an unneeded task. If
the recheck is false, the control comment is updated to reflect
"✅ idle (up to date)" and no container is spawned.

### Per-branch lock

`branch_locks` is a single-row-per-branch table keyed by
`branch_key = repo_full_name + ':' + head_ref`. Acquisition is an
`INSERT OR FAIL`; release is a `DELETE`. Both operations happen inside
the same SQLite transaction that creates / completes the task row.

A task cannot start if its branch is locked. Stale locks (held by a
task whose container no longer exists) are reaped on daemon boot
during reconciliation.

### Task driver

For each dispatched task, the host orchestrates phases via
`docker exec`. The container is a sandbox; the host is the
conductor. No wrapper script runs as the container's main process —
each phase is an explicit, host-initiated `docker exec`.

```
1. avm create avm-coord-<task-id-short>
   (programmatic call to the same lib/session.ts code path used by
   `avm create`. Deterministic container name; short-lived label
   for manual inspection.)

2. docker exec <c> mkdir -p /home/agent/work /home/agent/avm-task

3. docker exec <c> git clone <repo-url> /home/agent/work/<repo>
   docker exec <c> git -C /home/agent/work/<repo> checkout <head-ref>

4. Record pre_rebase_sha:
   docker exec <c> git -C /home/agent/work/<repo> rev-parse HEAD
   (Persisted in the task row before any further step.)

5. Backup-ref push (host-initiated, from inside the container):
   docker exec <c> git -C /home/agent/work/<repo> push origin \
     HEAD:refs/heads/avm-backup/<head>/<unix-ts>
   (Non-destructive — creates a new ref. Recorded in
   `backup_branches` and the control comment.)

6. Run the agent:
   docker exec <c> claude -p "<resolved-prompt>" \
     --dangerously-skip-permissions \
     --output-format json
   (Stdout + stderr captured to
   ~/.avm/orchestrator/tasks/<task-id>/output.log. Resolved prompt
   read fresh from the task type's `prompt` / `prompt_file` at
   dispatch time. Wall-time bounded by `task_types.<n>.timeout`.)

7. Read the result file:
   docker exec <c> cat /home/agent/avm-task/result.json
   (Parses { status, head_sha, notes }. Missing or malformed file →
   status defaults to `failed`.)

8. Re-check gates:
   - branch lock still held by this task
   - PR `isDraft` still false
   (Origin SHA need not be re-checked — `--force-with-lease` does
   that atomically in step 9.)

9. If status == "ok":
     docker exec <c> git -C /home/agent/work/<repo> push \
       --force-with-lease=<head>:<pre_rebase_sha> \
       origin HEAD:refs/heads/<head>
   If status == "skipped": no push; record idle in control comment.
   If status == "failed": no push; classifier escalates.

10. avm clean <c>
```

Cold-start latency per task is ~10–30s (container create + clone).
Acceptable for background work in v1; warm-pool optimization is
deferred.

Cancellation between any two steps means the next step never runs.
SIGTERM mid-step kills the in-flight `docker exec`; the container is
torn down by `avm clean`. The promote in step 9 is a single host-
initiated push gated on result-file presence — there is no partial
state to undo.

The agent is invoked headless via `claude -p`. The example v1 prompt
invokes `/update-branch` (whose decision tree is mechanical: fetch,
check base, rebase or restack, write result), with the no-push and
result-file requirements appended. Skills with required human
interaction (e.g., `address-review`'s "present analysis table and
wait") will need either a coordinator-tailored variant or an upstream
non-interactive mode before they can ship as a v2 task type.

### Failure classification

After container exit, the classifier reads the task log and assigns a
`failure_class`:

| Class | Detection | Action |
|---|---|---|
| `done` | exit 0, branch SHA advanced or "already up to date" | release lock, update control comment ✅ |
| `transient` | exit ≠ 0, output matches `/network|timeout|ECONNRESET|gh api .* 5\d\d/i` | retry with backoff (2 attempts max), then escalate |
| `needs-credentials` | output matches `/not authenticated\|invalid api key\|credit balance\|401 unauthorized/i` | trip global circuit breaker |
| `needs-human` | exit ≠ 0, skill output mentions "conflict", "manual", "could not" | mark branch+SHA stuck; do not retry until SHA advances |
| `unknown` | exit ≠ 0, no other class matched | treat as `needs-human` |

Patterns are heuristic. Misclassification is recoverable via
`avm orchestrate reclassify <task-id>` (utility command, low priority).

### Circuit breaker

`coordinator_state.circuit_breaker_state` is `closed` (normal) or
`open` (paused). When tripped:

- All polling stops.
- A desktop notification fires (via the existing `Notify` RPC, sent by
  the daemon to itself — the bridge service handles host-side
  notifications regardless of caller).
- The control comment on the affected PR is updated to "❌ failed
  (credentials)" with the failing log path.
- Other watched PRs' control comments stay unchanged — their next poll
  cycle is what would have updated them.

User runs `avm orchestrate resume` after refreshing credentials. The
breaker re-opens, polling resumes, and the next cycle re-evaluates
all watched PRs.

### Control comment

On first trigger for a PR, post a comment with a stable HTML marker:

```markdown
<!-- avm-coordinator:v1 id=<ulid> -->

**🤖 avm coordinator** — *updated <iso-ts>* — status: ✅ idle

<details><summary>Recent activity</summary>

- <ts> — <event>
- ...

</details>

<details><summary>State (do not edit)</summary>

​```yaml
version: 1
id: <ulid>
backups:
  - ref: avm-backup/<branch>/<unix-ts>
    created_at: <iso-ts>
    pre_rebase_sha: <sha>
last_task:
  type: update-branch
  status: done | failed | cancelled
  trigger_comment_id: <node-id>
  started_at: <iso-ts>
  finished_at: <iso-ts>
last_seen_state: ready | draft
​```

</details>
```

Subsequent updates edit this comment in place via
`gh api -X PATCH /repos/.../issues/comments/<id>`. The HTML marker
makes it findable on cold start; the YAML state block is the
authoritative coordinator state for that PR (the SQLite `watched_prs`
row caches it).

`watched_prs.control_comment_id` stores the comment node ID once
posted. On daemon boot, for each watched PR with a known
`control_comment_id`, the coordinator fetches the comment and
reconciles SQLite against it (GitHub wins — the YAML state block is
canonical).

### Reactions on trigger comments

For each hotword-triggered task, react on the trigger comment with the
current status:

| Reaction | Meaning |
|---|---|
| 👀 | seen, queued |
| 🚀 | dispatched, container running |
| ✅ | done |
| ❌ | failed (see control comment) |
| 🚫 | refused (auth, locked, draft, conflict) |

Add reactions cumulatively; never remove. Reactions are per-comment
ack; the rolling status lives in the control comment.

### Draft / ready transitions

Per-PR poll detects `isDraft` change against
`watched_prs.last_seen_state`:

- **ready → draft:** for each running task on this PR, write
  `tasks.status = 'cancelled'` (with reason
  `'pr-flipped-to-draft'`) before any side effect, then SIGTERM the
  container (SIGKILL after a 10s grace period), release the lock,
  update the control comment to "⏸ paused (draft)". Hotwords arriving
  while paused are reacted 🚫 and logged in the control comment with
  "trigger ignored: PR is draft", but not queued.

- **draft → ready:** evaluate dispatch criteria fresh. If
  `needs-update-branch` is true, queue an `update-branch` task with
  `trigger_kind = 'ready-transition'`. Do not replay hotwords queued
  while draft.

### Backup branches

Convention: `avm-backup/<original-branch>/<unix-ts>`. Pushed in step 5
of the task driver, before the agent runs, as a host-initiated
`docker exec` against the container's git workspace. The push is
non-destructive (creates a new ref keyed by timestamp; no `--force`),
so it carries no risk regardless of what the agent does next.

Push is to `origin` only (never the upstream PR remote in fork-based
workflows). The backup ref, source branch, pre-rebase SHA, creation
timestamp, and owning task ID are recorded in the `backup_branches`
table and the control comment's YAML state block.

Cleanup is a separate daily sweep (see *Cleanup sweep* below). v1 has
no automated restore — backups are for manual recovery only. The
coordinator does not delete a backup until its PR is closed.

### Cleanup sweep

Once per day, the coordinator:

1. Finds all `watched_prs` whose corresponding PR is now closed
   (`gh api repos/.../pulls/<n> | jq .state`).
2. For each, reads the control comment's YAML state, deletes every
   listed `avm-backup/*` ref via `git push origin :refs/heads/...`,
   then updates the control comment with a final "🏁 PR closed,
   backups cleaned" entry.
3. Removes the `watched_prs` row and any related `branch_locks` /
   `backup_branches` rows.

Belt-and-braces fallback: any `avm-backup/*` ref older than 30 days
is deleted regardless of whether its control comment was found.

## State store — SQLite via `node:sqlite`

The existing `~/.avm/daemon/state.json` (containers + service PIDs) is
migrated into SQLite alongside the new orchestrator tables. One source
of truth for daemon-side state.

### Library and version

`node:sqlite` (built into Node 22.5+, stable in 24). Synchronous API
(`DatabaseSync`) maps cleanly onto request handlers. WAL mode for
concurrent reads:

```ts
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("~/.avm/daemon/state.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
```

The repo's root `package.json` gains `"engines": { "node": ">=22.5" }`
so contributors don't hit a confusing `node:sqlite` import error on
older runtimes. (Recommend `>=24` once Node 24 is the LTS at
implementation time.)

### Schema

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Migrated from state.json
CREATE TABLE containers (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE service_pids (
  service_name TEXT PRIMARY KEY,
  pid INTEGER NOT NULL
);

-- Coordinator
CREATE TABLE watched_prs (
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  control_comment_id TEXT,
  last_seen_state TEXT,           -- 'ready' | 'draft'
  last_polled_at TEXT,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, pr_number)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,            -- ulid
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  branch_key TEXT NOT NULL,
  task_type TEXT NOT NULL,        -- 'update-branch' (v1)
  trigger_kind TEXT NOT NULL,     -- 'hotword' | 'ready-transition'
  trigger_comment_id TEXT,
  status TEXT NOT NULL,           -- queued|running|cancelled|done|failed
  container_name TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  failure_class TEXT,             -- transient|needs-credentials|needs-human
  log_path TEXT
);
CREATE INDEX idx_tasks_branch_status ON tasks(branch_key, status);
CREATE INDEX idx_tasks_pr ON tasks(repo_full_name, pr_number);

CREATE TABLE branch_locks (
  branch_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE backup_branches (
  ref TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  source_branch TEXT NOT NULL,
  pre_rebase_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  task_id TEXT NOT NULL,
  cleaned_up_at TEXT
);

CREATE TABLE coordinator_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  last_search_watermark TEXT,
  circuit_breaker_state TEXT NOT NULL DEFAULT 'closed',
  circuit_breaker_tripped_at TEXT,
  circuit_breaker_reason TEXT
);
INSERT INTO coordinator_state (id) VALUES (1);
```

### Migration approach

- Numbered SQL files in `packages/avm-daemon/src/db/migrations/`
  (`0001_init.sql`, etc.). Each file is run once and recorded in
  `schema_migrations`.
- On first daemon boot post-upgrade: open the new DB, run pending
  migrations, then if `~/.avm/daemon/state.json` exists, import its
  contents into `containers` and `service_pids`, and rename it to
  `state.json.bak`. Idempotent — safe to re-run.
- Logs and other blobs stay on disk; the DB stores paths only
  (`tasks.log_path`).

### Repository layer

A thin module per concern in `packages/avm-daemon/src/db/repos/`
(`containers.ts`, `tasks.ts`, `watched-prs.ts`, `branch-locks.ts`,
`backup-branches.ts`, `coordinator-state.ts`). No ORM. Plain prepared
statements with typed wrappers. Each repo file exports functions, not
a class.

## RPC surface

A new `OrchestratorService` in `proto/avm/host/v1/orchestrator.proto`:

```proto
service OrchestratorService {
  rpc Enable(EnableRequest) returns (EnableResponse);
  rpc Disable(DisableRequest) returns (DisableResponse);
  rpc Status(StatusRequest) returns (StatusResponse);
  rpc ListTasks(ListTasksRequest) returns (ListTasksResponse);
  rpc Resume(ResumeRequest) returns (ResumeResponse);
  rpc Reclassify(ReclassifyRequest) returns (ReclassifyResponse);
}
```

Status returns: enabled flag, breaker state, count of watched PRs,
count of running tasks, last poll timestamp. ListTasks supports
filtering by status / PR / branch and returns recent tasks with their
log paths.

## CLI surface

New file `packages/avm/src/cli/commands/orchestrate.ts` wired into
`cli/avm.ts`. Subcommands:

- `avm orchestrate enable` — flip `coordinator_state.enabled = 1`,
  start the poll loop.
- `avm orchestrate disable` — flip to 0, stop the poll loop, leave
  in-flight tasks to finish naturally.
- `avm orchestrate status` — print current status, breaker state,
  watched PRs with last activity, recent tasks.
- `avm orchestrate logs <task-id>` — stream the task's log file.
- `avm orchestrate resume` — reset breaker to `closed` after credential
  refresh.
- `avm orchestrate reclassify <task-id> <class>` — manual override for
  misclassified failures.

## Files

**New:**

- `packages/avm-daemon/src/orchestrator/poll.ts` — discovery + per-PR
  polling loops.
- `packages/avm-daemon/src/orchestrator/dispatcher.ts` — criteria
  evaluation, lock acquisition, task creation.
- `packages/avm-daemon/src/orchestrator/task-driver.ts` — host-side
  per-task orchestration (the docker-exec choreography in *Task
  driver*).
- `packages/avm-daemon/src/orchestrator/classifier.ts` — failure
  classification (built-in patterns).
- `packages/avm-daemon/src/orchestrator/control-comment.ts` —
  post / edit / parse the per-PR control comment.
- `packages/avm-daemon/src/orchestrator/github.ts` — thin wrapper
  around `gh` for search, PR fetch, comment post / edit, reactions,
  ref delete.
- `packages/avm-daemon/src/orchestrator/triggers.ts` — hotword regex,
  quoted-line / code-block exclusions, author allowlist check.
- `packages/avm-daemon/src/orchestrator/breaker.ts` — circuit breaker
  state machine and notification.
- `packages/avm-daemon/src/orchestrator/sweep.ts` — daily cleanup of
  closed-PR backups.
- `packages/avm-daemon/src/orchestrator/prompts.ts` — load prompts
  from inline strings or files (resolution under `~/.avm/`).
- `packages/avm-daemon/src/db/db.ts` — `node:sqlite` setup, WAL,
  migration runner.
- `packages/avm-daemon/src/db/migrations/0001_init.sql` — full
  schema.
- `packages/avm-daemon/src/db/repos/*.ts` — one module per table.
- `packages/avm/src/cli/commands/orchestrate.ts` — host CLI.
- `proto/avm/host/v1/orchestrator.proto` — RPC definitions.
- `examples/prompts/update-branch.md` — example v1 task prompt
  (invokes `/update-branch` skill, instructs no-push, instructs
  result-file write).

**Modified:**

- `packages/avm-daemon/src/server.ts` — start orchestrator poll loop
  on boot if `coordinator_state.enabled = 1`.
- `packages/avm-daemon/src/state.ts` — replace JSON-backed
  `StateStore` with SQLite-backed equivalent for `containers` and
  `service_pids`.
- `packages/avm-daemon/src/registry.ts` — point at new state store.
- `packages/avm/src/cli/avm.ts` — register `orchestrate` subcommand
  group.
- `packages/shared/src/` — regenerate Connect client types for the
  new service.
- `packages/avm/src/lib/config-file.ts` — add
  `coordinator: { enabled, allowlist, task_types }` schema, with
  per-task-type validation (mutually-exclusive prompt / prompt_file,
  unique hotwords, known auto_trigger predicates).
- `examples/config.yaml` — show full `coordinator` block including
  one example `update-branch` task type referencing
  `prompts/update-branch.md`.
- `package.json` — `"engines": { "node": ">=22.5" }`.
- `README.md` — new "PR coordinator" section covering opt-in,
  hotword, draft semantics, backup convention, credential failure
  recovery, and how to add a custom task type.

**Untouched on purpose:**

- `templates/vm-claude.md` — the in-container agent does not need to
  know about the coordinator; from inside the container, this looks
  like any other invocation of the configured skill.
- The `update-branch` skill itself.
- No host-side git workspace — the host never runs `git` outside of
  `docker exec` invocations against the container's clone.

## Error handling

All RPCs use existing `ConnectError` codes:

- `FailedPrecondition` — coordinator disabled when a control RPC
  expects it enabled; circuit breaker open when `Resume` would be
  expected first.
- `NotFound` — `ListTasks` filter matches no rows; `Reclassify` for
  unknown task ID.
- `InvalidArgument` — unknown `failure_class` passed to `Reclassify`.

In-task failures (container exit non-zero, gh API errors, git push
rejections) flow through the classifier and are surfaced via the
control comment, never as RPC errors.

## Testing approach

Per CLAUDE.md, no automated tests. Manual end-to-end verification:

1. Enable coordinator with the example `update-branch` task type
   configured (hotword `/avm update`, `prompt_file:
   prompts/update-branch.md`). Post `/avm update` on a self-owned PR
   whose base branch is ahead. Observe: 👀 reaction, control comment
   posted, 🚀 reaction, container created, agent rebases locally,
   `result.json` written with `status: ok`, host promotes via
   `git push --force-with-lease`, ✅ reaction, control comment shows
   "done". Verify the agent itself never invoked `git push` (check
   the container's bash history or the captured agent log).
2. Backup branch present on origin matching the convention; recorded
   in control comment YAML.
3. Mark PR draft mid-task. Observe: container killed within seconds,
   control comment shows "paused (draft)", task row shows
   `status='cancelled'` with reason.
4. Mark PR ready again. Observe: dispatch re-evaluates; if base is
   still ahead, new task runs; if not, control comment shows
   "✅ idle (up to date)".
5. Post `/avm update` from a non-author, non-allowlisted account.
   Observe: silently ignored — no reaction, no log entry.
6. Quote `/avm update` in a reply (`> /avm update`). Observe: ignored.
7. Wrap `/avm update` in a code block. Observe: ignored.
8. Trigger a `needs-credentials` failure (e.g., temporarily invalidate
   `~/.avm/system/.claude/credentials`). Observe: breaker trips,
   desktop notification fires, polling stops, control comment shows
   failure class. Run `avm orchestrate resume` after restoring creds;
   verify polling resumes and the failed PR is re-evaluated.
9. Close a PR. Within the next sweep cycle, verify its `avm-backup/*`
   refs are deleted from origin and its `watched_prs` row is removed.
10. Restart the daemon mid-task. Observe: on boot, the orphaned task
    is reaped, the lock released, the control comment updated to
    reflect the failure.

## Alternatives considered

- **Webhooks for trigger ingestion.** Rejected for v1: requires a
  reachable endpoint (smee.io / ngrok / `gh webhook forward`),
  signature verification, replay handling. Polling at 60s intervals is
  well within rate limits for a single user and has zero infra cost.
  Webhook ingest can be added as a second event source without
  restructuring the dispatcher.

- **Repository labels for opt-in.** Rejected: labels are repo-global
  state visible to all contributors and require admin to create.
  Hotwords are per-PR, invisible to non-participants, and require no
  repo configuration.

- **Standalone `avm-orchestrator` process.** Rejected: would
  duplicate the container registry, require its own auto-start, and
  introduce a second state file with cross-process consistency
  problems. The daemon already auto-starts and owns container
  lifecycle.

- **`better-sqlite3` instead of `node:sqlite`.** Rejected: native build
  step adds install friction. `node:sqlite` is now stable in Node
  22.5+, has a structurally identical synchronous API, and no native
  dependency. Performance is comparable for this workload (single
  user, low write volume).

- **Warm container pool.** Deferred. v1 cold-creates one container per
  task; ~10–30s overhead is acceptable for background work. Pool of
  one or two warm containers is a v2 optimization if measured latency
  becomes a problem.

- **Letting in-flight tasks finish when PR flips to draft.** Rejected.
  The user's intent in marking draft is "stop touching this branch";
  letting a force-push land seconds after that flip violates the
  intent. Tasks are idempotent — cancelling and re-evaluating on the
  next ready transition loses nothing.

- **Storing coordinator state only in SQLite (no control comment).**
  Rejected: makes recovery from machine moves or DB loss painful, and
  hides task history from the GitHub UI where the work is actually
  visible. Comment-as-source-of-truth means the user can grep their
  PRs to understand what the coordinator has done.

- **Restoring backups automatically on detected bad rebase.** Rejected
  for v1. "Detected bad rebase" is hard to define and easy to get
  wrong; a wrong auto-restore is worse than a missing one. Backups
  exist to make manual recovery cheap; v2 may add a guided
  `avm orchestrate restore <task-id>` if it proves needed.

- **Letting the agent run `git push`.** Rejected. Even with a clear
  prompt instruction not to push, the system would be one prompt
  ignore away from a destructive remote operation racing with the
  coordinator's draft-cancellation logic. Restricting the agent to
  working-tree mutations and routing all pushes through host-
  initiated `docker exec` makes the trust boundary structural rather
  than conventional. `--force-with-lease` against the recorded
  `pre_rebase_sha` is the final safety net.

- **Container pushes to a staging ref; host fetches and promotes.**
  Considered. Adds a round-trip (container → origin staging → host
  mirror → origin head) and requires the host to maintain a bare git
  mirror per repo. The simpler "host runs `git push` from inside the
  container via `docker exec`" achieves the same trust boundary with
  one push, no host-side git workspace, and visible primitives — the
  user can debug a stuck task by running the same `docker exec`
  commands manually.

- **Host-side bare git mirror per repo.** Rejected as unnecessary
  given the docker-exec model. A mirror would be useful only if the
  host needed to run git operations independently of the container,
  and v1 has no such need. If a future need arises, a reserved
  internals folder under `~/.avm/orchestrator/` is the place — the
  spec leaves this open without committing to it.

- **Hardcoding `update-branch` into the daemon.** Rejected. The
  trigger / dispatch / sandbox / push pattern generalises across
  task types; baking one task type in would constrain the design and
  force a binary change for every new automation. Configuration-
  driven task types ship in v1 even though only one example is
  validated, so future task types add no daemon code.

- **Configurable failure-classifier patterns.** Considered. Per-task-
  type regex lists with per-class actions would be coherent with the
  task-type-as-config framing, but adds substantial YAML for marginal
  gain — the built-in patterns are generic enough across task types.
  Deferred; revisit if a v2 task type genuinely needs different
  classification.

- **Built-in `address-review` task type using the existing
  `~/.claude/skills/address-review` skill.** Rejected for v1. The
  existing skill has interactive HARD-GATEs ("present analysis table
  and wait for input") that don't run cleanly headless. A v2 task
  type for address-review will need either a coordinator-tailored
  skill variant or a non-interactive mode in the upstream skill —
  out of scope here.
