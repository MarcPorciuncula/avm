# PR Coordinator — Implementation Plan

Spec: docs/superpowers/specs/2026-05-11-pr-coordinator-design.md

Seven sequential tasks, one PR with one commit per task. Each task is
independently runnable end-to-end against the existing avm
installation. The PR is opened draft on Task 1's commit and marked
ready after Task 7 per the repo's `auto-ready` PR mode.

## Task 1: SQLite scaffolding and StateStore migration

- [ ] Status

### Scope

Stand up `node:sqlite` as the daemon's durable state store at
`~/.avm/daemon/state.db`. Ship the full v1 schema (existing concerns
plus all coordinator tables). Migrate the existing JSON-backed
`StateStore` (containers + service PIDs) to be SQLite-backed without
changing existing avm CLI behavior. Subsequent tasks read and write
through the new repository modules.

Does not yet introduce any coordinator behavior — no polling, no
RPC service, no CLI command. The coordinator tables exist but are
unused at the end of this task.

### Approach

- New `packages/avm-daemon/src/db/db.ts` opens the DB with WAL mode
  and `PRAGMA foreign_keys = ON`, exposes a `DatabaseSync` instance,
  and runs a migration runner. The runner reads files matching
  `migrations/*.sql` in lexicographic order, applies any whose
  version is missing from the `schema_migrations` table inside a
  transaction, and inserts the version row on success.
- `packages/avm-daemon/src/db/migrations/0001_init.sql` ships the
  complete schema from the spec: `schema_migrations`, `containers`,
  `service_pids`, `watched_prs`, `tasks` (including the
  `auto_retriggered` column), `branch_locks`, `backup_branches`,
  `coordinator_state`. Indexes per spec. Singleton row inserted into
  `coordinator_state` with `id=1, enabled=0,
  circuit_breaker_state='closed'`.
- Repository modules in `packages/avm-daemon/src/db/repos/`, one
  file per table. Each exports plain functions (no class). Functions
  take a `db: DatabaseSync` parameter explicitly so they're easy to
  unit-test and don't carry hidden state. For Task 1 only
  `containers.ts` and `service-pids.ts` have bodies; the others get
  exported function signatures backed by `throw new Error('not
  implemented')` so the schema-defining migration compiles against
  callers in later tasks without forcing premature implementation.
- `packages/avm-daemon/src/state.ts` keeps its public surface
  (`StateStore` class, methods used by `registry.ts` and RPC
  handlers) but replaces JSON file I/O with calls into
  `db/repos/containers.ts` and `db/repos/service-pids.ts`. Existing
  call sites (`registry.ts`, `server.ts`) do not change.
- `packages/avm-daemon/src/main.ts` is modified to open the DB,
  run migrations, then perform a one-shot import from `state.json`
  if it exists: read the JSON, insert rows with `INSERT OR IGNORE`,
  rename `state.json` to `state.json.bak`. Order: migrations →
  import → existing startup steps (state store init, registry,
  server).
- Root `package.json` gains `"engines": { "node": ">=22.5" }`.

### Files

- packages/avm-daemon/src/db/db.ts (new)
- packages/avm-daemon/src/db/migrations/0001_init.sql (new)
- packages/avm-daemon/src/db/repos/containers.ts (new)
- packages/avm-daemon/src/db/repos/service-pids.ts (new)
- packages/avm-daemon/src/db/repos/watched-prs.ts (new — stubs only)
- packages/avm-daemon/src/db/repos/tasks.ts (new — stubs only)
- packages/avm-daemon/src/db/repos/branch-locks.ts (new — stubs only)
- packages/avm-daemon/src/db/repos/backup-branches.ts (new — stubs only)
- packages/avm-daemon/src/db/repos/coordinator-state.ts (new — stubs only)
- packages/avm-daemon/src/state.ts (modify)
- packages/avm-daemon/src/main.ts (modify)
- package.json (modify)

### Done criteria

- `avm daemon start` on a host with an existing populated
  `~/.avm/daemon/state.json` creates `state.db`, applies the
  migration, imports the JSON rows, and renames the JSON to
  `state.json.bak`.
- `avm create foo`, `avm exec foo ls /`, `avm clean foo` complete
  successfully and the container row appears in / disappears from
  `containers` (verify via `sqlite3 ~/.avm/daemon/state.db 'SELECT *
  FROM containers'`).
- Service start/stop via existing CLI continues to function;
  `service_pids` rows track expected PIDs.
- Restarting the daemon after migration is a no-op (no double
  migration, no error from re-renaming `state.json`).
- `sqlite3 ~/.avm/daemon/state.db ".schema"` reports all coordinator
  tables present with expected columns.

## Task 2: Coordinator configuration schema and example prompt

- [ ] Status

### Scope

Add a `coordinator:` block to `lib/config-file.ts` parsing and
validation. Ship a complete worked example in `examples/config.yaml`
and a real example prompt file at `examples/prompts/update-branch.md`.

Does not yet read this config from the daemon — Task 5 wires the
poll loop to it. This task only proves the config schema accepts a
valid coordinator block and rejects invalid ones.

### Approach

- Add `"coordinator"` to `TOP_LEVEL_KEYS` in
  `packages/avm/src/lib/config-file.ts`.
- Implement `parseCoordinator(node)` following the existing
  `parseDaemon` / `parseServices` style. Fields:
  - `enabled` — bool, default false.
  - `allowlist` — array of strings, required when `enabled: true`,
    must be non-empty.
  - `max_concurrent_tasks` — integer >= 1, default 1.
  - `task_types` — record keyed by task name. Required when
    `enabled: true`, must be non-empty.
- For each task type, validate:
  - `hotword` — string, must start with `/`, must be unique across
    all configured task types (case-insensitive).
  - `auto_trigger` — one of `"branch-behind-base"`,
    `"ready-transition"`, `"none"`. Default `"none"`.
  - `timeout` — duration string parsed to ms (`"5m"`, `"300s"`).
    Default 5 minutes. Implement a small duration parser in the
    same file (suffixes `s`, `m`, `h`).
  - `prompt` and `prompt_file` are mutually exclusive; exactly one
    must be set.
  - `prompt_file` — relative paths are resolved against `~/.avm/`;
    absolute paths used as-is. The file must exist at config-load
    time; throw a context-aware error if missing.
- All validation errors throw with the offending YAML key path in
  the message, matching the existing pattern's "`coordinator.task_types.<name>.hotword`" style.
- `examples/config.yaml` gets a `coordinator` block matching the
  spec's example (enabled: true with marc in allowlist,
  max_concurrent_tasks: 1, single `update-branch` task type
  pointing at `prompts/update-branch.md`).
- `examples/prompts/update-branch.md` is a real prompt file: it
  instructs the agent to invoke the `/update-branch` skill, to NOT
  push, and to write `/home/agent/avm-task/result.json` with the
  documented schema. Includes a concrete example of the success
  JSON object.

### Files

- packages/avm/src/lib/config-file.ts (modify)
- examples/config.yaml (modify)
- examples/prompts/update-branch.md (new)

### Done criteria

- Loading the modified `examples/config.yaml` via existing
  `parseAvmConfig` returns a parsed structure with the new
  `coordinator` block fully populated.
- Each of the following invalid configs throws an error whose
  message names the offending key:
  - `enabled: true` without `allowlist`
  - two task types with the same hotword
  - `auto_trigger: "branch-behind-base-typo"`
  - both `prompt:` and `prompt_file:` set on one task type
  - `prompt_file: nonexistent.md` (file does not exist)
  - `max_concurrent_tasks: 0`
- `examples/prompts/update-branch.md` exists in the repo and reads
  cleanly as a prompt a reader could give to Claude Code.

## Task 3: OrchestratorService RPC and avm orchestrate CLI

- [ ] Status

### Scope

Define the `OrchestratorService` proto, regenerate Connect types in
`packages/shared`, implement daemon-side handlers that operate
purely on `coordinator_state` and `tasks` repo state, and add the
`avm orchestrate ...` host CLI command group. The polling loop and
task execution are still absent at the end of this task — `enable`
flips a flag, `status` shows what's stored, that's it.

### Scope (not covered)

No polling. No control comment posts. No task dispatch. `Reload` is
a stub that returns success without doing anything yet.

### Approach

- New `proto/avm/host/v1/orchestrator.proto` defines the service
  with seven RPCs: `Enable`, `Disable`, `Status`, `ListTasks`,
  `Resume`, `Reclassify`, `Reload`. Request and response messages
  per the spec's RPC surface (`StatusResponse` carries enabled,
  breaker state, max_concurrent_tasks, watched_pr_count,
  running_task_count, last_poll_at).
- Regenerate the Connect TypeScript bindings in
  `packages/shared/src/` via the existing build/buf pipeline.
- New daemon-side handler module
  `packages/avm-daemon/src/orchestrator-rpc.ts` exporting an object
  satisfying the generated service interface. Implementations:
  - `Enable` / `Disable` — update `coordinator_state.enabled`.
  - `Status` — read from coordinator-state and tasks repos.
  - `ListTasks` — query tasks table with optional filters
    (`status`, `repo_full_name`, `pr_number`, `branch_key`,
    `limit`). Returns tasks ordered by `started_at DESC`.
  - `Resume` — set `circuit_breaker_state='closed'`,
    `circuit_breaker_tripped_at=NULL`,
    `circuit_breaker_reason=NULL`.
  - `Reclassify` — update one task's `failure_class`.
  - `Reload` — empty stub returning success. Wired meaningfully in
    Task 5.
- Register the service in `packages/avm-daemon/src/server.ts`
  alongside existing services.
- New `packages/avm/src/cli/commands/orchestrate.ts` using citty's
  `defineCommand` with one sub-command per RPC plus
  `logs <task-id>` which reads `tasks.log_path` and prints the
  file. Reuses existing host-side Connect client factory from
  `packages/shared/src/`.
- Wire the new sub-command group into
  `packages/avm/src/cli/avm.ts`.

### Files

- proto/avm/host/v1/orchestrator.proto (new)
- packages/shared/src/ (modify — regenerate; touched by build)
- packages/avm-daemon/src/orchestrator-rpc.ts (new)
- packages/avm-daemon/src/server.ts (modify)
- packages/avm/src/cli/commands/orchestrate.ts (new)
- packages/avm/src/cli/avm.ts (modify)

### Done criteria

- `pnpm exec buf generate` (or whatever the existing proto build
  invocation is) regenerates `packages/shared/src/` cleanly with
  the new service added; existing services unaffected.
- `avm orchestrate enable` flips `coordinator_state.enabled` to 1
  (verify with `sqlite3`); `avm orchestrate disable` flips it back.
- `avm orchestrate status` prints a multi-line report including the
  enabled flag, breaker state, max_concurrent_tasks (read from
  config), watched PR count (0), running task count (0).
- `avm orchestrate resume` resets a manually-tripped breaker
  (manually `UPDATE coordinator_state SET
  circuit_breaker_state='open'` first).
- `avm orchestrate logs <id>` returns NotFound for an unknown task
  id and prints the file otherwise.

## Task 4: GitHub wrapper, trigger parser, prompt loader

- [ ] Status

### Scope

Three standalone modules in the orchestrator namespace, importable
from each other but not yet wired into the daemon. Each is built
and exercisable in isolation so Task 5's poll loop and Task 6's
task driver can call them as already-working primitives.

### Approach

- `orchestrator/github.ts` — zx-based wrappers around the `gh` CLI.
  Each function shells `gh ...` via `$\`...\`` template literal,
  parses JSON from stdout, throws with stderr on non-zero exit.
  Functions to implement:
  - `searchIssues({ commenter, updatedSince }) → PRSummary[]` —
    wraps `gh api search/issues -X GET -f q='...'`.
  - `getPR(repoFullName, number) → PRDetails` — includes
    `isDraft`, `mergeStateStatus`, `baseRefName`, `headRefName`,
    `headRepository.sshUrl`, `author.login`.
  - `listIssueComments(repoFullName, number) → IssueComment[]` —
    `gh api repos/.../issues/<n>/comments`.
  - `postComment(repoFullName, number, body) → IssueComment`.
  - `editComment(repoFullName, commentId, body) → IssueComment` —
    `gh api -X PATCH .../issues/comments/<id>`.
  - `addReaction(repoFullName, commentId, content) → void` —
    `gh api -X POST .../issues/comments/<id>/reactions`. Content
    is one of `eyes`, `rocket`, `+1` (mapped to ✅ visually),
    `-1` (mapped to ❌), `confused` (mapped to 🚫). Spec uses
    emoji labels; this function takes the emoji label and maps to
    the GitHub API content string.
  - `compareBase(repoFullName, base, head) → { behindBy: number,
    aheadBy: number }` — `gh api repos/.../compare/<base>...<head>`.
  - `deleteRef(repoFullName, ref) → void` — `gh api -X DELETE
    .../git/refs/<ref>`.
- `orchestrator/triggers.ts` — pure functions, no side effects:
  - `parseTriggers(body: string, taskTypes: TaskTypeConfig[]) →
    MatchedTrigger | null`. Splits by line, strips lines starting
    with `>` (after optional whitespace), strips lines inside
    triple-backtick or triple-tilde fences (track open/close
    state), and matches each remaining line against each task
    type's hotword (case-insensitive equality after `trim()`).
    Returns the first match or null.
  - `isAuthorized(commenterLogin: string, prAuthor: string,
    allowlist: string[]) → boolean`. True if the commenter is the
    PR author or appears in the allowlist (case-insensitive).
- `orchestrator/prompts.ts` — one function:
  - `resolvePrompt(taskType: TaskTypeConfig, avmHome: string) →
    string`. If `prompt` set, return it verbatim. If `prompt_file`
    set, resolve relative paths against `avmHome` (default
    `~/.avm/`), absolute paths used as-is, read with
    `readFileSync`. Throw `Error` with a clear message if the
    file is missing or both/neither field is set.

### Files

- packages/avm-daemon/src/orchestrator/github.ts (new)
- packages/avm-daemon/src/orchestrator/triggers.ts (new)
- packages/avm-daemon/src/orchestrator/prompts.ts (new)

### Done criteria

- Each module exports its documented functions and is importable
  from `packages/avm-daemon/src/main.ts` without compile errors.
- Manual smoke from a node REPL or temporary script in the
  worktree: `parseTriggers` on a body containing
  `"> /avm update\n\n```\n/avm update\n```\n\n/avm update"`
  returns the match for the third line only.
- `searchIssues({ commenter: <gh user>, updatedSince: '2026-05-01' })`
  returns at least one PR (the spec PR itself, since it has comments
  from this user).
- `resolvePrompt` against the example task type from Task 2's
  example config returns the contents of
  `examples/prompts/update-branch.md`.
- `resolvePrompt` against a config with a missing `prompt_file`
  throws an error whose message includes the resolved absolute
  path.

## Task 5: Polling loop, dispatcher, control comment manager

- [ ] Status

### Scope

Wire the daemon to poll GitHub on a 60-second cadence, register
watched PRs, post and edit per-PR control comments, evaluate
dispatch criteria, and queue tasks in the `tasks` table. Stops
short of running tasks — the dispatcher logs "would dispatch" and
leaves the task row in `status='queued'`. Task 6 makes those
queued tasks actually run.

### Approach

- `orchestrator/poll.ts` exports `startPollLoop(deps) →
  { stop(): Promise<void> }`. Two interleaved loops on a single
  60-second interval (run sequentially each tick, not concurrently,
  to keep ordering simple):
  - **Discovery:** `searchIssues({ commenter: gh user, updatedSince:
    coordinator_state.last_search_watermark })` → for each PR, fetch
    its comments via `listIssueComments`, run `parseTriggers` over
    each comment newer than the watermark. Matched + authorized
    triggers register the PR in `watched_prs` (if not already) and
    hand off to the dispatcher. After processing all matches in a
    cycle, advance the watermark to `now - 1s`.
  - **Per-PR poll:** for each `watched_prs` row, fetch `getPR` to
    detect `isDraft` transitions, fetch comments to detect new
    triggers since `last_polled_at`. Handle draft/ready transitions
    by calling into dispatcher hooks (Task 7 will implement the
    cancellation side; Task 5 only emits the
    re-evaluation/control-comment-status edit).
- `orchestrator/dispatcher.ts` exports `dispatchTrigger(trigger,
  pr, taskType) → 'queued' | 'refused' | 'idle'`:
  - If `pr.isDraft`: refuse; emit 🚫 reaction + control-comment
    "trigger ignored: PR is draft" entry; return `'refused'`.
  - Acquire per-branch lock via `branch_locks` (atomic
    `INSERT OR FAIL`). If already locked: refuse.
  - Evaluate the task type's `auto_trigger` predicate one more
    time at dispatch (so a fast race doesn't queue an unneeded
    task). For `branch-behind-base`, call
    `compareBase(...).behindBy > 0`. For hotword triggers,
    predicate check is skipped (the hotword is the user's
    explicit ask).
  - If predicate false: release lock; control comment "✅ idle (up
    to date)"; return `'idle'`.
  - Insert a task row with `status='queued'`,
    `trigger_kind='hotword' | 'ready-transition'`,
    `task_type=<name>`, `pre_rebase_sha=NULL` (filled by task
    driver later). Emit 👀 reaction. Log
    `daemon: would dispatch task <id> for <repo>#<pr>` (Task 6
    replaces this log with the actual driver invocation).
- `orchestrator/control-comment.ts`:
  - `findControlComment(pr) → IssueComment | null` — scans existing
    comments for the HTML marker `<!-- avm-coordinator:v1 id=... -->`.
  - `createControlComment(pr, initialState) → IssueComment` — posts
    the formatted Markdown from the spec with a fresh ULID and an
    empty backups array.
  - `updateControlComment(commentId, mutator: (state) => state) →
    void` — fetches current body, parses YAML state block, runs the
    mutator, re-renders, PATCHes the comment. Handles the
    "Recent activity" log truncation (keep last ~10 entries).
  - Refuses to edit a comment that does not carry the HTML marker
    (defense-in-depth against picking up a wrong comment).
- Wire `startPollLoop` into `main.ts`: read config; if
  `coordinator.enabled` and the breaker is closed, start it after
  the HTTP server is listening. Register a shutdown hook so SIGTERM
  awaits `stop()` before exiting.
- `Reload` RPC re-reads config and (if `coordinator.enabled`
  changed) starts or stops the poll loop.

### Files

- packages/avm-daemon/src/orchestrator/poll.ts (new)
- packages/avm-daemon/src/orchestrator/dispatcher.ts (new)
- packages/avm-daemon/src/orchestrator/control-comment.ts (new)
- packages/avm-daemon/src/main.ts (modify — start/stop poll loop)
- packages/avm-daemon/src/orchestrator-rpc.ts (modify — implement
  `Reload`)
- packages/avm-daemon/src/db/repos/watched-prs.ts (modify —
  fill in stubs)
- packages/avm-daemon/src/db/repos/tasks.ts (modify — fill in
  stubs for insert / list / update-status)
- packages/avm-daemon/src/db/repos/branch-locks.ts (modify —
  fill in stubs)
- packages/avm-daemon/src/db/repos/coordinator-state.ts (modify —
  watermark read/write)

### Done criteria

- With `coordinator.enabled: true` in config and one
  `update-branch` task type configured, posting `/avm update` on a
  self-owned ready PR results within ~60s in:
  - A 👀 reaction on the trigger comment.
  - A control comment posted on the PR with the HTML marker and a
    valid YAML state block.
  - A row in `watched_prs` for the PR.
  - A row in `tasks` with `status='queued'`,
    `trigger_kind='hotword'`, `task_type='update-branch'`.
  - A daemon log line `would dispatch task <id>...`.
- Posting `/avm update` on the same PR after marking it draft:
  - 🚫 reaction on the comment.
  - Control comment activity log shows
    `trigger ignored: PR is draft`.
  - No new task row.
- A comment whose body is `> /avm update` (quoted) or a
  triple-backtick-fenced `/avm update`: no reaction, no task row.
- A `/avm update` comment from a GitHub user not in `allowlist`
  and not the PR author: no reaction, no task row, no log entry.
- `avm orchestrate status` shows watched_pr_count: 1, running task
  count: 0 (the task is queued, not yet running — Task 6 will
  drive it to running).
- Daemon restart preserves watched_prs / tasks / coordinator_state
  rows; on next boot the poll loop resumes from the persisted
  watermark.

## Task 6: Task driver and classifier

- [ ] Status

### Scope

Execute queued tasks end-to-end through the 10-step docker-exec
choreography from the spec's task-driver section. Classify failures
into `done`, `transient`, `needs-credentials`, `needs-human`,
`unknown` and update task rows, control comments, and reactions
accordingly. Pushes are host-initiated from inside the container
via `docker exec`, with `--force-with-lease=<head>:<pre_rebase_sha>`
on the promote.

The classifier's circuit-breaker action (on `needs-credentials`) is
wired in Task 7; for Task 6 a credential failure marks the task and
moves on, but does not yet trip global polling.

### Approach

- `orchestrator/task-driver.ts` exports `runTask(taskId,
  deps) → TaskResult`. Steps mirror the spec's task-driver
  numbered flow exactly. Each `docker exec` is a separate `$\`...\``
  invocation; multi-line commands use the `$({ input: cmd })\`docker
  exec -i <c> bash -l\`` pattern per CLAUDE.md.
- Step 1 (`avm create`): import `getDockerMountArgs`,
  `registerContainer`, `applyPostCreationSetup` from
  `packages/avm/src/lib/session.ts`. Spawn the container with
  `docker run -d --name avm-coord-<task-id-short> ...
  avm-core:latest sleep infinity` (or whatever the existing
  long-running entrypoint is — read `lib/session.ts` for the
  canonical command). Register via daemon's own
  `registerContainer` function. Apply post-creation setup.
- Step 4 (record `pre_rebase_sha`): persist immediately to the task
  row before any further step.
- Step 5 (backup push): host-initiated docker exec; backup ref
  recorded in `backup_branches` table and appended to control
  comment YAML state.
- Step 6 (agent run): `resolvePrompt(taskType, avmHome)` → passed
  to `claude -p "<resolved-prompt>"`. Wall-time bounded by
  `taskType.timeout` using `AbortController` on the zx invocation.
  On timeout: SIGTERM the container (`docker kill --signal=TERM`),
  wait 10s, SIGKILL; classify result as `needs-human` with
  `notes='timeout exceeded'`.
- Step 7 (read result file): `docker exec <c> cat
  /home/agent/avm-task/result.json`. Missing file or unparseable
  JSON → treat as `{ status: 'failed', notes: 'no valid result
  file' }`. Defense-in-depth: if status reads `'ok'` but
  `head_sha == pre_rebase_sha`, downgrade to `'skipped'`.
- Step 8 (gate re-check): read `branch_locks` row (must still be
  this task's), call `getPR(...).isDraft` (must still be false).
  If either check fails: do NOT promote; set task status
  appropriately (`cancelled` if PR became draft mid-run,
  `failed` otherwise); proceed to step 10.
- Step 9 (promote): `docker exec <c> git push
  --force-with-lease=<head>:<pre_rebase_sha> origin
  HEAD:refs/heads/<head>`. On non-zero exit, classify per stderr
  (e.g., `stale info` → `needs-human` with notes about origin
  having moved).
- Step 10 (clean): wrap container teardown in a `try/finally` so
  `unregisterContainer` + `docker rm -v` runs even on exceptions.
- Throughout: update `tasks.status` at each phase boundary
  (`running` after step 1, `done`/`failed`/etc. after step 9).
  Emit reactions: 🚀 on step 6 entry, ✅ / ❌ at completion.
- `orchestrator/classifier.ts` exports `classify({ exitCode,
  outputLog, stage }) → FailureClass`. Built-in patterns from the
  spec:
  - `transient`: `/network|timeout|ECONNRESET|gh api.* 5\d\d/i` in
    log (and stage was `agent` or earlier).
  - `needs-credentials`: `/not authenticated|invalid api key|credit
    balance|401 unauthorized/i`.
  - `needs-human`: `/conflict|manual|could not/i` from skill output,
    or git push rejection in stage `promote`.
  - Default `unknown` → treated as `needs-human`.
- Wire the dispatcher's "would dispatch" log point to instead
  invoke `runTask` (concurrency-gated by a Promise-based semaphore
  sized at `coordinator.max_concurrent_tasks`).

### Files

- packages/avm-daemon/src/orchestrator/task-driver.ts (new)
- packages/avm-daemon/src/orchestrator/classifier.ts (new)
- packages/avm-daemon/src/orchestrator/dispatcher.ts (modify —
  invoke task driver instead of logging; install semaphore)
- packages/avm-daemon/src/db/repos/tasks.ts (modify — finish-task
  helpers: setRunning, setDone, setFailed)
- packages/avm-daemon/src/db/repos/backup-branches.ts (modify —
  fill in stubs)

### Done criteria

- On a self-owned PR whose base branch is one or more commits
  ahead of HEAD, post `/avm update`. Within ~90s observe end-to-end:
  - 👀 → 🚀 → ✅ reactions on the trigger comment.
  - Container `avm-coord-<task-id-short>` visible in `docker ps`
    during the run; gone after completion.
  - The PR's head branch on origin shows a fresh commit graph
    rebased on its base.
  - A new ref `avm-backup/<head>/<unix-ts>` on origin pointing at
    the pre-rebase SHA.
  - Control comment YAML state shows `last_task.status: done` and
    the backup recorded in `backups[]`.
- Inspect the captured agent log
  (`~/.avm/orchestrator/tasks/<id>/output.log`): the agent never
  ran `git push`. The daemon's own log shows the promote being
  invoked by the task driver.
- When the agent writes `status='skipped'` (or
  `head_sha==pre_rebase_sha`): no promote happens; control comment
  shows "✅ idle (up to date)"; no new commit on origin.
- Manually push something to the head branch from another shell
  during the agent's run: `--force-with-lease` rejects the
  promote; task is marked `failed` with `failure_class='needs-human'`;
  ❌ reaction; control comment surfaces the rejection.
- With `max_concurrent_tasks: 2`, trigger three eligible PRs in
  quick succession: two run concurrently (visible in `docker ps`);
  the third stays queued (👀 only) until one of the first two
  completes.
- Setting `max_concurrent_tasks: 1` reverts to sequential
  behavior: only one container at a time even with multiple queued
  tasks.

## Task 7: Draft/ready cancellation, circuit breaker, sweep, boot reconciliation, README

- [ ] Status

### Scope

Fill in the four remaining behaviors that cross multiple modules,
plus the user-facing README. After this task the v1 feature is
complete and the PR is ready for review.

### Approach

- **Draft → ready/draft transitions** (modify `poll.ts` and
  `task-driver.ts`):
  - On per-PR poll, compare current `getPR().isDraft` to
    `watched_prs.last_seen_state`. If transitioning to draft:
    - Find running tasks for this PR. For each, write
      `tasks.status='cancelled'` with `notes='pr-flipped-to-draft'`
      *before* sending the kill signal.
    - SIGTERM the container; SIGKILL after 10s.
    - Release the branch lock.
    - Update control comment: "⏸ paused (draft)".
  - On transitioning to ready: re-evaluate dispatch criteria for
    each configured task type with
    `auto_trigger='ready-transition'`. If predicate true and no
    queued/running task exists for this branch, enqueue with
    `trigger_kind='ready-transition'`.
  - The task driver's step-by-step status updates already give the
    cancellation handler a stable invariant: at any boundary,
    `tasks.status` reflects what's actually happening.
- **Circuit breaker** (`orchestrator/breaker.ts`):
  - Exports `tripBreaker(reason: string)` and `isOpen() → bool`.
  - `tripBreaker` updates `coordinator_state.circuit_breaker_state
    = 'open'`, `circuit_breaker_tripped_at = now`,
    `circuit_breaker_reason = reason`; calls
    `dispatchNotification(...)` from
    `packages/avm-daemon/src/notifications.ts` directly (no bridge
    round-trip); logs.
  - Wire `tripBreaker(failureClass)` into the task driver's
    classifier path: on `failure_class='needs-credentials'`, trip
    the breaker.
  - `poll.ts` checks `breaker.isOpen()` at the top of each cycle
    and skips polling if open. (Existing poll-loop ticking
    continues — just no work done.)
  - The `Resume` RPC (already implemented in Task 3) clears the
    breaker; next poll cycle resumes work and re-evaluates all
    watched PRs.
- **Daily sweep** (`orchestrator/sweep.ts`):
  - 24-hour `setInterval` started from `main.ts` when the
    coordinator is enabled.
  - For each row in `watched_prs`, fetch `getPR(...).state`. If
    `closed`:
    - Read the control comment's YAML state block; for each
      backup ref, call `deleteRef(repo, ref)`. Tolerate already-
      gone refs (`404`).
    - Append a final entry to the control comment:
      "🏁 PR closed, backups cleaned" with the deleted refs.
    - Delete the row from `watched_prs` (cascades to
      `branch_locks`, `backup_branches` via FK).
  - Belt-and-braces fallback: independently of the per-PR scan,
    list all `avm-backup/*` refs across watched repos older than
    30 days (parse the unix-ts suffix); delete them. Idempotent.
- **Boot reconciliation** (modify `main.ts`):
  - Runs once before the poll loop starts.
  - Find all `tasks` rows with `status='running'`. For each:
    - Check if the named container is still in Docker. If yes,
      something else is wrong (impossible state) — log loudly and
      mark `status='failed-orphaned'`. If no:
      - Mark `status='failed-orphaned'`.
      - Release the corresponding `branch_locks` row.
      - If `tasks.auto_retriggered = 0`: re-evaluate the task
        type's dispatch criteria for this PR. If still applicable
        (e.g., `branch-behind-base` still true), enqueue a fresh
        task with `trigger_kind='boot-recovery'` and
        `auto_retriggered=1`. Append "♻️ boot recovery: queued
        replacement task <new id>" to the control comment.
      - If `tasks.auto_retriggered = 1`: do NOT auto-retrigger.
        Append "❌ boot recovery aborted (already retriggered
        once)" to the control comment; surface
        `failure_class='needs-human'`.
- **README** (`README.md`):
  - New top-level section "## PR coordinator" placed after the
    existing usage sections.
  - Subsections: "Enabling", "Trigger comments", "Draft pauses
    automation", "Backup branches", "Credential failure recovery",
    "Adding a custom task type", "Reference: spec".
  - "Adding a custom task type" walks through editing
    `~/.avm/config.yaml` and dropping a prompt file under
    `~/.avm/prompts/`.

### Files

- packages/avm-daemon/src/orchestrator/breaker.ts (new)
- packages/avm-daemon/src/orchestrator/sweep.ts (new)
- packages/avm-daemon/src/orchestrator/poll.ts (modify — draft/ready
  transitions, breaker check)
- packages/avm-daemon/src/orchestrator/task-driver.ts (modify —
  trip breaker on needs-credentials; honor cancellation flag)
- packages/avm-daemon/src/orchestrator/dispatcher.ts (modify —
  enqueue ready-transition tasks)
- packages/avm-daemon/src/main.ts (modify — boot reconciliation,
  sweep timer)
- README.md (modify)

### Done criteria

- Trigger a long-running update-branch task. Within a few seconds
  of starting (while the agent is running), mark the PR draft from
  GitHub UI. Within 15s observe: container killed; tasks row shows
  `status='cancelled'`; control comment shows ⏸ paused (draft).
  Re-mark the PR ready: a new task is queued
  (`trigger_kind='ready-transition'`) and runs to completion.
- Temporarily invalidate Claude credentials (e.g., move
  `~/.avm/system/claude.json` aside). Trigger update-branch. The
  task fails with `failure_class='needs-credentials'`. Observe:
  breaker tripped (coordinator_state shows
  `circuit_breaker_state='open'`); desktop notification fires;
  next poll cycle does no work. Restore credentials, run
  `avm orchestrate resume`. The next poll cycle re-evaluates and
  dispatches the still-needed update-branch task.
- Close a PR that has at least one backup ref. Force the sweep
  timer to fire (manually call its function via a one-off
  daemon-internal trigger, or restart and wait 24h — implementer's
  choice for verification). Observe: all `avm-backup/*` refs for
  that PR deleted from origin; watched_prs row gone; control
  comment appended with the closure entry.
- Start an update-branch task. While running, `avm daemon
  restart`. On next boot, observe: orphaned task marked
  `failed-orphaned`; lock released; if base branch is still ahead,
  a new task is auto-queued (`trigger_kind='boot-recovery'`,
  `auto_retriggered=1`) and runs to completion. Repeat the
  restart-mid-task — the second orphaned task is reaped without a
  third auto-retrigger; control comment shows the "boot recovery
  aborted" notice.
- README's "PR coordinator" section reads as a standalone
  introduction a user could follow from scratch: enable, write a
  task type, trigger, recover from credential failure.
