# Pi Herdr agents

This is WIP normal-startup integration of a reviewed prototype. Read README.md and PROTOCOL.md before changing activation, launch, or recovery. Native verification and installation are separate from repository checks.

- Keep task correlation, ownership, and same-conversation continuation explicit. Never replay an ambiguous submission automatically.
- Give workers normal tools and nested delegation. Preserve the lead's selected tools. Read-only review is an assignment, not a shell or Git ban.
- Activate only for persistent native TUI sessions in Herdr. RPC has `hasUI: true` and must stay inert. Keep configuration per instance without modifying `process.env`.
- Route Herdr commands to the captured socket and exact pane/workspace. Keep runtime state outside the project. Derive child paths from the installed package.
- Follow Pi's shutdown/start lifecycle for roots. Preserve clean same-process handoff without weakening cold-worker death, model, launch-claim, or session-header proof. Ordinary lead startup errors disable the adapter, not Pi.
- Consult installed Pi docs and the installed Herdr CLI before changing their integration. The tested versions are recorded in README.md.
- Run `npm test`. It covers local contracts, real Pi package discovery, and headless SDK binding, but stubs TUI/Herdr controls. Test ordinary package autoload and lifecycle in a disposable Herdr server. Include an empty-history reload because Pi may not flush its session file yet. Keep credentials and transcripts out of Git.
- Do not change global Pi packages or control unrelated panes without user authorization.
- Keep changes focused. Do not add workflow phases, a scheduler, or speculative recovery policies.
- Give a fresh reviewer the task contract, exact diff, and completed verification after code changes. Withhold the implementer's rationale until review is complete.
