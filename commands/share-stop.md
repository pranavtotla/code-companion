---
name: share-stop
description: Stop sharing terminal sessions
allowed-tools:
  - mcp__plugin_code-companion_code-companion__list_sessions
  - mcp__plugin_code-companion_code-companion__stop_session
  - mcp__plugin_code-companion_code-companion__stop_server
---

Stop active terminal sharing sessions.

1. Call `list_sessions` to see what's running
2. If no sessions are active, inform the user
3. If one session: stop it with `stop_session`
4. If multiple sessions: ask the user which to stop, or offer to stop all with `stop_server`
5. Confirm that sharing has been stopped
