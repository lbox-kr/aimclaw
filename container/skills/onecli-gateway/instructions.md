# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call supported APIs directly (Gmail, Slack, etc.) — the proxy adds auth before it reaches the service. LBox GitHub is the exception: use `team-github` and `ncl github ...`, never this proxy.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If a supported OneCLI service returns `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
