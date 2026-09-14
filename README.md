# browser-personas

**browser-personas gives every agent its own logged-in identity and its own tabs, in one Chrome.**

Open a second Claude Code terminal in the same repo and your browser tooling stops working:

```
Error: The browser is already running for /Users/you/.cache/chrome-devtools-mcp/chrome-profile.
Use --isolated to run multiple browser instances.
```

The usual fixes both cost you something. A profile per session means a whole Chrome per
session — on a 24 GB laptop, eleven sessions was 38 Chrome processes and an out-of-memory
alert. `--isolated` throws the profile away, so every agent starts logged out and someone
gets to solve the captcha again, once per agent.

`browser-personas` is a Chrome DevTools Protocol proxy that sits between your agents and
one Chrome. Every agent gets its own tabs and cannot see, attach to, navigate or close
anyone else's. One browser, one profile, one login.

## Try it in two terminals

```bash
# terminal 0
npx browser-personas start

# terminal 1
npx chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9223

# terminal 2
npx chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9223
```

Open a page in each. Each `list_pages` shows one page — its own. Activity Monitor shows
one Chrome.

## Install

```bash
npx browser-personas init     # points existing chrome-devtools MCP entries at the proxy
npx browser-personas start
```

`init` keeps every flag your entry already had and writes a backup first; `init --revert`
puts the originals back. Restart your agent sessions afterwards — an MCP server reads its
flags once, at startup.

## How it works

```
agent A ─MCP─▶ chrome-devtools-mcp ─CDP ws─┐
agent B ─MCP─▶ chrome-devtools-mcp ─CDP ws─┤   :9223                      pipe (fd 3/4)
agent C ─MCP─▶ Playwright MCP ──────CDP ws─┼─▶ browser-personas ────────▶ one Chrome
script  ─────▶ puppeteer.connect() ─CDP ws─┘   ownership · caps · reap    one profile
```

Chrome is launched with `--remote-debugging-pipe`, not a port, so the proxy holds the only
connection to it and nothing can reach around the scoping.

**Ownership is by creation.** A tab created through your connection is yours. Popups
inherit from their opener. Tabs that already existed, or that you opened by hand, belong
to nobody and are invisible to every agent.

**The claim window.** Chrome announces a new tab *before* the creating client's response
arrives, so for a few milliseconds nobody owns it. Those frames are held, then released to
whoever the response says created it. Nothing unclaimed is ever shown to anyone.

## Works with

| Client | How to point it here |
|---|---|
| chrome-devtools-mcp | `--browserUrl=http://127.0.0.1:9223` |
| Playwright / Playwright MCP | `--cdp-endpoint http://127.0.0.1:9223` |
| Puppeteer | `puppeteer.connect({ browserURL: "http://127.0.0.1:9223" })` |
| anything speaking CDP | the same host and port |

### Naming an agent

`--browserUrl` gives you isolation with an anonymous, per-connection identity. To give a
session a stable name — so a reconnect gets its tabs back instead of new ones — use the
websocket form, which is the only one that can carry a name:

```bash
npx chrome-devtools-mcp@latest \
  --wsEndpoint "ws://127.0.0.1:9223/devtools/browser/bp?owner=$(tty | tr -cs 'a-z0-9' -)"
```

Puppeteer resolves `/json/version` as an absolute path against `browserURL`, which
discards any path or query you put there. A websocket endpoint is passed through verbatim.

## Personas: one browser, several logins

A persona is a named identity inside the same Chrome — its own cookie store, and a cookie
jar on disk so the login survives a restart. This is the part `--isolated` cannot do.

```bash
npx browser-personas login katy --url https://your-app.example --env staging
# a browser window opens. Log in once — captcha and all — then press Enter.
```

Point an agent at it, and every tab it opens carries that login:

```bash
npx chrome-devtools-mcp@latest \
  --wsEndpoint "ws://127.0.0.1:9223/devtools/browser/bp?owner=agent-1&persona=katy"
```

Two agents on two personas are two different signed-in users in one browser process. Both
survive `browser-personas stop` and a restart.

`browser-personas personas` lists them with their scope and restrictions.

### The manifest

`~/.config/browser-personas/personas/katy/manifest.yaml` says what the persona is. It
never holds a password — `password_ref` points at wherever your team keeps those.

```yaml
name: katy
description: "Owner with an active renewal. Owner-facing flows only."
env: staging
exclusive: false            # true hands it to one agent at a time
read_only: false            # false | strict | inspect | cooperative
accounts:
  - origin: https://stage.your-app.example
    username: katy@example.com
    role: homeowner
    probe: /messages        # 200 here means still logged in
    password_ref: "1password://Team/stage-katy"
```

Cookie jars are AES-256-GCM with the key in the macOS Keychain (a `0600` file elsewhere),
matching what Chrome does with its own cookie database. No command ever prints a cookie.

### Fences

**`accounts[].origin` is an allowlist for navigation.** A staging persona cannot be
navigated to production — the proxy answers the navigation itself, so no request leaves
the machine. It applies to top-level document loads only: enforcing it on subresources
would block the app's own auth provider, CDN and fonts, and would stop the app working
without stopping an agent going anywhere.

**`read_only` has three levels, because "GET only" is wrong for most apps.** Every Next.js
server action is a POST, and so is every GraphQL query, so a method-only rule would load a
page shell and nothing inside it.

| Level | Allows | Fits |
|---|---|---|
| `strict` | GET, HEAD, OPTIONS | a site you do not control |
| `inspect` | plus POSTs whose body reads (GraphQL `query`, not `mutation`) | GraphQL apps |
| `cooperative` | plus any POST, stamped `X-Read-Only: 1` | server-action apps, where only the app knows |

A blocked request is answered with a 403 whose body names the policy, so the agent's
network log explains itself instead of looking like a flaky site.

`cooperative` is deliberately honest: the proxy cannot tell a server action that reads
from one that writes, so it marks the request and the application decides. A proxy
claiming to block writes it cannot identify would be a false guarantee.

## Let the agent choose its own identity

Run browser-personas as the MCP server and your agent gets chrome-devtools-mcp's whole
toolset plus five persona tools. It can then read who is available and pick:

```jsonc
{ "mcpServers": { "browser": {
    "command": "npx",
    "args": ["browser-personas", "mcp", "--persona", "katy"]
} } }
```

| Tool | What the agent uses it for |
|---|---|
| `list_personas` | who each identity is, what it may reach, who is holding it, and any notes |
| `verify_persona` | "am I still signed in?" — fetches the probe page through that persona's cookies |
| `note_persona` | leave a note for whoever uses it next; `ttl_hours` for anything about data state |
| `add_persona` | register a new identity (it still needs a `login` run to get a session) |
| `remove_persona` | delete one and shred its jar; refused while an agent holds it |

There is also a `/personas` prompt that just prints the list.

### Sharing a login

Two agents on one non-exclusive persona are the same signed-in user. The first time an
agent opens a page on a persona somebody else is holding, its result carries one extra
line:

> Shared login: 1 other agent (agent-1) holds "katy". Your tabs are yours, but every
> action is attributed to the same signed-in user, and a sign-out by any of you signs out
> all of you.

Once, not on every call. Mark a persona `exclusive: true` to hand it to one agent at a
time instead; the second gets a refusal naming the holder.

## The dashboard

The daemon serves one page at `http://127.0.0.1:9223/`: every persona with its scope and
restrictions, every agent with its tabs, and a **watch** link per tab that opens Chrome's
own DevTools against it without taking it from the agent.

## Commands

```
browser-personas init [--port N]      point agent configs at the proxy
browser-personas init --revert        restore them
browser-personas login NAME --url U   log a persona in once; the cookies persist
browser-personas personas             list personas, their scope and restrictions
browser-personas mcp [--persona NAME] run as an MCP server (tools + registry)
browser-personas start [--headed]     run the daemon
browser-personas status               who holds which tabs
browser-personas stop
```

## Limits

Each agent may hold **3 tabs** (`--max-tabs`). A fourth is refused with the three already
open named, so the agent can close one. Tabs of a disconnected agent survive a **120 s**
grace window, so an `/mcp` reconnect gets them back. A tab with no traffic for **15
minutes** is closed.

`Browser.close` and the crash commands are refused: they would end every agent's session
at once. `Page.bringToFront` is answered locally rather than forwarded, so agents cannot
fight over the front window; screenshots and input work on background tabs regardless.

## What this is not

Not a security boundary against a hostile local process — it can read this directory as
you, the same as it can read Chrome's. The isolation here is between well-behaved agents.

## Status

v0.3, feature-complete for the design in [`docs/design.html`](docs/design.html): the
proxy, tab ownership, personas, the registry MCP, and the dashboard. Still ahead are
per-owner audit logs and rate limits, `localStorage` persistence for apps that keep auth
there, and Linux vault coverage.

## Development

```bash
pnpm install
pnpm test              # unit
pnpm test:integration  # drives a real Chrome
pnpm lint
```

MIT.
