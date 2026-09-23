# Normal-startup verification

Verified on 2026-09-22 with Pi 0.87.0, Herdr 0.8.0 protocol 19, and Node 24.18.0 on Linux. This is startup and installation evidence, not a complete ds-mode workflow assessment.

## Checks

All five `npm test` checks passed. They cover transport, adapter state, launch races, automatic startup, lifecycle rebinding, tool selection, package discovery, and headless SDK loading. Native Pi and Herdr operations are stubbed in most of these checks.

A private Herdr server loaded the package through ordinary Pi settings alongside Herdr's unmodified native Pi integration. The checkout was mounted read-only at its actual path. Native checks established:

- Bare `pi` activated the adapter without `DS_HERDR_*` exports or an explicit extension flag.
- `/new` created distinct state. Empty-history `/reload` retained the native UUID with a new adapter generation.
- A lead delegated to an Implement owner, which delegated to Explore. A fresh Review worker used Bash, Git, write, and edit.
- Follow-up recalled a marker without restatement. After closing the owner's pane, cold follow-up retained its worker ID, native UUID, and model, and recalled the marker and child identity.
- Lead reload and process restart retained descendants and the plan. An assigned worker reloaded in the same process without losing its conversation.
- With Herdr activation variables removed, native Pi remained usable for `/new` and `/quit`. Herdr supplied the terminal frontend for this check.
- Tracked fixture files and Git history remained unchanged.

The paid integration phases used 31 provider requests and reported $0.530046. This excludes implementation, independent review, and the outer conversation. There were no adapter turn limits.

The final effective-default config-directory forwarding fix followed the paid phase, which used an explicit config directory. That fix has a red/green regression and real SDK loading coverage. Worker reload passed on the final source.

## Findings and exclusions

The first native empty-history reload exposed a missing-file error. Pi had not flushed its session file. The correction permits only a clean same-process handoff with matching native identity to use the current session context as proof. Cold-worker recovery still requires the original file header.

Controller attempts also exposed terminal-readiness timing assumptions and explicit Herdr `agent_pane_busy` refusals. A minimal standalone PTY driver could start Pi but did not reliably submit commands. Those attempts are not passing lifecycle samples. The real-terminal check above passed without a runtime workaround.

The 20-minute experiment watchdog stopped the private server after the paid scenarios finished. A final status query ran after shutdown and is not an idle-state proof. The latest completed recovery inspection and worker reload showed idle actors. Copied real authentication was removed before shutdown.

Whole-server crash recovery, arbitrary external duplicate session writers, structured human questions, and complete ds-mode fidelity remain unproven or unsupported. This run does not establish a reliability rate or comparative performance.

## Review and records

[Independent review](history/NORMAL-STARTUP-REVIEW.md) found no blocking regressions. The reviewer reran all five checks and independently tested shutdown during a launch.

Private controls, exact diffs, failed attempts, native records, and verification remain at `/home/david/.local/state/pi-subagents-trial/herdr-install-2026-09-22`. Credentials and raw session transcripts are not part of this repository.

## macOS verification

Verified on 2026-09-23 with Pi 0.87.1, Herdr 0.9.1 protocol 22, and Node 24.20.0 on macOS 15.7.7. All seven `npm test` checks passed.

A disposable named Herdr server ran the package through ordinary Pi settings. Herdr's native Pi integration was not installed. Native checks established:

- Bare `pi` activated the adapter. The recorded `pidBirth` used the macOS boot session UUID and `ps` start time.
- Empty-history `/reload` retained the native UUID with a new generation before Pi flushed the session file. `/new` created distinct state.
- A lead delegated to an Implement owner, which delegated to Explore.
- Follow-up recalled a marker. Lead restart and lead `SIGKILL` recovery retained descendants and the plan.
- Opening the lead session in a second Pi process left the live lead's ownership unchanged and did not enable adapter tools in the duplicate.
- Retirement of the leaf and then the owner proved process and socket death and closed both panes. Cold follow-up retained the owner's worker ID, native UUID, model, and thinking, and recalled the marker and child ID.
- Worker `/reload` retained its PID and UUID with a new generation. `interrupt_agent` settled a running task as `interrupted`.
- Pi without Herdr activation variables stayed usable for `/new` and `/quit`.

The first native spawn exposed a macOS-only failure. `herdr agent start` typed the 1097-byte child command into the new pane before the shell left canonical terminal mode. macOS truncated it at 1024 bytes, so the shell never ran Pi and `agent start` timed out. The same command succeeded in a pane given four seconds to settle. The role brief now reaches children through Pi's `appendSystemPrompt` addendum, which reduced the command to about 420 bytes. The failed launches retained their launch claims as designed.

After that change, a native Review worker completed a spawn, a follow-up, and retirement. Its session recorded the role brief once, as the `addendum` section, across both turns. The Linux native run above predates this change. On Linux, the brief previously reached Pi through `--append-system-prompt`, which renders as the same addendum section.

Herdr 0.9.1 sets `HERDR_SESSION` instead of `HERDR_SESSION_NAME`, so the adapter recorded an empty server name for named servers. Routing still targeted the exact captured socket because `HERDR_SOCKET_PATH` takes precedence over both variables. The adapter now reads `HERDR_SESSION`, falls back to `HERDR_SESSION_NAME`, and removes both from every Herdr invocation.
