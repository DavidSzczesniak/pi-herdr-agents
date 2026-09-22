# Adapter protocol

One newline-delimited JSON request and response uses each Unix socket connection. `protocol.ts` owns the wire schemas. `runtime.ts` owns the Linux identity, plan, role, and Herdr receipt helpers. This protocol is private to this prototype and does not migrate old-slice identity records.

## Identity and ownership

An identity records `workerId`, `parentId`, `role`, `herdrSession`, `workspaceId`, `paneId`, `terminalId`, `generation`, `socketPath`, `pid`, `pidBirth`, `piSessionId`, `piSessionPath`, `cwd`, `available`, and `model`.

`model` is the native selected `{provider, id}`, or null when no model is selected. Startup captures `ctx.model`; native `model_select` updates it durably. Cold launch requires a recorded model, passes it explicitly, and verifies the selected model. This avoids Pi's default fallback for sessions without messages. Attempt-1 identity records lack this required field and need a fresh private state directory.

`pid` belongs to the adapter's PID namespace. `pidBirth` combines Linux boot ID and process start ticks. A matching non-zombie process is live. A different birth identifies PID reuse. Unreadable process identity fails closed. `available` alone does not establish liveness.

Every request includes the target's current `generation`, plus the caller's `callerId` and current `callerGeneration`. The caller must be the target or its ancestor. Model tools allow descendants only. The private controller can use a worker's own recorded identity for direct probes. These claims are not authentication against same-UID peers.

Safe IDs match `[a-zA-Z0-9_-]{1,64}`. Worker IDs, task submission IDs, Pi UUIDs, runtime generations, and terminal IDs are separate identities.

## Persisted files

Under `DS_HERDR_STATE_DIR`:

| Path | Content |
|---|---|
| `workers/<workerId>.json` | Current runtime identity |
| `tasks/<workerId>/<submissionId>.json` | Exact task, generation, Pi UUID, state, and result |
| `sockets/<workerId>-<generation>.sock` | Runtime endpoint |
| `sessions/<workerId>.jsonl` | Child's native Pi conversation |
| `plans/<workerId>.json` | Plan with owning worker ID and Pi UUID |
| `operations/*.json` | Launch and outbound submission receipts, including uncertain failures |
| `audit/<workerId>.ndjson` | Events across generations |
| `artifacts/<workerId>-<submissionId>.md` | Full settled assistant text |
| `locks/<workerId>/generation` | Exclusive runtime claim |
| `locks/restart-<oldGeneration>` | Temporary child-startup admission claim |
| `locks/launch-<workerId>/claim.json` | Cross-process pre-launch fence with launch token, previous generation, model, session path, and caller process identity |

Record writes use mode 0600 and atomic rename. Runtime directories use mode 0700. Retired lock directories remain as evidence. Old task and conversation files are not deleted.

## Requests

Each example omits the common caller and target generation fields.

```json
{"kind":"status"}
{"kind":"submit","submissionId":"NEW-ID","task":"Complete brief"}
{"kind":"wait","submissionId":"EXACT-ID","timeoutMs":120000}
{"kind":"interrupt","submissionId":"EXACT-ID","timeoutMs":120000}
{"kind":"reset_pending","submissionId":"EXACT-ID"}
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
| `timeout` | Exact-task wait expired, leaving task active |
| `settled` | Native settlement with idle and outcome evidence |
| `unavailable` | Explicit rejection, process loss, shutdown, or insufficient outcome evidence |

Task records include `workerId`, `generation`, `piSessionId`, `submissionId`, `task`, and `startedAt`. Active tasks also include a random `nonce` and one of these phases:

1. `pending` means the adapter durably reserved the submission.
2. `input_observed` means Pi's input hook saw that exact nonce and task text.
3. `started` means matching `before_agent_start` and `agent_start` occurred.
4. `ambiguous` means the five-second start-observation deadline expired. A later correlated start can still advance this task to `started`.

The native prompt contains `[ds-task <nonce>]` followed by the complete brief. Other input is handled without injection while the reservation is active. Nonce correlation prevents unrelated input from satisfying the reservation.

The adapter refuses known missing model or configured-auth snapshots before `sendUserMessage`. Those records are `unavailable`, and the runtime can accept a different submission immediately. Native asynchronous failures not visible through the extension API remain ambiguous. Idle alone never frees an unresolved preflight.

Settled outcomes are `completed`, `interrupted`, or `error`. `agent_settled` plus idle is required. The captured native run signal or a terminal assistant abort reason establishes interruption. Otherwise, the final assistant error or `agent_before_settle` outcome supplies the result. Missing evidence becomes unavailable.

Public task records replace the brief with an empty string. Settled responses cap JSON at 45000 bytes and point to the full artifact. Model-tool output over 50000 bytes goes to an artifact. `startedAt` is reservation time, not a claim about provider execution.

## Shutdown and recovery

Pending reset marks the exact task unavailable, blocks new work, requests abort, and then requests native shutdown after allowing the receipt to flush. The adapter does not fabricate `interrupted`. A failed shutdown leaves a live process that `followup_task` refuses to replace.

Cold continuation proves all of the following:

- The registry still names the exact previous generation.
- The original PID and birth no longer identify a live writer.
- The old socket is absent or refuses connections. Unknown liveness refuses replacement.
- The original session header matches the saved Pi UUID and exact session path.
- The role, original parent, cwd, named Herdr session, and private workspace match.

The caller first acquires the per-worker launch claim with atomic directory creation, before native Pi can open the session. It repeats death/generation checks under the claim. The child verifies its launch token, session path, and selected model against that claim. Startup separately claims the old generation, repeats the death checks, removes only that dead socket, and retires only a matching old lock. It marks active records from the old generation unavailable. The new runtime keeps worker ID and Pi UUID but receives a new generation, process, pane, and tab. It submits only the new follow-up task. Parent restart leaves descendants intact.

Historical settled or unavailable results remain readable with their original task generation. Old active tasks cannot be matched to the new execution. Historical reads do not clear or wait for a current active task. Interrupt refuses a historical generation.

Failed or cancelled spawn attempts retain a launch receipt. Creation commands finish within their CLI timeout even if the tool aborts, so the adapter can capture exact created identities. Cleanup verifies workspace, tab, and terminal before closing the new pane. Missing receipts or uncertain cleanup remain explicit failures for operator inspection. Successful completed conversations are never closed automatically. The caller releases the launch claim only after live native identity confirmation or proven cleanup. A closed pane without a known native process identity is insufficient cleanup proof after `agent start` was attempted. The claim then remains for operator reconciliation. No automatic retry or stale-claim removal occurs.

Native shutdown releases only its own Herdr report source. Socket and owned-lock cleanup runs in `finally` even if the release command fails. Shutdown cleanup is idempotent.

## Environment and native launch

Every process requires `HERDR_ENV=1`, its actual `HERDR_PANE_ID`, and:

- `DS_HERDR_STATE_DIR`, an absolute private path short enough for Unix sockets.
- `DS_HERDR_SESSION`, the explicit private Herdr session name.
- `DS_HERDR_WORKER_ID` and `DS_HERDR_ROLE`.
- `DS_HERDR_PARENT_ID`, empty only for root `lead` with role `lead`.
- `DS_HERDR_WORKSPACE`, the absolute working directory.

`DS_HERDR_WORKSPACE_ID` is optional for initial launch. Startup derives and verifies it through the exact own pane, never the focused pane. Child launches pass it explicitly and use `tab create --workspace <id> --no-focus`.

A same-worker process restart also requires `DS_HERDR_RESTART_GENERATION` and the original session path. Model-facing `followup_task` supplies these after death proof. The lead's controller uses them for lead restart and must explicitly select the saved provider/model. Manual external Pi launches are outside the adapter's pre-launch fence. Startup rejection alone cannot prevent those processes from writing earlier SDK metadata.

Native arguments include `--no-extensions -e /opt/adapter/index.ts --session <path> --model <provider>/<id>`. Adapter launch also supplies `DS_HERDR_LAUNCH_ID` to match its held claim. Fresh workers select the caller's model and role effort. Lead effort remains launcher-owned. Startup enables configured tools without role bans. `update_plan` uses only its current session identity. `AskQuestion` has no tool implementation; the brief requires a real human answer or explicit stop-and-report.

All Herdr commands use `--session <private-name>`. Reports use source `ds-slice` and Pi session metadata. Reports support presentation and readiness only, never task settlement.
