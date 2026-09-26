# Pi Herdr agents

A Pi extension that hosts delegated Pi workers in Herdr tabs. It can also host one-shot Claude Code workers. It provides `spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, `interrupt_agent`, `retire_agent`, and `update_plan`.

## Current status

Normal startup is available for supervised dogfooding. Focused native checks and independent review passed. See [the startup verification record](docs/normal-startup-verification.md) for coverage and limits. Cloning this repository does not install it.

Once installed, ordinary `pi` in a Herdr pane activates the adapter automatically. The lead needs no `DS_HERDR_*` exports, explicit extension flag, source mount, or private launcher. Pi outside Herdr, print mode, JSON mode, RPC, ordinary SDK use, and `--no-session` stay inert. Activation requires `ctx.mode === "tui"` and a persistent native session. RPC's `hasUI` flag is not an activation signal.

The integration targets Linux and macOS. It was verified with Pi 0.87.0, Herdr 0.8.0 protocol 19, and Node 24.18.0 on Linux, and with Pi 0.87.1, Herdr 0.9.1 protocol 22, and Node 24.20.0 on macOS. Development dependencies are pinned. Broad peer declarations follow Pi's package convention and do not claim compatibility with other versions.

## Install or remove the package

From inside the cloned repository, run:

```sh
pi install .
```

Pi registers the checkout in your personal settings without copying it. Keep the checkout available. You do not need to run the command from outside the repository or supply an absolute path.

Alternatively, install directly from Git without cloning manually:

```sh
pi install git:github.com/DavidSzczesniak/pi-herdr-agents
```

Pi manages the checkout for a Git installation. Choose one installation method.

The package manifest loads only `index.ts`, never test fixtures. Restart Pi or use `/reload` after installation. Start ordinary `pi` in a Herdr pane to use the extension. The active tools include the adapter tools unless your tool allowlist or exclusions disable them. Run `/herdr-agents` to inspect adapter identity, state path, and enabled tools.

Remove or disable the previous delegation package before loading this one to avoid competing delegation tools. Use `pi list` to find its exact source, then `pi remove <source>`. This repository does not perform that migration.

To remove a local installation, run this from the same checkout:

```sh
pi remove .
```

For a Git installation, run:

```sh
pi remove git:github.com/DavidSzczesniak/pi-herdr-agents
```

Restart Pi or use `/reload` after changing packages. Removal does not close workers or delete their state. Finish or explicitly stop owned workers before removal. Leave Herdr's managed `herdr-agent-state.ts` integration installed. This adapter uses its own report source and does not edit that file.

## Runtime behavior

Each native lead conversation owns a separate private directory under `$XDG_STATE_HOME/pi-herdr-agents/v1`, or `~/.local/state/pi-herdr-agents/v1`. The key includes the exact Herdr socket, native Pi UUID, and native session path. Runtime files never go into the project checkout.

Unix sockets use a short directory under `$XDG_RUNTIME_DIR`, or `/tmp` when unset. A long durable state path is supported. An overlong runtime socket path disables the adapter with a notification. Use a short `XDG_RUNTIME_DIR` in sandbox environments where `/tmp` is not shared with children.

All Herdr commands target the captured `HERDR_SOCKET_PATH`. Startup verifies the actual `HERDR_PANE_ID` and workspace. Default and named servers are supported. No command falls back to the focused pane.

Workers start fresh conversations and own their descendants. Children receive their complete task brief, not parent conversation history. They use the installed extension's actual path and normal tools, including Bash, Git through Bash, edits, writes, and nested delegation. A read-only review is an assignment, not a reduced tool profile. The lead retains its selected tools and thinking level.

### Worker model and thinking

`spawn_agent` requires `role`, `thinking`, and `task`. Optional `model: {provider, id}` must match Pi's registry exactly. Omitted model inherits the immediate caller's current native model, including on nested spawns. The runtime does not map roles to thinking levels. ds-mode's profile table supplies the explicit levels.

`thinking` accepts Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` levels, but only when the selected model supports that level. Missing or invalid thinking, unsupported levels, unknown models, and missing configured authentication are rejected before creating a session, launch claim, or tab. The runtime passes the supplied level unchanged.

Spawn and follow-up keep their existing flat task receipts. `selection` records `{boundary: "agent_start", model, thinking}` observed by the worker's first correlated `agent_start` handler. The receipt's `identity.model` and `identity.thinking` mirror that observation, not an earlier or later status poll. Missing legacy evidence, ambiguous submissions, and tasks rejected before start report `selection: null` and null identity selection fields.

`list_agents` reports the worker's current selection instead. Later native changes and retry starts do not rewrite a task's first observation. This observation does not establish the settings used for every provider request. Native session evidence is needed for attribution when settings change during a task. It says nothing about upstream router substitutions or comparative performance.

Follow-up has no overrides. It keeps the worker's selection, including native `/model` and `/thinking` changes, through reload and cold continuation. The lead's model, thinking, and tools stay unchanged.

Pre-change worker records remain readable with `thinking: null` until observed by the new runtime. Reload captures the native level. Cold continuation can recover it from the original session's active branch when a native thinking entry exists; otherwise it refuses to guess. Existing ownership, session-header, death, and launch-claim checks still apply.

Child launches explicitly inherit the caller's effective Pi config directory, including the default when no override is set, and selected non-secret Pi startup settings. They load only this extension. Skills, context files, settings, and file-based authentication use normal Pi discovery. Other extensions and credentials supplied only to the lead process are not copied into children.

`retire_agent({agent_id})` explicitly retires one idle descendant. Retire leaf workers before parents. It refuses active or queued work, unresolved launches, and live or unresolved descendants. Native shutdown acknowledgment is not success: the operation proves the original process and socket dead, checks the exact workspace, terminal, tab, and occupant, then closes only the owned pane or verifies its absence. Incomplete outcomes retain a durable fence and evidence path for safe cleanup retries. Retirement does not delete the native conversation, task results, model, thinking, plans, or artifacts. `followup_task` cold-resumes a completed retirement as the same worker and Pi conversation with a new generation and only a new submission. A fresh worker that never started, with no identity and only a failed launch claim, retires once its exact pane is gone. There is no automatic retirement.

A task receipt requires a correlated native start event. Bounded waits do not cancel work. Interruption and cold continuation retain exact task, worker, process, model, and conversation identities. Ambiguous submissions are never automatically replayed. There are no adapter turn ceilings.

### Claude Code workers

`spawn_agent` with `runtime: "claude"` starts a one-shot Claude Code leaf worker instead of a Pi child. Use it for work that should run on a different model family, such as independent review, under the user's own Claude Code login. Claude Code must be installed and signed in. Its executable resolves from the lead's `PATH`, or from an absolute `PI_HERDR_CLAUDE_BIN`.

- **Session.** The worker is ordinary interactive `claude` in its own tab.
  - The session is isolated:
    - `--setting-sources ''` skips user, project, and local settings files, so personal hooks, permission rules, and plugins do not load.
    - `--strict-mcp-config` excludes MCP servers.
    - CLAUDE.md context and user skills still load, as Pi children load context files and skills.
  - API-key variables are unset so the session uses the Claude login.
  - The worker has normal tools with `--permission-mode bypassPermissions`, the counterpart of Pi workers' normal tools. A read-only review is an assignment. Claude's own `Agent`, `Task`, and `AskUserQuestion` tools are disabled, and the worker gets the same "no human watches, stop and report" brief as Pi children.
- **Model and effort.** `model.id` names a Claude model, defaulting to `claude-opus-5-5`. `thinking` is Claude's effort: `low`, `medium`, `high`, `xhigh`, or `max`. Other levels are rejected before launch.
- **Evidence.** Adapter hooks record it:
  - `UserPromptSubmit` is acceptance.
  - The first `Stop` of that session completes with its final message.
  - `StopFailure` is an error.
  - `SessionEnd` without a result, or a pane that disappears without a result, is unavailable, unless an interrupt closed it, which makes it interrupted.
- **Tools.** `wait_agent`, `list_agents`, `interrupt_agent`, and `retire_agent` work on the worker.
  - `interrupt_agent` and `retire_agent` close only the worker's exact pane, never other panes in its tab.
  - A result that arrived before an interrupt's close is kept.
  - Retirement refuses active work.
  - Results, artifacts, and the Claude transcript path stay recorded.
  - A Pi worker with an open or active Claude child cannot be retired until the child is retired.
- **Limits.** Claude workers cannot spawn workers or take follow-ups. `followup_task` is refused, so spawn a fresh worker with a complete brief.
- **Trust.** Claude Code keys folder trust to the repository. The adapter never answers the trust dialog. It fails the launch at once, with an instruction to open `claude` in that repository once and trust it.

## Session lifecycle and recovery

The lead can use `/new`, `/resume`, `/fork`, `/clone`, `/tree`, and `/reload`. Pi's documented shutdown/start lifecycle detaches the old runtime and binds the replacement to its native conversation. Descendants remain in their tabs. Returning to the same session restores its descendants and latest session-owned plan. A fork gets a new adapter state directory. Plans and descendants are session-wide, not branch-local, so `/tree` does not rewind them.

A clean shutdown records a detached generation after closing the socket and removing its runtime lock. Reload and same-process resume can reclaim that generation, including an empty native session that Pi has not flushed to disk. After a crash, resumption instead requires proof that the previous PID/birth and socket are dead. An active duplicate owner disables the new adapter without shutting down the user's Pi. External duplicate native session opens can still write Pi metadata before extension initialization and remain outside the ownership guarantee.

Workers cannot switch, fork, or navigate away from their assigned conversation history. Worker `/reload` can rebind only after a clean same-process detach. It never replays a task. Child startup failures may request native shutdown. Ordinary lead startup failures notify the user and leave Pi usable without adapter tools.

See [the protocol](PROTOCOL.md) for state files, correlation, launch fences, recovery proofs, and internal child configuration.

## Development checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Transport checks use real Unix sockets. Adapter and startup checks use real files, sockets, and process identities but stub TUI events and Herdr commands. The Claude check runs the real launch script, settings, and hook against a fake `claude` executable with Herdr stubbed. Startup checks also exercise real Pi package discovery and headless SDK binding. The launch-race check uses two real processes with a stubbed native session-open boundary. Selection checks use Pi's installed catalog, capability helpers, and SDK model/thinking events and empty-history reload, with Herdr controls and provider turns stubbed. The retirement check uses separate real processes and Unix sockets with stubbed Pi and Herdr controls. It covers original-conversation cold continuation and retained historical results without a provider turn. These checks launch neither Herdr nor models. Native lifecycle verification requires a disposable Herdr server and ordinary package autoload.

## Limits and evidence

On macOS, process identity has one-second start-time resolution, and the adapter refuses a child launch command of 1024 bytes or more. See [the protocol](PROTOCOL.md) for both limits. The adapter does not protect against malicious peers sharing its UID. Whole-Herdr-server crash recovery and automatic reconciliation of uncertain launch claims are unsupported. Structured `AskQuestion` is not implemented. Workers stop and report genuine human questions instead of answering them.

The historical hardening checks passed independent runtime review. One ds-mode bug-fix journey produced a correct fix and passed 32 external checks, but its workflow assessment was partial because the lead skipped prescribed skill steps.

See [provenance and review records](docs/provenance.md). This repository contains source, checks, and review summaries, not credentials or raw transcripts. The original trial archive remains separate and unchanged. No remote backup or publication is configured.
