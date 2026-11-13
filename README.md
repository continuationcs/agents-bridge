# bridge

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
node out/cli.js init            # writes bridge.yaml with a local echo agent
node out/cli.js doctor
node out/cli.js chat --as me    # talk to your routes from the terminal
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
  github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${secret:github_token}" } }
  files:  { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem", "~/notes"] }
routes:
  - from: slack:#dev
    when: { sender: [alice] }
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
node out/cli.js secret set slack_app_token   # macOS keychain; elsewhere export BRIDGE_SECRET_SLACK_APP_TOKEN
node out/cli.js routes explain --from slack:#dev --sender alice --mention
node out/cli.js up
```

Approvals and merge/discard confirmations are Slack buttons (typed `approve` / `deny` / `yes` also work). A `budget_usd` policy is a per-conversation cap: each turn is started with only what is left (Claude Code gets it as `--max-budget-usd`).

`bridge.yaml` is hot-reloaded. An agent whose settings changed gets a new process for its next turn; turns already running finish on the old one. Changing IM credentials needs a restart.

### Feishu / Lark

```bash
node out/cli.js feishu setup   # app features, scopes to import, events and callbacks to subscribe
```

Replies are message cards (progress edits in place, approval buttons); headings and tables are rewritten for card markdown. People are mapped by open_id: `people: { alice: { feishu: ou_xxx } }` — `up` prints the open_id of anyone it ignores.

### Attachments

Files and images sent with a message are downloaded to `<data_dir>/files/<conversation>/` (up to `max_file_mb`, default 20) and handed to the agent as local paths; Claude Code is given read access to that folder. They are deleted after `files_ttl` (default 7d). Slack needs the `files:read` scope.

### History

Every few hours the bridge deletes audit-trail entries older than `retention` and conversations idle for longer than that (default 30d, `off` keeps them; a deleted conversation starts afresh, with a fresh budget), and finished queue entries older than `offline_queue_ttl`.

### Run it in the background (macOS)

```bash
node out/cli.js service install   # LaunchAgent: starts at login, restarted if it exits
node out/cli.js service status
node out/cli.js service uninstall
```

Logs go to `~/Library/Logs/bridge/bridge.log` (launchd can't write into `~/Documents`). The service starts with a bare environment, so `install` refuses a config that uses `env:` references or names secrets missing from the keychain. A turn cut off by a restart resumes in the same agent session (at most twice), and anything queued while the bridge was down runs when it comes back, within `offline_queue_ttl`.

### Parallel conversations on one repo

With `worktree: true` on a `claude-code` agent (needs git 2.38 or later), each conversation gets its own git worktree under `worktree_dir` on branch `bridge/<conversation>`, so two threads never edit the same checkout. Use `worktree_links` to link untracked things like `node_modules` from the main checkout; they are added to the repository's `.git/info/exclude`, so an agent's `git add -A` never commits the links.

Finish a conversation's branch from the thread itself (a message that is exactly the word):

| say | does |
|---|---|
| `status` / `状态` | branch, commits not yet in the base branch, diffstat, uncommitted files |
| `merge` / `合并` | shows what would land, then on `yes` squashes the branch into its base in your main checkout as one commit and removes the worktree |
| `discard` / `丢弃` | removes the worktree and branch (asks first if that would lose commits or changes) |
| `pr` / `开pr` | pushes the branch to `origin` and opens a pull request into the base (or reports the open one); needs `git_token` on the agent |

The base is whatever the main checkout had checked out when the conversation started; merge requires the main checkout to be on that branch with no uncommitted changes. The squash commit is built without touching the checkout and then fast-forwarded, so a conflict or a failing commit (signing, identity) changes nothing; commit hooks don't run again for it. Merge and `pr` refuse a branch that changes a linked path or a path your main checkout ignores. If the base branch was deleted or renamed, commits are counted from where the branch started; when even that is unknown, the branch is never pruned and `discard` asks first.

```bash
node out/cli.js worktrees                          # every conversation branch, with unmerged work
node out/cli.js worktrees prune --older-than 7d    # remove idle ones with nothing unmerged (--force for all)
```

## Routing rules

- An IM route goes to exactly one agent. A route to an agent that runs on this machine (`claude-code`, `stdio`) must name `when.sender`, or say `sender: anyone` explicitly.
- In channels the bot must be @-mentioned, unless `listen: all`. A reply in a thread the agent already holds continues it without a mention. DMs need no mention.
- `@bot data-agent …` addresses an agent by name when one channel has several.
- `when.mention` makes it explicit: `true` needs the mention (a DM counts as one), `false` needs none (like `listen: all`), and `<agent>` needs the mention *and* the agent's name at the start (`@bot data-agent …`), so several agents can share a channel without catching each other's messages.
- An agent route (`from: <agent>`) lists what that agent may reach: other agents, and tools as `server.tool` globs.
- `reset` / `/new` starts a fresh agent session for the thread. A DM session resets after `dm_idle_reset`.

## Policies

- A policy applies when every key of its `match` holds (`tool`, `agent`, `writes`); a missing key matches anything. Every applying policy counts: approvers are merged, the shortest `timeout` and the strictest `max_hops` / `budget_usd` win.
- `max_hops` and `budget_usd` belong to an agent, so they go on policies that match by `agent` only.
- Approvers are people from `people:` whose trust is not `external`. `initiator` means whoever started the conversation, but only when that is such a person: for a message from someone outside `people:` (a `sender: anyone` route), the owners decide instead, so nobody can approve their own request.
- The approval message shows the tool's arguments in full; where buttons need it to fit one message, long arguments are cut with a note, and the dashboard's Activity shows all of them.

## Tool servers

- **Local** (`command`, `args`, `env`): the bridge starts the MCP server as a child process and talks stdio. The child gets a minimal environment plus its own `env` — never the bridge's secrets.
- **Remote** (`url`, `headers`): Streamable HTTP, falling back to the older SSE transport (`transport: auto | streamable-http | sse`). A header value can be a whole secret ref (`secret:x`, `env:X`) or contain `${secret:x}` / `${env:X}`, e.g. `"Bearer ${secret:github_token}"`. Servers that sign in with OAuth take `oauth: true` instead (below).
- **OAuth** (`url`, `oauth: true`): run `bridge auth <server>` once, or press **Connect** in the dashboard. The browser opens the provider's consent page and comes back to `http://127.0.0.1:7377/oauth/callback`; the bridge registers itself (dynamic client registration), uses PKCE, keeps the tokens in the OS keychain and refreshes them. A tool call never opens a browser: when the grant is gone it fails with "not signed in — run bridge auth <server>". Providers without dynamic registration need a pre-registered app: `oauth: { client_id: …, client_secret: secret:…, scopes: [...] }`. `bridge auth` lists sign-in state; `--sign-out` forgets the tokens.
- `timeout` (default `5m`) bounds one tool call; progress notifications from the server extend it.
- A dropped connection or expired remote session is reconnected. Read-only tools are retried on the new connection; a tool that may write is retried only if the request never reached the server, so a write never runs twice. `bridge doctor` lists each server's tools.

## Dashboard

`bridge dashboard` opens `http://127.0.0.1:7377/` (served by the running bridge, to this machine only):

- **Waiting for you**: pending approvals and confirmations, with their buttons. You decide as the config's `owner`, the same as answering in the chat.
- **Conversations**: each session with its agent, cost, activity and branch; merge or discard a branch (shows what it will do first, waits for any running turn, and posts the result to the chat thread).
- **Activity**: the audit trail, for everything or one conversation.
- **Tool servers**: reachable or not, tool counts, OAuth Connect / Sign out.

Writes must be same-origin JSON and requests must carry a loopback `Host`, so other web pages and DNS-rebinding tricks can't drive it.

## Agent protocols

**Webhook**: `POST <url>` with `{"type":"turn","text","session_id","budget_usd","envelope","mcp":{"url"}}` (`budget_usd` is what is left of the conversation budget, or null). Respond with `{"text","session_id"?,"cost_usd"?}`.

**stdio**: a long-running process. The bridge writes `{"type":"turn","id",…}` lines to it, and it writes back `{"type":"progress","id","text"}`, `{"type":"reply","id","text","session_id"?,"cost_usd"?}` or `{"type":"error","id","message"}`. When a turn is stopped or gets no reply within the agent's `timeout` (default `30m`), the bridge writes `{"type":"cancel","id"}` and ignores anything that comes back for that id. See [src/examples/echo-agent.mjs](src/examples/echo-agent.mjs).

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
  mcp/tools.ts           external MCP tool servers (stdio or HTTP)
  mcp/oauth.ts           OAuth sign-in for remote tool servers (keychain storage, browser flow)
  web/                   local dashboard: JSON API + one self-contained page
  adapters/im/           slack, feishu / lark, telegram, local console
  adapters/agent/        claude-code, webhook, stdio
  examples/              example agents
  test/                  tests, helpers, fixtures
doc/                     documentation and reference files
```

Contributing: see [AGENTS.md](AGENTS.md).

## Not in v0.1 yet

- Discord adapter; Telegram tested end to end
- Codex wrapper, A2A, webhook SSE streaming
- Config-editing CLI commands (`connect`, `add`, `link`, `allow`); edit `bridge.yaml` directly
- Strict policy on `tainted` envelopes (today the flag only keeps `initiator` from approving)
