import type { DaemonStatus } from "../proxy/status.js";

/**
 * The console: one page, no build step, no dependencies.
 *
 * Server-rendered shell plus a small script that polls `/api/state`. The lists re-render
 * from state; the forms are never touched by the renderer, so typing into one is not
 * interrupted by a refresh — which is exactly how a naive full-page reload ruins a
 * settings page.
 */
export function renderConsole(
  status: DaemonStatus,
  host: string,
  port: number,
  /**
   * Accepted but deliberately unused: the page reads its token from `location.search`, so
   * it never appears in the HTML body — only in the address bar, where it already is.
   */
  _token: string,
): string {
  const initial = JSON.stringify({ ...status, secrets: {}, logins: [] }).replace(/</g, "\\u003c");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>browser-personas</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfc; --card:#fff; --ink:#16181d; --muted:#6b7280;
          --line:#e3e6ea; --accent:#2b6a8c; --warn:#a86a12; --good:#2f7a4d; --bad:#a4343a;
          --field:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101317; --card:#171b21; --ink:#e6e9ee; --muted:#8b94a3; --line:#272d36;
            --accent:#6fb0d2; --warn:#e0a656; --good:#6fc48f; --bad:#e08c90; --field:#0e1116; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,sans-serif }
  main { max-width:940px; margin:0 auto; padding:32px 20px 72px }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em }
  .sub { color:var(--muted); margin:0 0 26px; font-size:14px }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
       margin:30px 0 10px; font-weight:600 }
  article { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:14px 16px; margin-bottom:10px }
  article h3 { font-size:15px; margin:0 0 6px; display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  article p { margin:0 0 6px; color:var(--muted); font-size:14px }
  .scope,.holders { font-size:13px; color:var(--muted) }
  .holders { margin-top:6px }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px;
         background:color-mix(in srgb,var(--line) 60%,transparent); padding:1px 5px; border-radius:3px }
  .badge { font-size:11px; font-weight:500; letter-spacing:.03em; text-transform:uppercase;
           border:1px solid var(--line); border-radius:3px; padding:1px 6px; color:var(--muted) }
  .badge.excl { color:var(--accent); border-color:var(--accent) }
  .badge.ro { color:var(--warn); border-color:var(--warn) }
  .badge.key { color:var(--warn); border-color:var(--warn) }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:0 0 auto }
  .dot.on { background:var(--good) } .dot.off { background:var(--bad) } .dot.unknown { background:var(--muted) }
  .warn { color:var(--warn) }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px }
  button { font:inherit; font-size:13px; padding:5px 11px; border-radius:5px; border:1px solid var(--line);
           background:var(--card); color:var(--ink); cursor:pointer }
  button:hover { border-color:var(--accent); color:var(--accent) }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff }
  button.primary:hover { opacity:.9; color:#fff }
  button.danger:hover { border-color:var(--bad); color:var(--bad) }
  button:disabled { opacity:.45; cursor:default }
  form { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:16px }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px }
  label { display:block; font-size:12.5px; color:var(--muted); margin-bottom:4px }
  input,select { width:100%; font:inherit; font-size:14px; padding:6px 9px; border-radius:5px;
                 border:1px solid var(--line); background:var(--field); color:var(--ink) }
  .check { display:flex; align-items:center; gap:7px; font-size:13.5px; color:var(--ink); margin-top:22px }
  .check input { width:auto }
  .hint { font-size:12.5px; color:var(--muted); margin:10px 0 0 }
  .login { border-left:3px solid var(--accent); background:color-mix(in srgb,var(--accent) 8%,transparent);
           border-radius:0 5px 5px 0; padding:10px 13px; margin-top:10px; font-size:13.5px }
  .login .url { color:var(--muted); word-break:break-all }
  ul { margin:8px 0 0; padding-left:18px; font-size:13.5px } li { margin-bottom:3px }
  li span { color:var(--muted) }
  a { color:var(--accent) }
  .muted { color:var(--muted) }
  .err { color:var(--bad); font-size:13px; margin-top:8px }
  .sites { margin:10px 0 0; border-top:1px solid var(--line) }
  .site { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:9px 0; border-bottom:1px solid var(--line) }
  .site:last-child { border-bottom:0 }
  .site .who { font-size:13px; color:var(--muted); flex:1 1 200px; min-width:0 }
  .site .who b { color:var(--ink); font-weight:500 }
  .site .acts { display:flex; gap:6px; flex-wrap:wrap }
  .site button { padding:3px 9px; font-size:12.5px }
  .inline { padding:12px 0 4px; border-bottom:1px solid var(--line) }
  .inline .grid { grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px }
  .paused { color:var(--warn); font-size:12.5px; margin-top:8px }
  footer { margin-top:34px; color:var(--muted); font-size:12.5px }
</style>
<main>
  <h1>browser-personas</h1>
  <p class="sub" id="sub">One Chrome on port ${port}</p>

  <h2>Personas</h2>
  <div id="personas"></div>
  <p class="paused" id="paused" hidden>Live updates are paused while you are editing.</p>

  <h2>Add a persona</h2>
  <form id="new">
    <div class="grid">
      <div><label for="f-name">Name</label><input id="f-name" placeholder="katy" autocomplete="off"></div>
      <div><label for="f-origin">First website</label><input id="f-origin" placeholder="http://localhost:3005" autocomplete="off"></div>
      <div><label for="f-username">Who is this (optional)</label><input id="f-username" placeholder="katy@example.com" autocomplete="off"></div>
      <div><label for="f-probe">Signed-in path (optional)</label><input id="f-probe" placeholder="learned from your login" autocomplete="off"></div>
      <div><label for="f-env">Environment</label><input id="f-env" placeholder="staging" autocomplete="off"></div>
      <div><label for="f-ro">Read-only</label>
        <select id="f-ro">
          <option value="">off</option>
          <option value="strict">strict — GET only</option>
          <option value="inspect">inspect — plus reads sent as POST</option>
          <option value="cooperative">cooperative — mark writes, app decides</option>
        </select>
      </div>
      <div><label for="f-desc">Description</label><input id="f-desc" placeholder="Owner with an active renewal" autocomplete="off"></div>
      <div><label for="f-pw">Password (rarely needed)</label><input id="f-pw" type="password" autocomplete="new-password"></div>
      <label class="check"><input type="checkbox" id="f-excl"> One agent at a time</label>
    </div>
    <p class="hint"><b>Only the name and the app URL are required.</b> Press <b>Log in</b> and sign in
       however that site wants — a password form, Google, GitHub, SSO, a magic link, two factors. The
       login browser is unfenced, so the redirect to your identity provider works, and everything the
       sign-in leaves behind is captured: cookies for every origin involved, and the tokens apps keep
       in local storage. The provider origins are remembered too, so the persona can re-authenticate
       later without you widening anything by hand.</p>
    <p class="hint">A persona can hold several websites — add the rest from its card, and one
       sign-in session covers them all. Its websites are also its fence: outside them, this persona
       cannot be navigated anywhere. A stored password only buys the <b>Fill the form</b> button and is useless
       for OAuth, so leave it blank unless the site has a plain password form you re-enter often.</p>
    <div class="row"><button class="primary" id="create" type="submit">Create persona</button></div>
    <div class="err" id="new-err" hidden></div>
  </form>

  <h2>Agents</h2>
  <div id="agents"></div>

  <footer>Watch links open Chrome&rsquo;s own DevTools against a tab without taking it from the agent.
    This page is reachable only from this machine, and only with the token in its URL.</footer>
</main>
<script>
const TOKEN = new URLSearchParams(location.search).get("t") || "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let state = ${initial};
let busy = null;
/** Which inline form is open. Refresh pauses while one is, so typing is never clobbered. */
let open = { kind: null, persona: null, origin: null };

async function api(method, path, body) {
  const res = await fetch(path + (path.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(TOKEN), {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function loginFor(name) { return (state.logins || []).find((l) => l.persona === name); }

function siteRow(p, a) {
  const editing = open.kind === "site" && open.persona === p.name && open.origin === a.origin;
  if (editing) return inlineSiteForm(p, a);
  const who = [a.username ? "<b>" + esc(a.username) + "</b>" : "", a.role ? esc(a.role) : "",
               a.probe ? "signed-in path <code>" + esc(a.probe) + "</code>" : ""].filter(Boolean).join(" · ");
  return '<div class="site">' +
    '<div class="who"><code>' + esc(a.origin) + '</code>' + (who ? '<br>' + who : "") + '</div>' +
    '<div class="acts">' +
      '<button data-act="login" data-name="' + esc(p.name) + '" data-origin="' + esc(a.origin) + '">Log in</button>' +
      '<button data-act="edit-site" data-name="' + esc(p.name) + '" data-origin="' + esc(a.origin) + '">Edit</button>' +
      '<button class="danger" data-act="remove-site" data-name="' + esc(p.name) + '" data-origin="' + esc(a.origin) + '">Remove</button>' +
    '</div></div>';
}

function inlineSiteForm(p, a) {
  const v = (x) => esc(x || "");
  const isNew = !a;
  return '<div class="inline" data-form="site" data-name="' + esc(p.name) + '" data-origin="' + v(a && a.origin) + '">' +
    '<div class="grid">' +
      '<div><label>Website URL</label><input data-f="origin" value="' + v(a && a.origin) + '" placeholder="https://app.example.com"' + (isNew ? "" : " readonly") + '></div>' +
      '<div><label>Who is this</label><input data-f="username" value="' + v(a && a.username) + '" placeholder="katy@example.com"></div>' +
      '<div><label>Role</label><input data-f="role" value="' + v(a && a.role) + '" placeholder="homeowner"></div>' +
      '<div><label>Signed-in path</label><input data-f="probe" value="' + v(a && a.probe) + '" placeholder="learned from your login"></div>' +
    '</div>' +
    '<div class="row"><button class="primary" data-act="save-site" data-name="' + esc(p.name) + '">Save website</button>' +
    '<button data-act="cancel-edit">Cancel</button></div>' +
    (isNew ? "" : '<p class="hint">The URL is the website&rsquo;s identity here, so it cannot be edited. Remove it and add it again to change it.</p>') +
    '</div>';
}

function inlinePersonaForm(p) {
  const sel = (v) => (p.readOnly === v ? " selected" : "");
  return '<div class="inline" data-form="persona" data-name="' + esc(p.name) + '">' +
    '<div class="grid">' +
      '<div><label>Description</label><input data-f="description" value="' + esc(p.description || "") + '"></div>' +
      '<div><label>Environment</label><input data-f="env" value="' + esc(p.env || "") + '"></div>' +
      '<div><label>Read-only</label><select data-f="read_only">' +
        '<option value=""' + (p.readOnly ? "" : " selected") + '>off</option>' +
        '<option value="strict"' + sel("strict") + '>strict</option>' +
        '<option value="inspect"' + sel("inspect") + '>inspect</option>' +
        '<option value="cooperative"' + sel("cooperative") + '>cooperative</option>' +
      '</select></div>' +
      '<label class="check"><input type="checkbox" data-f="exclusive"' + (p.exclusive ? " checked" : "") + '> One agent at a time</label>' +
    '</div>' +
    '<div class="row"><button class="primary" data-act="save-persona" data-name="' + esc(p.name) + '">Save persona</button>' +
    '<button data-act="cancel-edit">Cancel</button></div></div>';
}

function personaCard(p) {
  const login = loginFor(p.name);
  const holders = p.holders.length === 0
    ? '<span class="muted">no agent connected</span>'
    : p.holders.length === 1
      ? 'held by <code>' + esc(p.holders[0].owner) + '</code>'
      : '<span class="warn">shared by ' + p.holders.length + ' agents</span>: ' +
        p.holders.map((h) => '<code>' + esc(h.owner) + '</code>').join(", ");

  const signedIn = login ? login.signedIn : null;
  const dot = signedIn === null ? "unknown" : signedIn ? "on" : "off";
  const dotTitle = signedIn === null ? "login state unknown — press Log in on a website" : signedIn ? "signed in" : "not signed in";

  const badges = [
    p.env ? '<span class="badge">' + esc(p.env) + '</span>' : "",
    p.exclusive ? '<span class="badge excl">exclusive</span>' : "",
    p.readOnly ? '<span class="badge ro">read-only: ' + esc(p.readOnly) + '</span>' : "",
    state.secrets && state.secrets[p.name] ? '<span class="badge key">password stored</span>' : "",
  ].join("");

  const headline = !login ? "" :
    login.finished ? '<b>Saved.</b> ' + (login.cookiesSaved || 0) + ' cookies kept.' :
    !login.signedIn ? '<b>Signing in to ' + esc(login.url) + '…</b> finish in the browser window that opened.' :
    login.autoFinish ? '<b>Signed in' + (login.identity ? ' as ' + esc(login.identity) : "") + ' — saving…</b>' :
    '<b>Signed in.</b> Save when you are done in that window.';

  const panel = login && !login.finished
    ? '<div class="login">' + headline +
      '<div class="url">now at ' + esc(login.currentUrl) + '</div>' +
      (login.identity && !login.signedIn ? '<div class="url">signing in as <b>' + esc(login.identity) + '</b></div>' : "") +
      (login.probeStatus !== null ? '<div class="url">' + esc(login.probeUrl || "") + ' &rarr; ' + login.probeStatus + '</div>' : "") +
      '<div class="row">' +
      (login.signedIn && !login.autoFinish
        ? '<button class="primary" data-act="finish" data-name="' + esc(p.name) + '">Save this login</button>'
        : "") +
      (login.autoFinish && !login.signedIn
        ? '<button data-act="hold" data-name="' + esc(p.name) + '">Do not save automatically</button>'
        : "") +
      (state.secrets && state.secrets[p.name] ? '<button data-act="autofill" data-name="' + esc(p.name) + '">Fill the form</button>' : "") +
      '<button data-act="cancel" data-name="' + esc(p.name) + '">Cancel</button>' +
      '</div></div>'
    : "";

  const addingSite = open.kind === "site" && open.persona === p.name && open.origin === "";
  const editingPersona = open.kind === "persona" && open.persona === p.name;

  return '<article>' +
    '<h3><span class="dot ' + dot + '" title="' + dotTitle + '"></span>' + esc(p.name) + badges + '</h3>' +
    (p.description ? '<p>' + esc(p.description) + '</p>' : "") +
    (p.authOrigins && p.authOrigins.length
      ? '<div class="scope">signs in through ' + p.authOrigins.map((o) => '<code>' + esc(o) + '</code>').join(", ") + '</div>'
      : "") +
    '<div class="holders">' + holders + '</div>' +
    (editingPersona ? inlinePersonaForm(p) : "") +
    '<div class="sites">' + (p.accounts || []).map((a) => siteRow(p, a)).join("") +
      (addingSite ? inlineSiteForm(p, null) : "") + '</div>' +
    '<div class="row">' +
      '<button data-act="add-site" data-name="' + esc(p.name) + '">Add website</button>' +
      '<button data-act="edit-persona" data-name="' + esc(p.name) + '">Edit persona</button>' +
      '<button class="danger" data-act="delete" data-name="' + esc(p.name) + '">Delete persona</button>' +
    '</div>' + panel +
    '</article>';
}

function agentCard(o) {
  const tabs = o.tabs.length === 0
    ? '<li class="muted">no tabs</li>'
    : o.tabs.map((t) =>
        '<li><a href="devtools://devtools/bundled/inspector.html?ws=' +
        esc(location.hostname + ":" + location.port + "/devtools/page/" + t.id) + '">watch</a> ' +
        '<span>' + esc(t.url || "about:blank") + '</span></li>').join("");
  return '<article><h3><code>' + esc(o.id) + '</code>' +
    (o.connected ? "" : '<span class="badge">disconnected</span>') + '</h3>' +
    '<div class="scope">persona <code>' + esc(o.persona) + '</code></div>' +
    '<ul>' + tabs + '</ul></article>';
}

function render() {
  document.getElementById("sub").textContent =
    "One Chrome on port " + state.port + " · " + (state.chromeAlive ? "running" : "not running") +
    " · " + state.owners.filter((o) => o.connected).length + " agent(s) connected";
  const pausedNote = document.getElementById("paused");
  if (pausedNote) pausedNote.hidden = !open.kind;
  document.getElementById("personas").innerHTML =
    state.personas.length
      ? state.personas.map(personaCard).join("")
      : '<article class="muted">No personas yet. Add one below, then press <b>Log in</b>.</article>';
  document.getElementById("agents").innerHTML =
    state.owners.length ? state.owners.map(agentCard).join("") : '<article class="muted">No agent has connected yet.</article>';
}

async function refresh(force) {
  // A two-second re-render would wipe whatever is half-typed in an open form.
  const loginRunning = (state.logins || []).some((l) => !l.finished);
  if (open.kind && !force && !loginRunning) return;
  try {
    state = await api("GET", "/api/state");
    render();
  } catch { /* the daemon may be restarting; the next tick will catch up */ }
}

function formValues(node) {
  const out = {};
  for (const el of node.querySelectorAll("[data-f]")) {
    out[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  return out;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button || busy) return;
  const { act, name, origin } = button.dataset;

  // Opening and closing a form is local; it must not wait on the network.
  if (act === "edit-site") { open = { kind: "site", persona: name, origin }; render(); return; }
  if (act === "add-site") { open = { kind: "site", persona: name, origin: "" }; render(); return; }
  if (act === "edit-persona") { open = { kind: "persona", persona: name, origin: null }; render(); return; }
  if (act === "cancel-edit") { open = { kind: null, persona: null, origin: null }; await refresh(true); return; }

  busy = act;
  button.disabled = true;
  try {
    if (act === "save-site") {
      const values = formValues(button.closest("[data-form]"));
      await api("PUT", "/api/personas/" + encodeURIComponent(name) + "/accounts", values);
      open = { kind: null, persona: null, origin: null };
    }
    if (act === "save-persona") {
      const values = formValues(button.closest("[data-form]"));
      await api("PATCH", "/api/personas/" + encodeURIComponent(name), values);
      open = { kind: null, persona: null, origin: null };
    }
    if (act === "remove-site" && confirm("Remove " + origin + " from " + name + "?")) {
      await api("DELETE", "/api/personas/" + encodeURIComponent(name) + "/accounts", { origin });
    }
    if (act === "login") await api("POST", "/api/personas/" + encodeURIComponent(name) + "/login", { origin });
    if (act === "autofill") await api("POST", "/api/personas/" + encodeURIComponent(name) + "/login/autofill", {});
    if (act === "hold") await api("POST", "/api/personas/" + encodeURIComponent(name) + "/login/hold", {});
    if (act === "finish") await api("POST", "/api/personas/" + encodeURIComponent(name) + "/login/finish", {});
    if (act === "cancel") await api("DELETE", "/api/personas/" + encodeURIComponent(name) + "/login");
    if (act === "delete" && confirm('Delete "' + name + '" and shred its saved login?')) {
      await api("DELETE", "/api/personas/" + encodeURIComponent(name));
    }
  } catch (err) { alert(err.message); }
  busy = null;
  await refresh(true);
});

document.getElementById("new").addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = document.getElementById("new-err");
  err.hidden = true;
  const value = (id) => document.getElementById(id).value.trim();
  try {
    await api("POST", "/api/personas", {
      name: value("f-name"),
      origin: value("f-origin"),
      username: value("f-username"),
      probe: value("f-probe"),
      env: value("f-env"),
      description: value("f-desc"),
      read_only: value("f-ro") || false,
      exclusive: document.getElementById("f-excl").checked,
      password: value("f-pw"),
    });
    for (const id of ["f-name","f-origin","f-username","f-probe","f-env","f-desc","f-pw"]) document.getElementById(id).value = "";
    document.getElementById("f-excl").checked = false;
    await refresh(true);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});

render();
refresh();
setInterval(refresh, 2000);
</script>`;
}
