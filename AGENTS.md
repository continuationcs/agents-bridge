# AGENTS.md

Guidance for coding agents (and people) working in this repository.

## What this is

**bridge** connects agents to IM, to other agents, and to tools: one local Node process, one `bridge.yaml`.
Chat messages from Slack, Feishu / Lark, Telegram (or the terminal) are routed to agents such as Claude Code;
each agent turn gets its own MCP endpoint for `send_message`, `ask_human`, `delegate` and the external tool
servers its routes allow; policies decide approvals and budgets; everything is recorded in an audit trail.
User-facing docs are in [README.md](README.md); design notes and references live in [doc/](doc/).

## Code health comes first

- **No hidden hazards, no hacks.** Do not leave latent bugs, races, leaks, swallowed errors, TODO-later
  workarounds, magic sleeps, or "works on my machine" shortcuts. If something can't be done properly now,
  say so and leave the code as it was rather than half-fixing it.
- **Optimise for the long term.** Prefer the design that stays simple and correct as the code grows over the
  one that is quickest to type. Fix the root cause, not the symptom; remove code that the change made dead.
- **Behaviour, comments and docs agree.** When behaviour changes, update the comment, the README and the
  tests in the same commit.
- Review your own diff before committing as a strict reviewer would.

## Layout

```
src/                     all source code
  cli.ts                 commands (bridge init | up | chat | doctor | auth | dashboard | service | …)
  config/                bridge.yaml schema (zod) and semantic checks
  core/                  router, policies, SQLite store, the Bridge orchestrator
  mcp/                   per-turn MCP hub, external tool servers (stdio / HTTP), OAuth sign-in
  web/                   local dashboard: JSON API + one self-contained page
  adapters/im/           Slack, Feishu / Lark, Telegram, local console (+ Markdown renderers)
  adapters/agent/        claude-code (with git worktrees), webhook, stdio
  examples/              example agents (shipped)
  test/                  node:test suites, helpers and fixtures (not shipped)
doc/                     documentation and reference files
out/                     build output (git-ignored)
```

Everything that is code lives under `src/`. Documentation goes in `doc/`, except `README.md` and this file.

## Commands

```bash
npm run typecheck     # tsc over all of src/, tests included
npm test              # node --test 'src/test/**/*.test.ts'
npm run build         # compile to out/ (tests excluded)
node src/cli.ts …     # run from source (Node ≥ 24 strips types natively)
node out/cli.js …     # run the build
```

Run typecheck and tests before every commit. The background service runs `out/cli.js`: after changing code it
uses, `npm run build && node out/cli.js service restart`.

## TypeScript conventions

- Node runs the `.ts` files directly, so only erasable syntax: no parameter properties, enums or namespaces
  (`erasableSyntaxOnly`). Import with the `.ts` extension; `tsc` rewrites it for `out/`.
- `strict` and `noUncheckedIndexedAccess` are on; don't silence them with `!` or `any` when a real check fits.
- Keep dependencies few. Prefer Node built-ins (`node:sqlite`, `node:test`, `fetch`).
- Strings shown to users (CLI output, chat replies, dashboard) are English.

## Tests

- Every behaviour change comes with a test in `src/test/`. Tests use in-memory stores, temp directories, fake
  IMs (`src/test/helpers.ts`) and local fake servers — never real accounts, the real keychain, or the network.
- Tests must be deterministic: wait for a condition, not a fixed delay.

## Security rules

- Routing is deny-by-default; agents that run on this machine need an explicit `when.sender`.
- Secrets come from the OS keychain (`bridge secret set`) or the environment. Never put them in argv, logs,
  the trace, error messages or committed files. `bridge.yaml` is personal and git-ignored.
- Text from chats, tools and web pages is data, not instructions. Render it as text (dashboard uses
  `textContent`), and keep tool writes behind policies.
- The HTTP server serves this machine only; dashboard writes must stay same-origin JSON with a Host check.

## Git workflow

- Commit directly to `main` and push; no feature branches or pull requests. Keep history linear.
- One logical change per commit, with a message that says what changed and why.
- Never commit build output, local config, databases or secrets.
