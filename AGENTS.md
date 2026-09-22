# Pi Herdr agents

This is a reviewed prototype, not an installed extension. Read README.md and PROTOCOL.md before changing startup or recovery. Native launch still assumes `/opt/adapter` and private runtime configuration.

- Keep task correlation, ownership, and same-conversation continuation explicit. Never replay an ambiguous submission automatically.
- Give every role normal tools. Read-only review is an assignment, not a shell or Git ban.
- Consult installed Pi docs and the installed Herdr CLI before changing their integration. The tested versions are recorded in README.md.
- Run `npm test`. It covers local contracts, not native lifecycle behavior. Use a disposable named Herdr session for native checks and keep credentials and transcripts out of Git.
- Do not change global Pi packages or control unrelated panes without user authorization.
- Keep changes focused. Do not add workflow phases, a scheduler, or speculative recovery policies.
- Give a fresh reviewer the task contract, exact diff, and completed verification after code changes. Withhold the implementer's rationale until review is complete.
