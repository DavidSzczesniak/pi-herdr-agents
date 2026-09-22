# Independent review

## Verdict

Pass. No blocking regressions found in the staged startup, lifecycle, packaging, or deployment changes. The authorized global migration may proceed using the contract's backup, supported Pi CLI, fresh-start verification, and private-process cleanup steps. This review did not change the global installation.

Reviewed baseline `61488c474db7a0089af40b8bfc18e00c9a41e658`. The staged diff matched `DIFF.patch` before and after review, SHA-256 `aba37807c89e7d903b9af823d29416ee6b16cfde42375f5a24ad2e9ab5a94827`.

## Findings

No required implementation corrections.

One nonblocking test improvement: retain a focused shutdown-during-launch regression in the repository suite. The new admission checks and outstanding-launch tracking passed my independent probe, but the existing suite does not directly hold tab creation across shutdown. The reviewer-only probe is `evidence/reviewer-launch-shutdown.mjs`. It verifies that shutdown waits, native worker startup never occurs after admission closes, the exact created pane is closed, the launch claim is released after proven pre-start cleanup, and the root detaches. This used stub Pi/Herdr commands and real files, a Unix socket, and process identity. It ran no models or Herdr commands.

## Verification examined

- Read the task contract, repository rules, complete diff, README, protocol, and verification record. Consulted local Pi 0.87 extension, package, and environment documentation, dynamic-tool example, and runtime source for lifecycle, dynamic registration, command lookup, tool selection, and config-directory resolution.
- Independently reran `npm test`. All five checks passed. `git diff --cached --check` passed. Implementation files remained unchanged.
- Read `startup-lifecycle.json`, `integration.json`, `recovery-preflight.json`, `recovery.json`, `worker-reload.json`, `isolated-package-migration.json`, and `npm-test.txt`.
- Cross-checked native audit events and worker transcripts against the reported ownership and tool activity. The review worker actually called Bash/Git, write, and edit. The implementation worker spawned and waited for its own explore child. Warm and cold follow-ups retained the original worker conversation. Worker reload retained PID, native UUID, and model while changing runtime generation.
- Read the additional final-source `outside-environment-native.json`. With activation variables removed, native Pi accepted `/new` and `/quit`. This used Herdr only as the terminal frontend. The standalone PTY command-driving attempts remain excluded from passing evidence.

## Contract assessment

Activation is deferred to persistent TUI session startup. Outside-Herdr, headless, RPC, and ephemeral paths remain inert. Ordinary lead failures leave Pi usable. Root session changes follow Pi's documented replacement lifecycle. Worker session guards remain in place.

The manifest names only `index.ts`. Child launches derive that entrypoint from the installed package, target the captured socket and exact pane/workspace, and inherit the effective Pi config directory. Durable state is conversation-specific and separate from short private socket paths. Root tool selection is not overwritten. Workers retain normal tools and nested delegation.

The changes preserve generation/task correlation, explicit ownership, cold-worker death and model checks, launch claims, and refusal to replay ambiguous submissions. No scheduler or worker turn ceiling was introduced.

## Evidence limits and installation conditions

The paid native phase used explicit `PI_CODING_AGENT_DIR`. Effective-default forwarding was added afterward and is supported by the final regression test and SDK-loading checks, not a later paid native delegation. Final-source worker reload and outside-activation native checks supplement that evidence.

The isolated package migration demonstrates successful supported CLI removal, local installation, and package listing. It does not replace backing up and verifying the actual global settings, preserving unrelated configuration and skills, or checking fresh global startup. Confirm private-process cleanup on the final outcome. Copied authentication removal was reported by the implementer; I did not read credential files.

No full ds-mode fidelity claim, whole-server crash-recovery claim, or protection against arbitrary external duplicate session writers is implied.
