# Adapter protocol

One newline-delimited JSON request and response uses each Unix socket connection. `protocol.ts` owns the wire schemas. `runtime.ts` owns the process identity, plan, role, and Herdr receipt helpers. This protocol is private to this package. Normal-startup state uses the `v1` namespace and does not migrate earlier prototype directories.

## Identity and ownership

An identity records `workerId`, `parentId`, `role`, `herdrSession`, `workspaceId`, `paneId`, `terminalId`, `generation`, `socketPath`, `pid`, `pidBirth`, `piSessionId`, `piSessionPath`, `cwd`, `available`, `model`, and `thinking`. `herdrSession` captures `HERDR_SESSION_NAME` when available, otherwise an empty string. The socket binding, not this optional name, determines the server.

`model` is the native selected `{provider, id}`, or null when no model is selected. Startup captures `ctx.model`; native `model_select` updates it durably. Cold launch requires a recorded model, passes it explicitly, and verifies the selected model. This avoids Pi's default fallback for sessions without messages. Attempt-1 identity records lack this required field and need a fresh private state directory.

`thinking` is Pi's effective level. Startup captures `pi.getThinkingLevel()` without resetting it. Native `thinking_level_select` writes both the current model and level atomically because Pi emits a model-change clamp before `model_select`. The latter also saves both fields. No status poll is needed to persist a change.

Pre-selection identities with no `thinking` field parse as `thinking: null`; invalid present values are rejected. They remain usable for status, historical results, and live follow-up. A verified reload captures the native value. For cold continuation, a known saved level is authoritative even when Pi has not flushed empty-session metadata. An unknown level requires a native `thinking_level_change` on the original session's active branch. Read-only Pi parsing restores that branch, rejects malformed paths or a conflicting native model, and never opens a SessionManager. The caller repeats the lookup under the launch claim after death proof. With no saved level or native evidence, continuation refuses before tab creation rather than assuming `off` or a role default. Old unresolved launch claims without a thinking field remain fenced for operator reconciliation.

`pid` belongs to the adapter's PID namespace. `pidBirth` combines the boot ID and process start time. Linux uses `/proc/sys/kernel/random/boot_id` and start ticks from `/proc/<pid>/stat`. macOS uses `kern.bootsessionuuid` and `ps` `lstart` with `TZ=UTC` and `LC_ALL=C`. On macOS, only `ESRCH` from `kill(pid, 0)` proves a process absent. macOS start time has one-second resolution, so a false match requires reuse of the same PID within one second. A matching non-zombie process is live. A different birth identifies PID reuse. Unreadable process identity fails closed. `available` alone does not establish liveness.

Every request includes the target's current `generation`, plus the caller's `callerId` and current `callerGeneration`. The caller must be the target or its ancestor. Model tools allow descendants only. The private controller can use a worker's own recorded identity for direct probes. These claims are not authentication against same-UID peers.

Safe IDs match `[a-zA-Z0-9_-]{1,64}`. Worker IDs, task submission IDs, Pi UUIDs, runtime generations, and terminal IDs are separate identities.

## Persisted files

Each ordinary lead uses `$XDG_STATE_HOME/pi-herdr-agents/v1/<key>`, defaulting to `~/.local/state/pi-herdr-agents/v1/<key>`. The SHA-256 key includes the exact Herdr socket path, native Pi session ID, and native Pi session path. Children inherit this directory as `DS_HERDR_STATE_DIR`. Adapter runtime state never goes into the project checkout.

Under that directory:

| Path | Content |
|---|---|
| `binding.json` | Exact Herdr socket path and captured server name, empty when unset |
| `workers/<workerId>.json` | Current runtime identity |
| `tasks/<workerId>/<submissionId>.json` | Exact task, generation, Pi UUID, state, and result |
| `sessions/<workerId>.jsonl` | Child's native Pi conversation |
| `plans/<workerId>.json` | Plan with owning worker ID and Pi UUID |
| `operations/*.json` | Launch and outbound submission receipts, plus generation-keyed retirement evidence, including incomplete outcomes |
| `audit/<workerId>.ndjson` | Events across generations |
| `artifacts/<workerId>-<submissionId>.md` | Full settled assistant text |
| `locks/<workerId>/generation` | Exclusive runtime claim |
| `locks/<workerId>.detached.json` | Generation whose clean shutdown persisted unavailability and finished socket/lock cleanup |
| `locks/restart-<oldGeneration>` | Temporary child-startup admission claim |
| `locks/launch-<workerId>/claim.json` | Cross-process pre-launch fence with launch token, previous generation, model, thinking, session path, and caller process identity |
| `locks/retire-<workerId>` | Retirement fence. `claim.json` binds worker ID, generation, and Pi conversation. `inflight/owner.json` records the caller PID, birth, and lease token. The fence remains on incomplete outcomes. |

Sockets live separately at `<runtimeRoot>/piha-<uid>/<state-directory-hash>/<generation>.sock`. `runtimeRoot` is `XDG_RUNTIME_DIR`, or `/tmp` when unset. Socket paths must fit 103 bytes. Children inherit the exact socket directory. Directories must belong to the current UID, have no group/other permission bits, and not be symlinks. Runtime state paths can be long without lengthening sockets.

Record writes use mode 0600 and atomic rename. Runtime directories use mode 0700. Retired lock directories remain as evidence. Old task and conversation files are not deleted.

## Requests

Each example omits the common caller and target generation fields.

```json
{"kind":"status"}
{"kind":"submit","submissionId":"NEW-ID","task":"Complete brief"}
{"kind":"wait","submissionId":"EXACT-ID","timeoutMs":120000}
{"kind":"interrupt","submissionId":"EXACT-ID","timeoutMs":120000}
{"kind":"reset_pending","submissionId":"EXACT-ID"}
{"kind":"retire"}
```

`submit` persists a reservation before sending. Duplicate IDs are refused across generations. A busy worker refuses concurrent submissions. A transport error after dispatch can leave acceptance unknown. Outbound tool submissions retain their chosen ID in `operations/`; no automatic replay occurs.

`wait` targets one exact submission. Raw socket deadlines range from 1 through 600000 ms. Model `wait_agent` deadlines range from 120000 through 600000 ms. A wait timeout does not interrupt the task. Socket disconnect removes the waiter.

`interrupt` aborts a started task and waits for native settlement. For an unresolved preflight task, it takes the same shutdown path as `reset_pending`. The latter remains available for direct controller probes. The model-facing `interrupt_agent` additionally waits up to 120 seconds for process-death proof.

## Results and evidence

Responses are `{"ok":true,"result":RESULT}` or `{"ok":false,"error":"reason"}`.

| Result kind | Meaning |
|---|---|
| `status` | Current identity, exact active task or null, and Pi idle observation |
| `accepted` | Correlated native `agent_start` observed; `evidence` is `agent_start` |
| `ambiguous` | Durable unresolved submission, not completion; it may still start |
| `reset_requested` | Native shutdown requested, not proof of process death |
| `retire_requested` | Target stopped admitting work and requested native shutdown; not a retired outcome |
| `timeout` | Exact-task wait expired, leaving task active |
| `settled` | Native settlement with idle and outcome evidence |
| `unavailable` | Explicit rejection, process loss, shutdown, or insufficient outcome evidence |

Task records include `workerId`, `generation`, `piSessionId`, `submissionId`, `task`, and `startedAt`. New records also contain `selection`, initially null. Active tasks also include a random `nonce` and one of these phases:

1. `pending` means the adapter durably reserved the submission.
2. `input_observed` means Pi's input hook saw that exact nonce and task text.
3. `started` means matching `before_agent_start` and `agent_start` occurred.
4. `ambiguous` means the five-second start-observation deadline expired. A later correlated start can still advance this task to `started`.

The native prompt contains `[ds-task <nonce>]` followed by the complete brief. Other input is handled without injection while the reservation is active. Nonce correlation prevents unrelated input from satisfying the reservation.

The adapter refuses known missing model or configured-auth snapshots before `sendUserMessage`. Those records are `unavailable`, and the runtime can accept a different submission immediately. Native asynchronous failures not visible through the extension API remain ambiguous. Idle alone never frees an unresolved preflight.

Settled outcomes are `completed`, `interrupted`, or `error`. `agent_settled` plus idle is required. The captured native run signal or a terminal assistant abort reason establishes interruption. Otherwise, the final assistant error or `agent_before_settle` outcome supplies the result. Missing evidence becomes unavailable.

At the first correlated `agent_start`, the worker records `selection: {boundary: "agent_start", model, thinking}` from the handler's native context and thinking API. It persists the observation on the exact task before acknowledging start. Accepted socket receipts carry this additive field. Settlement and historical task reads retain it; later selection changes and retry starts do not replace it. A correlated late start can record an observation for an ambiguous task without replaying the submission.

Model-facing spawn and follow-up receipts retain their flat task fields and add `identity`. Its `model` and `thinking` mirror the task observation returned by the worker, never the caller's status snapshot. Legacy receipts and task records without `selection` remain readable. Missing task evidence, ambiguous submissions, and pre-start rejection report `selection: null` and null identity selection fields. Caller-side transport failures or mismatched receipt IDs retain the chosen submission ID as ambiguous with unknown selection. No automatic replay occurs.

Status responses report current selection in `identity`; old runtime responses without thinking normalize to null. Task selection describes the worker's first correlated start-handler observation, not a guarantee about every provider request. Native changes remain allowed during a task, so later provider attribution can require native session evidence.

Public task records replace the brief with an empty string. Settled responses cap JSON at 45000 bytes and point to the full artifact. Model-tool output over 50000 bytes goes to an artifact. `startedAt` is reservation time, not a claim about provider execution.

## Shutdown and recovery

Pending reset marks the exact task unavailable, blocks new work, requests abort, and then requests native shutdown after allowing the receipt to flush. The adapter does not fabricate `interrupted`. A failed shutdown leaves a live process that `followup_task` refuses to replace.

### Explicit retirement

The model tool `retire_agent({agent_id})` accepts one descendant, never itself or an ancestor. It refuses active reservations, native non-idle or queued input, outstanding child launches, and live or unresolved descendants. It does not abort work. A `status` response includes `queued` and `launching` observations; the target rechecks these conditions in the `retire` request handler and stops admission before requesting `ctx.shutdown()`. The caller does not need model or provider authentication to retire.

The caller holds `locks/retire-<workerId>` while it waits at most 120 seconds for original PID/birth and socket death. The launch claim checks retirement fences on the target and ancestors, both before and after claim creation. The caller scans descendant identities, unresolved tasks, panes, and launch claims before shutdown and again after death. Pending retirement prevents a cold follow-up from opening the old session. `operations/retire-<workerId>-<generation>.json` records retiring, incomplete, or finished evidence. A caller abort, failed shutdown, uncertain death, moved pane, replacement occupant, or failed close returns `state: "incomplete"` with `evidencePath`; acknowledgment alone never reports success. A repeat against an incomplete generation retries only verification and cleanup, not a task. A repeat after a finished generation first removes any stranded matching fence under an exclusive lease; it refuses a live conflicting lease. Only a result with true shutdown, death, and pane evidence can be stored as `finished`. Caller session shutdown waits for outbound retirement to finish or record an incomplete result before it detaches.

After process and socket death, the caller lists panes across the captured Herdr server, not only the saved workspace. It checks both the saved pane ID and terminal ID, then checks the workspace, tab, single-pane count, and process group before closing the exact pane. Cleanup requires affirmative evidence that the foreground group and sole foreground process are the saved pane's shell. A missing, empty, or conflicting foreground observation refuses closure. The caller checks the pane and occupant again before closure, then verifies server-wide pane absence. A proven absent pane also completes retirement. A moved pane or uncertain identity remains incomplete. Cancellation after death and before close leaves the pane untouched. If cancellation or a failed response occurs during close, the caller checks for actual absence, saves that observation in the incomplete record, and permits a later verification-only retry. Native conversation files, settled tasks, selections, plans, and artifacts stay intact. Completed retirement releases the fence so the original worker ID and Pi UUID can cold-resume in a new generation through `followup_task`. No automatic retirement occurs.

Cold continuation proves all of the following:

- The registry still names the exact previous generation.
- The original PID and birth no longer identify a live writer.
- The old socket is absent or refuses connections. Unknown liveness refuses replacement.
- The original session header matches the saved Pi UUID and exact session path.
- The role, original parent, cwd, Herdr server binding, and workspace match.

The caller first acquires the per-worker launch claim with atomic directory creation, before native Pi can open the session. It repeats death/generation checks under the claim. The child verifies its launch token, session path, selected model, and effective thinking against that claim. The caller also checks both selection fields from the live native identity before submitting. Explicit or saved thinking is never silently clamped during continuation. Startup separately claims the old generation, repeats the death checks, removes only that dead socket, and retires only a matching old lock. It marks active records from the old generation unavailable. The new runtime keeps worker ID and Pi UUID but receives a new generation, process, pane, and tab. It submits only the new follow-up task. Parent restart leaves descendants intact.

Historical settled or unavailable results remain readable with their original task generation. Old active tasks cannot be matched to the new execution. Historical reads do not clear or wait for a current active task. Interrupt refuses a historical generation.

Failed or cancelled spawn attempts retain a launch receipt. Creation commands finish within their CLI timeout even if the tool aborts, so the adapter can capture exact created identities. Cleanup verifies workspace, tab, and terminal before closing the new pane. Missing receipts or uncertain cleanup remain explicit failures for operator inspection. Successful completed conversations are never closed automatically. The caller releases the launch claim only after live native identity confirmation or proven cleanup. A closed pane without a known native process identity is insufficient cleanup proof after `agent start` was attempted. The claim then remains for operator reconciliation. No automatic retry or stale-claim removal occurs.

A child whose own startup fails writes `operations/startup-failed-<launchId>.json` with its error, PID, and birth before it requests shutdown. The caller polls for that record while `agent start` waits and stops waiting as soon as it appears, so the launch fails in about a second with the child's reason instead of Herdr's readiness timeout. The caller gives that process up to three seconds to exit before it closes the pane.

Before closing a pane after `agent start` was attempted, the caller records the pane's shell and foreground processes with their births in the receipt's `processes`. With no identity for the new pane, the failure record and those processes are the process proof. Once all of them are dead, the caller releases the claim. Otherwise the claim stays.

`retire_agent` also accepts a fresh worker that never registered an identity. It requires an owned fresh launch claim, a `failed` launch receipt with its exact pane, at least one recorded process, all recorded processes dead, and neither that pane nor its terminal in `pane list`. Renaming the claim directory is the single commit point, so a concurrent retirer or the caller's own release finds nothing to take. It records `operations/retire-<workerId>-launch-<launchId>.json`. A late child cannot register afterwards, because startup requires the claim.

Native shutdown first stops admission and waits for outstanding bounded launch operations to finish or clean up. It marks its active task unavailable and releases only its own Herdr report source. Socket and owned-lock cleanup runs in `finally` even if the release command fails. Shutdown cleanup is idempotent.

### Ordinary lead lifecycle

Pi 0.87 emits `session_shutdown` for quit, reload, new, resume, and fork. Replacement and reload create a fresh extension instance before `session_start`. The adapter follows those events rather than scheduling session transitions. Roots do not cancel session operations. `/tree` keeps the same session-wide plan and descendant registry. A fork or clone has a different native session ID/path and therefore starts a new registry.

Clean shutdown writes a detached-generation receipt only after persisting `available: false`, closing the socket, and releasing the generation lock. Normal lead resumption accepts that receipt only for the current recorded generation, absent lock, dead socket, and matching role, parent, workspace, cwd, native UUID, and session path. A same-PID/birth handoff uses the native session manager's matching identity even if Pi has not flushed an empty conversation file yet. A different process must verify the native file header. Without the receipt, the original process and socket must be proven dead through the existing cold proof. `available: false` alone is never enough.

Normal root resumption takes the model selected by Pi, including explicit user model changes. Cold worker continuation still requires the saved model and verifies it against the launch claim. A duplicate active root disables only the new adapter. Startup cannot prevent external Pi processes from opening the native session before extension initialization.

Workers cancel switch, fork, and tree-navigation events to keep their assigned conversation history. A worker reload can bypass its now-released initial launch claim only after a clean detach by the same PID/birth, with matching session, model, and recorded thinking when known. It receives a new runtime generation and never replays an active task. A failed owned-child startup may request native shutdown.

## Claude Code workers

Claude workers cannot run this extension or serve a socket, so the caller owns all their state under `claude/<workerId>/` in its state directory:

| Path | Content |
|---|---|
| `launch.json` | Launch receipt: `creating`, `created` (with the raw tab response), `started`, or `failed` (with error and cleanup) |
| `worker.json` | Worker ID (`c` prefix), parent, role, `runtime: "claude"`, model, effort, cwd, workspace, tab, pane, terminal, launch ID, `open` or `closed`, and the single task |
| `brief.md` | The complete brief |
| `settings.json` | The adapter's hooks, passed with `--settings` |
| `launch.sh` | The exec line Herdr runs |
| `hooks/<Event>-<epoch>-<pid>.json` | One immutable file per hook invocation, written by `claude-hook.sh`. It is a plain `sh` script, so hooks need no interpreter path. |
| `lock` | Per-worker transition lock |

**Launch.**
- The quoted `exec '<dir>/launch.sh'` line must stay under 1024 bytes. Otherwise the launch is refused before any tab exists.
- The receipt is written before `tab create`. Creation finishes even when the caller aborts, so the exact pane is known for cleanup.
- The script unsets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `CLAUDE_CODE_OAUTH_TOKEN`. It also unsets the `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` provider selectors, so the session uses the Claude login. It then runs:

  ```text
  claude --setting-sources '' --settings <settings> --strict-mcp-config
    --disallowed-tools Agent,Task,AskUserQuestion --append-system-prompt <role brief>
    --add-dir <dir> --permission-mode bypassPermissions --model <m> --effort <e>
    -- <brief>
  ```
- `--` ends option parsing, so a brief that starts with `-` stays task text.
- A brief over 120,000 bytes is replaced by a pointer to `brief.md`, because Linux caps one argument at 128 KiB.

**Acceptance.**
- The first `UserPromptSubmit` record must arrive within 60 seconds. It records the Claude session ID and transcript path.
- While waiting, the adapter reads the pane's visible screen every five seconds, and a trust dialog fails the launch immediately.
- Any launch failure closes the exact created pane and records the task unavailable. An unknown tab-creation outcome stays explicitly uncertain in the receipt.

**Settlement.**
- Results come from hook evidence correlated by the accepted session ID, not by file order. The first `Stop` gives `completed` with `last_assistant_message`, `StopFailure` gives `error`, and `SessionEnd` gives `unavailable`. Later turns never replace the first result.
- The launch execs Claude as the pane's only process, so the pane's terminal lives exactly as long as Claude does. Pane and terminal identity therefore stand in for process identity.
- Absence comes from a server-wide `pane list`, never a failed lookup. Herdr gives a moved pane a new ID, so the adapter matches by pane ID or terminal ID. A moved or replaced pane is "changed", which is neither absent nor closable.
- A pane found absent with no terminal evidence settles `unavailable`, or `interrupted` when an interrupt intent is recorded. Settlement uses the evidence present when the pane is found absent. The pane disappears only after its `claude` process has ended, so hook evidence finishing later is not considered. Waits reconcile pane presence at their start and every ten seconds.
- Transitions run under the per-worker lock and never replace a settled result. A result that arrives during an interrupt's close wins over `interrupted`.
- Session shutdown aborts sleeping Claude waits and stops admitting new tool calls. It lets tracked launches, interrupts, and retirements record their outcomes, then detaches. After detachment, every transition refuses, so a stale runtime never writes.
- Error reasons are capped at 4,000 characters.
- The full final text goes to `artifacts/<workerId>-<submissionId>.md`, and responses cap it as Pi results do. A wait timeout leaves the task active.

**Closing.**
- Interrupt and retirement close only the exact pane with `pane close`, and only while a server-wide `pane list` shows the recorded pane, terminal, workspace, and tab. They then verify through the same listing that the pane is absent.
- An interrupt records its intent before closing. A pane found absent with that intent, and no terminal evidence, settles `interrupted`, whether the interrupter is still running or died between closing and recording.
- An absent pane counts as closed. Retirement refuses an active task.
- Launches, interrupts, and retirements are tracked with Pi launches and retirements, so session shutdown waits for them.
- A Pi descendant's retirement refuses while it owns a Claude child that is open or active, or whose launch did not fail cleanly. A failed launch with uncertain cleanup, such as a lost tab-creation response, keeps blocking until an operator reconciles it.
- There are no follow-ups, nested workers, or cold continuation.

## Environment and native launch

The installed package autoloads through its `pi.extensions` manifest, which names only `index.ts`. Extension construction captures configuration without creating background resources. Activation happens only in `session_start` when `ctx.mode === "tui"`, `HERDR_ENV=1`, and Pi has a persistent session path. Other modes and ephemeral sessions create no adapter resources, tools, host-binding instructions, or session guards.

An ordinary lead needs native `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. Startup validates its exact pane and `HERDR_WORKSPACE_ID` when present. The server name is optional. Herdr 0.9 sets it in `HERDR_SESSION`, and Herdr 0.8 used `HERDR_SESSION_NAME`. The adapter reads `HERDR_SESSION` first. Herdr omits the name for the default server, so the socket remains authoritative. Missing or invalid Herdr metadata disables the adapter with a TUI notification. Ordinary Pi remains usable and its selected tools are unchanged.

Configuration is per extension instance. The adapter never modifies `process.env`. Every Herdr invocation uses argv-safe `env -u HERDR_SESSION -u HERDR_SESSION_NAME HERDR_SOCKET_PATH=<captured-path> herdr ...`. Herdr 0.9 routes by `HERDR_SESSION` when no socket path is set, so removing both keeps routing independent of Herdr's precedence rules. It does not pass `--session`, which could redirect the request away from the pane's actual socket. This handles both default and named servers without guessing their names or discovering a focused session.

The adapter supplies internal child variables through `tab create --env`:

- `DS_HERDR_STATE_DIR` and `DS_HERDR_SOCKET_DIR`, the shared private durable and socket directories.
- `DS_HERDR_SESSION`, the captured server name, empty for the default server. The adapter also sets `HERDR_SESSION` and `HERDR_SESSION_NAME` to this value.
- `DS_HERDR_WORKER_ID`, `DS_HERDR_ROLE`, and `DS_HERDR_PARENT_ID`.
- `DS_HERDR_WORKSPACE`, the absolute child cwd, and `DS_HERDR_WORKSPACE_ID`. Spawn canonicalises the cwd and refuses a missing directory before any claim or tab. The child compares canonical paths, because Pi reports the real directory and macOS `/tmp` is a symlink.
- `DS_HERDR_RESTART_GENERATION`, empty for a fresh child.
- `DS_HERDR_LAUNCH_ID`, matching the caller's held launch claim.

Children also receive the captured Herdr socket/name and an absolute `PI_CODING_AGENT_DIR` resolved with Pi's `getAgentDir()` during extension construction. This pins the lead's effective default even when the lead has no config-directory export and the Herdr server has a different environment. When set, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, and `PI_CACHE_RETENTION` are forwarded too. No credentials or parent transcript are copied. The child uses its normal Pi config files and Herdr-created pane environment. Environment-only credentials and unrelated provider extensions are not forwarded by the adapter.

Child creation uses `tab create --workspace <id> --cwd <cwd> --no-focus`. Native arguments include `--no-extensions -e <installed-index-path> --session <path> --model <provider>/<id> --thinking <level>`. The extension path derives from `import.meta.url`, not the working directory. Herdr types this command into the new pane, and it can do so before the shell leaves canonical terminal mode. macOS truncates canonical input at 1024 bytes, so the shell never runs the command. Each child therefore appends its role brief to Pi's `appendSystemPrompt` in `before_agent_start`, not through a launch argument. Pi renders that addendum even when `SYSTEM.md` replaces the default prompt. The adapter refuses a launch whose quoted command would reach 1024 bytes on any platform. The refusal happens before any launch claim, session file, or tab exists. Shorten the extension install path or `XDG_STATE_HOME` to fix it. Children load only this extension, with normal built-in and delegation tools. Spawn requires `role`, `thinking`, and `task` and accepts optional `model: {provider, id}`. Omitted model inherits the immediate caller's native selection. Missing or invalid thinking fails schema validation. The supplied level must occur in Pi's `getSupportedThinkingLevels` for the exact registry model and is passed unchanged. The runtime has no role-to-level mapping or omitted-thinking fallback. Registry and configured-auth snapshot checks run before allocation. These checks do not prove remote credentials valid or copy process-only credentials/provider extensions into the child. The native child must still match the launch claim. The lead retains its selected tools and thinking. Pi's dynamic registration respects lead tool allowlists and exclusions.

`/herdr-agents` reports the current worker/session, durable state path, and enabled adapter tools, including `retire_agent` when selected. `update_plan` uses only its current session identity. `AskQuestion` has no implementation. The brief requires a real human answer or explicit stop-and-report.

Reports use source `ds-slice` and Pi session metadata. Herdr's managed native integration remains separate. Reports support presentation and readiness only, never task settlement. Whole-server restart recovery and automatic reconciliation of uncertain launch claims are outside this contract.
