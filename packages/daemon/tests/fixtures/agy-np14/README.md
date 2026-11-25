# NP-14 Offline Replay Fixtures (`agy-np14`)

All files in this directory are **synthetic / sanitized replay fixtures** (`replay_with_provenance` / `synthetic`) created for NP-14 offline testing of T12, T13, and T16 scenarios.

- `t16-plan-diff-browser.ndjson`: Synthetic ACP v1 `session/update` frames aligned with `E05` (`agy-1.5.14` fixture shapes) and `06_Protocol_Evidence.md` covering:
  1. Entering native `plan` mode via `current_mode_update`
  2. Standard ACP `plan` entries (`acp_agent_plan`)
  3. AGY `Run update_steps` tool call (`agy_update_steps`)
  4. ACP `tool_call` `content[type=diff]` emission (`acp_tool_diff`)
  5. Exiting `plan` mode back to `default`
  6. Browser Agent observation across `app_embedded_browser` and `cli_chrome_mcp` surfaces (with media metadata and redacted URLs)
  7. `history_replay` isolation frame proving historical replay does not overwrite live state unless scoped as historical.

No real OAuth tokens, real account identifiers, private prompts, or host OS paths are included.
