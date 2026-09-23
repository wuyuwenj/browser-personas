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

## Install

```bash
npx browser-personas init
npx browser-personas start
```

That is the whole change. If you already use chrome-devtools-mcp, `init` finds your entry
and routes it through a tiny shim: every flag you had stays, and the agent sees exactly
the tools it always had. If you do not, `init` creates the entry, running the copy of
chrome-devtools-mcp that ships with this package. Restart your agent sessions — an MCP
server reads its flags once, at startup — and every session now shares one Chrome with
its own tabs.

`init --revert` puts your config back byte for byte. `init` is safe to run again; it
never wraps an entry twice.

If an entry runs a **custom launcher script** rather than chrome-devtools-mcp directly,
`init` leaves it alone and says so. A launcher like that usually picks a browser profile
at runtime — a flag the shim cannot see in the config, and one upstream refuses to
combine with `--wsEndpoint`. That job is what this tool takes over, so re-run with
`--replace-launcher` to swap it for the bundled upstream.

## Try it in two terminals

Open two terminals, start `claude` in each, and ask each one to open a page. Then ask
each what pages it has: one page each, its own. Activity Monitor shows one Chrome.

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

## Works with anything that speaks CDP

`init` handles chrome-devtools-mcp. Everything else points at the proxy directly:

| Client | How to point it here |
|---|---|
| Playwright / Playwright MCP | `--cdp-endpoint http://127.0.0.1:9223` |
| Puppeteer | `puppeteer.connect({ browserURL: "http://127.0.0.1:9223" })` |
| agent-browser | `agent-browser connect 9223` |

`--browserUrl` gives isolation with an anonymous, per-connection identity. To carry a
persona and a stable owner name, use the websocket form the shim uses:
`ws://127.0.0.1:9223/devtools/browser/bp?owner=<id>&persona=<name>`. Puppeteer resolves
`/json/version` as an absolute path against `browserURL` and discards anything else on
it, which is the whole reason the shim exists.

### Why a shim

Two facts. `--browserUrl` cannot carry a persona or an owner name, and a static config
entry cannot hold a per-session id — every session using it would share one, and
reclaim-after-reconnect would hand one session another's tabs. So `browser-personas exec`
computes the id at spawn time from the controlling terminal, and runs the very command
you had with the proxy endpoint appended. It resolves the upstream in a fixed order —
your own command, then the copy bundled here, then `npx chrome-devtools-mcp@latest` —
and says which one it picked on stderr, so version drift is visible.

Chrome itself is the one thing this never fetches quietly. If none is installed, `init`
prints the one-liner and stops.

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

Requests to a persona's `auth_origins` are exempt from `read_only`: signing in is POSTs
to the identity provider, and the read-only promise is about the app, not the IdP. A
`strict` persona blocking a Next.js server action says so and points at `cooperative`.

A blocked request is answered with a 403 whose body names the policy, so the agent's
network log explains itself instead of looking like a flaky site.

`cooperative` is deliberately honest: the proxy cannot tell a server action that reads
from one that writes, so it marks the request and the application decides. A proxy
claiming to block writes it cannot identify would be a false guarantee.

## Browsing as a persona

A browsing session is one persona, chosen by which entry it runs through:

```bash
npx browser-personas init --persona katy --persona kendrick
```

adds `chrome-devtools-katy` and `chrome-devtools-kendrick` beside your `chrome-devtools`
entry, each a copy of your own command through the shim. An agent picks by server name,
which is how MCP hosts already model "which one". Tabs it opens carry that login.

## Let the agent discover identities

Optional. `init --registry` adds a second, five-tool server so an agent can read who is
available and who is using what:

| Tool | What the agent uses it for |
|---|---|
| `list_personas` | who each identity is, what it may reach, who is holding it, and any notes |
| `verify_persona` | "am I still signed in?" — fetches the probe page through that persona's cookies |
| `note_persona` | leave a note for whoever uses it next; `ttl_hours` for anything about data state |
| `add_persona` | register a new identity (it still needs a `login` run to get a session) |
| `remove_persona` | delete one and shred its jar; refused while an agent holds it |

There is also a `/personas` prompt that just prints the list. Browsing itself stays with
chrome-devtools-mcp, untouched: the registry never re-exports its tools, so nobody pays
for a doubled tool schema on every session.

### Sharing a login

Two agents on one non-exclusive persona are the same signed-in user. The first time an
agent opens a page on a persona somebody else is holding, its result carries one extra
line:

> Shared login: 1 other agent (agent-1) holds "katy". Your tabs are yours, but every
> action is attributed to the same signed-in user, and a sign-out by any of you signs out
> all of you.

Once, not on every call. Mark a persona `exclusive: true` to hand it to one agent at a
time instead; the second gets a refusal naming the holder.

## The login saves itself

The daemon watches every sign-in in progress and asks your application, through the very
cookies the login is producing, whether the session is real. Two checks in a row have to
agree before it saves — a multi-step sign-in passes through pages that are not the login
page, and a probe can answer before a second factor is finished, so one answer is not
enough.

The watcher runs in the daemon, not in the page, so a `browser-personas login` from the
terminal finishes by itself too, and closing the console tab mid-login does not strand a
browser waiting for a click nobody is going to make.

Press **Do not save automatically** if you want to keep using that window first; the Save
button comes back.

## The console

```bash
browser-personas console --open
```

One page, printed with its token when the daemon starts. From it you can:

- **Add a persona** — a name and one website is enough.
- **Add more websites to it.** A persona is a person, and a person signs in to more than
  one site. Each website has its own row with its own sign-in, and one session covers them
  all. Every website is editable on its own; removing one leaves the rest alone.
- **Edit the persona itself** — description, environment, read-only level, exclusivity.
- **Log in, however that site wants.** Press the button, a browser window opens, and you
  sign in with a password form, Google, GitHub, SSO, a magic link, two factors — anything.
  It saves itself the moment the sign-in is really done, and the window closes. You are
  never asked to confirm something the application can answer.
- **Watch a tab.** Every agent's tabs are listed with a link that opens Chrome's own
  DevTools against one, without taking it from the agent.
- **Edit or delete.** Deleting is refused while an agent holds the persona, naming them.

The CLI still does all of it, unchanged, because scripts and CI need it.

### One persona, several websites

```yaml
name: katy
accounts:
  - origin: https://app.example.com
    username: katy@example.com
    role: homeowner
    probe: /my-homes
  - origin: https://admin.example.com
    username: katy@admin
    role: admin
    probe: /dashboard
```

Websites are addressed by URL, never by position — an index-keyed edit lands on the wrong
site the moment a row is removed between read and write, and does it silently. The
persona's websites are also its fence: it can reach all of them and nothing else.

Signing in to the second site does not cost you the first. The login browser starts from
the persona's existing session, so what it captures at the end is the union.

### Any site, any login method

Only a name and an app URL are required. Everything else is learned from a real sign-in:

- **The login browser is unfenced**, so the redirect to `accounts.google.com` or your SSO
  provider works. A persona fenced to its own app could never complete an OAuth login.
- **Cookies for every origin involved** are captured, not just the app's — the provider's
  session is what makes a later silent re-auth possible.
- **Web storage is captured too.** Firebase, Supabase, Auth0's SPA SDK and MSAL keep their
  tokens in `localStorage`, so a cookies-only jar restores a session the application still
  treats as signed out.
- **The provider's origins are remembered** as `auth_origins` and allowed, so the persona
  can re-authenticate later without you widening the fence by hand. They were learned from
  a real login, so allowing them grants nothing the app does not already do.
- **The signed-in path is inferred** from wherever the login landed you, if you did not
  give one.
- **The username fills itself in.** Whatever address you typed into the sign-in form is
  remembered — including on Google's or Okta's own page, which is what makes this work for
  SSO. If you never typed one, the address is read out of the ID token the login left
  behind. A name you set by hand is never overwritten.

### Passwords

Storing one is optional, off by default, and useless for OAuth — there is no local
password in a Google or SSO sign-in. A cookie jar holds a session that expires; a
password does not, so the same file gains a much longer blast radius. What it buys is the
**Fill the form** button and automatic re-login when a session dies, which matters for
long unattended runs and little else. The default stays `password_ref`, a pointer to
wherever your team already keeps passwords. A stored password is encrypted with the same
key as the jars and is never rendered back to the page, returned by any endpoint, or put
in a tool result.

### Why the console is token-gated

Reading state over loopback is harmless. Writing credentials over loopback is not: any
page on the internet can make a visitor's browser POST to 127.0.0.1, and any process on
your machine can reach the port. So the console and its API need a token (minted per
daemon, kept `0600`, carried in the link), a loopback `Host` — which kills DNS
rebinding — and JSON for any write that has a body, which a cross-site form cannot send.

The CDP endpoints stay open exactly as before. `chrome-devtools-mcp` has nowhere to put a
token, and they expose no credentials.

## Commands

```
browser-personas init                 route chrome-devtools-mcp entries through the proxy
browser-personas init --persona NAME  add a chrome-devtools-NAME entry (repeatable)
browser-personas init --registry      add the five-tool registry server
browser-personas init --revert        restore your configs
browser-personas exec -- CMD...       what init installs; runs CMD through the proxy
browser-personas login NAME --url U   log a persona in once; saves itself when you are done
browser-personas personas             list personas, their scope and restrictions
browser-personas console [--open]     print (or open) the local console link
browser-personas mcp                  the persona registry, as an MCP server
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

v0.9: transparent mode — your chrome-devtools-mcp, your flags, one Chrome underneath;
personas that hold several websites and survive any login method; the optional registry;
the console. Still ahead are per-owner audit logs and rate limits, IndexedDB for the
few SDKs that use it, and Linux vault coverage. The design and a per-milestone record of what the
real browser taught us are in [`docs/design.html`](docs/design.html).

## Development

```bash
pnpm install
pnpm test              # unit
pnpm test:integration  # drives a real Chrome
pnpm lint
```

MIT.
