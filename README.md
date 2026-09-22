# Pi Herdr agents

A Pi extension that hosts delegated Pi workers in Herdr tabs. It provides `spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, `interrupt_agent`, and `update_plan`.

## Current status

This repository preserves the reviewed hardening prototype. **It is not installed in Pi and is not ready for ordinary autoload.** Starting a new Pi session does not enable it.

Native trials used a private Herdr server, private Pi configuration, explicit `DS_HERDR_*` environment variables, and this source mounted at `/opt/adapter`. Child startup still references `/opt/adapter/index.ts`. Loading `index.ts` without that setup fails its startup checks and can shut down the Pi session. Do not globally install it yet.

The next integration work is a normal startup path that locates this checkout, initializes session-owned state, and attaches to the intended Herdr workspace. Switching away from the currently installed Gotgenes package is a separate, explicitly authorized installation change.

Tested native versions were Pi 0.87.0, Herdr 0.8.0 protocol 19, and Node 24.18.0 on Linux. The broad peer dependency declarations follow Pi's package convention; they are not compatibility claims for other versions.

## Development checks

Install the pinned development dependencies, then run all four checks:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The dependency lockfile makes this checkout independent of the earlier prototype's dependency symlink.

Transport checks use real Unix sockets. Adapter checks use real files, sockets, and Linux process identities but stub Pi lifecycle events and Herdr commands. The launch-race check uses two real processes with a stubbed native session-open boundary. These checks launch neither Herdr nor models.

## Runtime contract

Workers start fresh conversations and own their descendants. A task receipt requires a correlated native start event. Bounded waits do not cancel work. Interruption and cold continuation retain exact task, worker, process, and conversation identities. Ambiguous submissions are not automatically replayed.

Every role has normal tools, including Bash, Git through Bash, edits, writes, and delegation. A read-only review is a task instruction to report findings without applying implementation fixes. It is not a reduced tool profile.

Each worker owns its plan and gets a separate Herdr tab. Plans and task records persist locally. See [the protocol](PROTOCOL.md) for environment requirements, state files, recovery behavior, and limits.

The adapter does not protect workers from malicious peers sharing their UID. It does not support arbitrary external writers opening the same Pi session, session switching, reload, or automatic reconciliation of uncertain launch claims. A whole-server restart is not an accepted recovery case.

## Evidence and provenance

The native hardening checks passed independent runtime review. One ds-mode bug-fix journey produced a correct fix and passed 32 external checks, but its workflow assessment was partial because the lead skipped prescribed skill steps.

See [provenance and review records](docs/provenance.md). This repository contains source, checks, and review summaries, not credentials or raw session transcripts. The original trial archive remains separate and unchanged.

This is a local Git repository. No remote backup or publication is configured.
