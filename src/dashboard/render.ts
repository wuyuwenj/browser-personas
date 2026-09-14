import type { DaemonStatus } from "../proxy/status.js";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The human's view: what Chrome is doing, who is holding what, and a link to watch any
 * tab in Chrome's own DevTools frontend without stealing it from the agent.
 *
 * Deliberately read-mostly and dependency-free — a live page beats a CLI listing that is
 * stale the moment it prints, and one file of inline CSS beats a build step.
 */
export function renderDashboard(status: DaemonStatus, host: string, port: number): string {
  const ws = (targetId: string): string => `ws=${host}:${port}/devtools/page/${targetId}`;

  const personas = status.personas
    .map((p) => {
      const holders = p.holders.length;
      const sharing =
        holders === 0
          ? '<span class="muted">no agent connected</span>'
          : holders === 1
            ? `held by <code>${escape(p.holders[0]!.owner)}</code>`
            : `<span class="warn">shared by ${holders} agents</span>: ` +
              p.holders.map((h) => `<code>${escape(h.owner)}</code>`).join(", ");
      const badges = [
        p.env ? `<span class="badge">${escape(p.env)}</span>` : "",
        p.exclusive ? '<span class="badge excl">exclusive</span>' : "",
        p.readOnly ? `<span class="badge ro">read-only: ${escape(String(p.readOnly))}</span>` : "",
      ].join("");
      const scope =
        p.origins.length > 0
          ? `<div class="scope">may reach ${p.origins.map((o) => `<code>${escape(o)}</code>`).join(", ")}</div>`
          : "";
      return `<article>
        <h3>${escape(p.name)}${badges}</h3>
        ${p.description ? `<p>${escape(p.description)}</p>` : ""}
        ${scope}
        <div class="holders">${sharing}</div>
      </article>`;
    })
    .join("");

  const owners = status.owners
    .map((o) => {
      const tabs =
        o.tabs.length === 0
          ? '<li class="muted">no tabs</li>'
          : o.tabs
              .map(
                (t) =>
                  `<li><a href="devtools://devtools/bundled/inspector.html?${escape(ws(t.id))}">watch</a> ` +
                  `<span>${escape(t.url || "about:blank")}</span></li>`,
              )
              .join("");
      return `<article>
        <h3><code>${escape(o.id)}</code>${o.connected ? "" : '<span class="badge off">disconnected</span>'}</h3>
        <div class="scope">persona <code>${escape(o.persona)}</code></div>
        <ul>${tabs}</ul>
      </article>`;
    })
    .join("");

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>browser-personas</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfc; --card:#fff; --ink:#16181d; --muted:#6b7280;
          --line:#e3e6ea; --accent:#2b6a8c; --warn:#a86a12; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101317; --card:#171b21; --ink:#e6e9ee; --muted:#8b94a3; --line:#272d36;
            --accent:#6fb0d2; --warn:#e0a656; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:900px; margin:0 auto; padding:32px 20px 64px }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em }
  .sub { color:var(--muted); margin:0 0 28px; font-size:14px }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
       margin:32px 0 10px; font-weight:600 }
  article { background:var(--card); border:1px solid var(--line); border-radius:6px;
            padding:14px 16px; margin-bottom:10px }
  article h3 { font-size:15px; margin:0 0 6px; display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  article p { margin:0 0 6px; color:var(--muted); font-size:14px }
  .scope, .holders { font-size:13px; color:var(--muted) }
  .holders { margin-top:6px }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px;
         background:color-mix(in srgb, var(--line) 60%, transparent); padding:1px 5px; border-radius:3px }
  .badge { font-size:11px; font-weight:500; letter-spacing:.03em; text-transform:uppercase;
           border:1px solid var(--line); border-radius:3px; padding:1px 6px; color:var(--muted) }
  .badge.excl { color:var(--accent); border-color:var(--accent) }
  .badge.ro, .warn { color:var(--warn) }
  .badge.ro { border-color:var(--warn) }
  .badge.off { color:var(--muted) }
  ul { margin:8px 0 0; padding-left:18px; font-size:13.5px }
  li { margin-bottom:3px }
  li span { color:var(--muted) }
  a { color:var(--accent) }
  .muted { color:var(--muted) }
  footer { margin-top:36px; color:var(--muted); font-size:12.5px }
</style>
<main>
  <h1>browser-personas</h1>
  <p class="sub">One Chrome on port ${port} · ${status.chromeAlive ? "running" : "not running"} ·
     ${status.owners.filter((o) => o.connected).length} agent(s) connected</p>

  <h2>Personas</h2>
  ${personas || '<article class="muted">No personas yet. Create one with <code>browser-personas login NAME --url URL</code>.</article>'}

  <h2>Agents</h2>
  ${owners || '<article class="muted">No agent has connected yet.</article>'}

  <footer>Watch links open Chrome&rsquo;s own DevTools against a tab without taking it from the agent.
  Paste one into Chrome&rsquo;s address bar if your browser will not follow a <code>devtools://</code> link.</footer>
</main>
<script>setTimeout(() => location.reload(), 5000);</script>`;
}
