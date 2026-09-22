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
