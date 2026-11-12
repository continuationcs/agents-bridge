# agents-bridge

One local process that connects **agents ↔ IM**, **agents ↔ agents** and **agents ↔ tools**, driven by a single `bridge.yaml`.

- **IM**: Slack (Socket Mode) and Feishu / Lark (long connection), both outbound so you need no public URL. Telegram (long polling) is written but not yet tested against the real service.
- **Agents**: Claude Code (headless `claude -p`), any HTTP webhook, or any local process speaking JSON lines.
- **Tools**: external MCP servers. The bridge connects to them with its own credentials and gives each agent only what its routes allow, with approvals where policies say so.
- **Everything is routed and audited**: routes are first-match and deny-by-default, and every message, tool call and approval lands in a SQLite trace with secrets redacted.

Each agent turn gets a session-scoped MCP endpoint (`/mcp/<token>`) with these tools:

| tool | what it does |
|---|---|
| `send_message` | post an interim update to the thread being answered (only that thread) |
| `ask_human` | ask the initiator a question in the thread and wait for the reply |
| `delegate` | hand a task to another agent the routes allow; trust drops to `agent`, hops +1 |
| `<server>__<tool>` | a proxied external tool, if routed, after approval if a policy requires it |

## Quick start

```bash
npm install && npm run build
node dist/cli.js init            # writes bridge.yaml with a local echo agent
node dist/cli.js doctor
node dist/cli.js chat --as me    # talk to your routes from the terminal
```

Then add an IM and a real agent:

```yaml
people:
  alice: { trust: owner, slack: U0123456789 }
im:
  slack: { app_token: secret:slack_app_token, bot_token: secret:slack_bot_token }
agents:
  claude-code: { type: claude-code, cwd: ~/code/app, permission_mode: acceptEdits }
  data-agent:  { type: webhook, url: http://localhost:8080/agent }
tools:
  github: { command: npx, args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: secret:github_token } }
routes:
  - from: slack:#dev
    when: { mention: claude-code, sender: [alice] }
    to: claude-code
  - from: slack:#data
    to: data-agent
  - from: claude-code
    to: [github.*, data-agent]
policies:
  - match: { tool: "github.*", writes: true }   # every GitHub tool not marked read-only
    approve_by: [initiator]
    timeout: 10m
  - match: { agent: "*" }
    max_hops: 4
    budget_usd: 2
```

```bash
node dist/cli.js secret set slack_app_token   # macOS keychain; elsewhere export AGENTS_BRIDGE_SECRET_SLACK_APP_TOKEN
node dist/cli.js routes explain --from slack:#dev --sender alice --mention
node dist/cli.js up
```

Approvals and merge/discard confirmations are Slack buttons (typed `approve` / `deny` / `yes` also work). A `budget_usd` policy is a per-conversation cap: each turn is started with only what is left (Claude Code gets it as `--max-budget-usd`).

`bridge.yaml` is hot-reloaded. Changing IM credentials needs a restart.

### Feishu / Lark

```bash
node dist/cli.js feishu setup   # app features, scopes to import, events and callbacks to subscribe
```

Replies are message cards (progress edits in place, approval buttons); headings and tables are rewritten for card markdown. People are mapped by open_id: `people: { alice: { feishu: ou_xxx } }` — `up` prints the open_id of anyone it ignores.

### Attachments

Files and images sent with a message are downloaded to `<data_dir>/files/<conversation>/` (up to `max_file_mb`, default 20) and handed to the agent as local paths; Claude Code is given read access to that folder. They are deleted after `files_ttl` (default 7d). Slack needs the `files:read` scope.

### Run it in the background (macOS)

```bash
node dist/cli.js service install   # LaunchAgent: starts at login, restarted if it exits
node dist/cli.js service status
node dist/cli.js service uninstall
```

Logs go to `~/Library/Logs/agents-bridge/bridge.log` (launchd can't write into `~/Documents`). A turn cut off by a restart resumes in the same agent session (at most twice), and anything queued while the bridge was down runs when it comes back, within `offline_queue_ttl`.

### Parallel conversations on one repo

With `worktree: true` on a `claude-code` agent, each conversation gets its own git worktree under `worktree_dir` on branch `bridge/<conversation>`, so two threads never edit the same checkout. Use `worktree_links` to link untracked things like `node_modules` from the main checkout.

Finish a conversation's branch from the thread itself (a message that is exactly the word):

| say | does |
|---|---|
| `status` / `状态` | branch, commits not yet in the base branch, diffstat, uncommitted files |
| `merge` / `合并` | shows what would land, then on `yes` squashes the branch into its base in your main checkout as one commit and removes the worktree |
| `discard` / `丢弃` | removes the worktree and branch (asks first if that would lose commits or changes) |
| `pr` / `开pr` | pushes the branch to `origin` and opens a pull request into the base (or reports the open one); needs `git_token` on the agent |

The base is whatever the main checkout had checked out when the conversation started; merge requires the main checkout to be on that branch with no uncommitted changes, and stops without changing anything on conflict.

```bash
node dist/cli.js worktrees                          # every conversation branch, with unmerged work
node dist/cli.js worktrees prune --older-than 7d    # remove idle ones with nothing unmerged (--force for all)
```

## Routing rules

- An IM route goes to exactly one agent. A route to an agent that runs on this machine (`claude-code`, `stdio`) must name `when.sender`, or say `sender: anyone` explicitly.
- In channels the bot must be @-mentioned, unless `listen: all`. A reply in a thread the agent already holds continues it without a mention. DMs need no mention.
- `@bot data-agent …` addresses an agent by name when one channel has several.
- An agent route (`from: <agent>`) lists what that agent may reach: other agents, and tools as `server.tool` globs.
- `reset` / `/new` starts a fresh agent session for the thread. A DM session resets after `dm_idle_reset`.

## Agent protocols

**Webhook**: `POST <url>` with `{"type":"turn","text","session_id","budget_usd","envelope","mcp":{"url"}}` (`budget_usd` is what is left of the conversation budget, or null). Respond with `{"text","session_id"?,"cost_usd"?}`.

**stdio**: a long-running process. The bridge writes `{"type":"turn","id",…}` lines to it, and it writes back `{"type":"progress","id","text"}`, `{"type":"reply","id","text","session_id"?,"cost_usd"?}` or `{"type":"error","id","message"}`. See [examples/echo-agent.mjs](examples/echo-agent.mjs).

Both kinds get the MCP URL, so any agent with an MCP client can use `send_message`, `ask_human`, `delegate` and the granted tools.

## Layout

```
src/
  cli.ts                 commands
  config/                schema (zod) + semantic checks
  core/router.ts         first-match routing, explain, outbound grants
  core/policy.ts         approvals, max hops, budgets
  core/bridge.ts         inbound → queue → agent turn → reply; MCP tool backend
  core/store.ts          SQLite: sessions, queue, trace (redacted)
  mcp/hub.ts             per-turn MCP endpoints over streamable HTTP
  mcp/tools.ts           external MCP tool servers (stdio)
  adapters/im/           slack, telegram, local console
  adapters/agent/        claude-code, webhook, stdio
```

## Not in v0.1 yet

- Discord adapter; Telegram tested end to end
- Codex wrapper, A2A, webhook SSE streaming
- Web UI (`status` serves JSON at `/api/status` for now)
- Config-editing CLI commands (`connect`, `add`, `link`, `allow`); edit `bridge.yaml` directly
- Strict policy on `tainted` envelopes (the flag is recorded but not enforced)
