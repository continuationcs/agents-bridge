export const TEMPLATE = `# agents-bridge config. Edit, then: agents-bridge doctor && agents-bridge up
version: 1

# Who is who across IMs. Routes and approvals refer to these ids.
people:
  me:
    trust: owner
    # slack: U0123456789      # your Slack member id
    # telegram: "123456789"   # your Telegram user id

# IM connections (outbound only; no public URL needed). Store tokens with:
#   agents-bridge secret set slack_app_token
im: {}
  # slack:
  #   app_token: secret:slack_app_token   # xapp-… (Socket Mode)
  #   bot_token: secret:slack_bot_token   # xoxb-…
  # telegram:
  #   bot_token: env:TELEGRAM_BOT_TOKEN

agents:
  echo:
    type: stdio
    command: node
    args: [examples/echo-agent.mjs]
    description: replies with what you sent
  # claude-code:
  #   type: claude-code
  #   cwd: ~/code/my-app
  #   permission_mode: acceptEdits
  # data-agent:
  #   type: webhook
  #   url: http://localhost:8080/agent

# External tools (MCP servers) the bridge connects to with its own credentials.
tools: {}
  # github:
  #   command: npx
  #   args: ["-y", "@modelcontextprotocol/server-github"]
  #   env: { GITHUB_PERSONAL_ACCESS_TOKEN: secret:github_token }

# First match wins; anything unmatched is ignored.
routes:
  - from: local:*            # agents-bridge chat
    when: { sender: [me] }
    to: echo
  # - from: slack:#dev
  #   when: { mention: claude-code, sender: [me] }
  #   to: claude-code
  # - from: claude-code       # what claude-code may reach
  #   to: [github.*, data-agent]

policies: []
  # - match: { tool: ["github.push*", "*.delete*"] }
  #   approve_by: [initiator]
  #   timeout: 10m
  # - match: { agent: "*" }
  #   max_hops: 4
  #   budget_usd: 2

defaults:
  dm_idle_reset: 2h
  offline_queue_ttl: 24h
  progress: collapsed
`;
