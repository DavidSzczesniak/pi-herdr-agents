# Final independent runtime review

Verdict: both previous findings are closed. No material runtime blocker found before the supervised journey. No additional fix requested. This is not full-journey acceptance.

This fresh review covers `control/CONTRACT.md`, repository `AGENTS.md`, the complete `RUNTIME-DIFF.patch`, current runtime sources, changes from `attempt-1/prototype`, and completed verification. Implementer rationale was withheld. Paths below are relative to this trial directory unless absolute.

## P1 closed: claim before native session open

`prototype/runtime.ts:12-24` acquires an exclusive per-worker directory claim. `prototype/index.ts:467-493` acquires it before tab creation and `agent start`, then repeats generation/death checks while holding it. Child startup validates the launch token, previous generation, session path, and selected model. The caller releases only after live identity confirmation or proven cleanup. Unconfirmed startup with uncertain cleanup retains the claim and blocks another launch. After readiness, the recorded process identity and existing death checks prevent replacement of a live writer.

`prototype/launch-race-check.mjs` runs two real authorized ancestor processes. Only one reaches the stubbed native session-open boundary. The loser receives `EEXIST` without appending metadata. The test also verifies claim retention after uncertain cleanup. This establishes cross-process exclusion at the required boundary, not native Pi race coverage.

The explicit exclusion of manual external `pi --session` launches in `prototype/README.md` and `prototype/PROTOCOL.md` is appropriate.

## P2 closed: preserve the pending worker's model

`prototype/protocol.ts:9-15` persists provider/model identity. `prototype/index.ts:264-279,328-333,460-498` captures native selection, tracks model changes, passes the recorded model explicitly on revival, and rejects a mismatch.

`evidence/final-owned-pending.json`, `final-recover.json`, and `final-model-restore.json` establish same worker and Pi UUID, a new generation, original-process death, and preserved `openai-codex/gpt-6-astra`. I checked the referenced native JSONL and audit under `/tmp/dsh2.1cfd6s_5/current/`. There are no messages before revival. The old pending task becomes unavailable without a provider request. Only the new submission executes. Native tool results confirm Review's Git commands, passing checks, and scratch-file creation, read, and removal.

## Verification and limits

All source hashes match `runtime-verification.json`. I reran `check`, `transport-check`, `adapter-check`, and `launch-race-check`; all passed.

Older ownership, cold-follow-up, and monitor evidence remains version-scoped. It predates these launch/model fixes and does not constitute a completed journey. All roles intentionally retain normal tools. Ownership checks are not a malicious same-UID security boundary. Unknown acceptance never triggers automatic replay; unresolved launch claims require operator inspection.

No live Herdr/model controls, credential reads, installations, or implementation edits were performed. The journey remains unstarted.
