/**
 * Web storage capture and replay.
 *
 * Cookies are only half of a modern login. Firebase, Supabase, Auth0's SPA SDK and MSAL
 * all keep their tokens in `localStorage`, so a jar of cookies alone restores a session
 * that the application still considers signed out. Capturing storage is what makes the
 * "log in however the site wants, once" promise true for sites that do not use cookies
 * for auth at all.
 *
 * Reading and writing it needs a document on that origin — the browser will not hand you
 * another origin's storage — so both directions open a throwaway tab and close it.
 */

export type OriginStorage = { local: Record<string, string>; session: Record<string, string> };
export type StorageByOrigin = Record<string, OriginStorage>;

type Cdp = {
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
};

const READ_SCRIPT = `(() => {
  const dump = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key !== null) out[key] = store.getItem(key) ?? "";
      }
    } catch { /* storage can be blocked by policy; an empty object is the honest answer */ }
    return out;
  };
  return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
})()`;

function writeScript(storage: OriginStorage): string {
  return `(() => {
    const load = (store, data) => {
      try { for (const [k, v] of Object.entries(data)) store.setItem(k, v); } catch {}
    };
    load(window.localStorage, ${JSON.stringify(storage.local)});
    load(window.sessionStorage, ${JSON.stringify(storage.session)});
    return true;
  })()`;
}

/** Open a tab on `url`, run `expression` in it, close the tab. */
async function inTabOn(
  cdp: Cdp,
  url: string,
  expression: string,
  browserContextId?: string,
): Promise<unknown> {
  const created = await cdp.send("Target.createTarget", {
    url,
    ...(browserContextId ? { browserContextId } : {}),
  });
  const targetId = typeof created["targetId"] === "string" ? (created["targetId"] as string) : null;
  if (!targetId) return null;
  try {
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = typeof attached["sessionId"] === "string" ? (attached["sessionId"] as string) : null;
    if (!sessionId) return null;
    // The document has to exist before its storage does.
    await cdp
      .send("Runtime.evaluate", { expression: "new Promise(r => setTimeout(r, 250))", awaitPromise: true }, sessionId, 10_000)
      .catch(() => undefined);
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
      15_000,
    );
    return (result["result"] as { value?: unknown } | undefined)?.value ?? null;
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

export async function captureStorage(
  cdp: Cdp,
  origins: string[],
  browserContextId?: string,
): Promise<StorageByOrigin> {
  const out: StorageByOrigin = {};
  for (const origin of origins) {
    try {
      const value = (await inTabOn(cdp, `${origin}/`, READ_SCRIPT, browserContextId)) as OriginStorage | null;
      if (!value) continue;
      const hasAnything = Object.keys(value.local).length + Object.keys(value.session).length > 0;
      if (hasAnything) out[origin] = value;
    } catch {
      // One unreachable origin must not lose the rest of the login.
    }
  }
  return out;
}

export async function restoreStorage(
  cdp: Cdp,
  storage: StorageByOrigin,
  browserContextId?: string,
): Promise<number> {
  let restored = 0;
  for (const [origin, values] of Object.entries(storage)) {
    try {
      const ok = await inTabOn(cdp, `${origin}/`, writeScript(values), browserContextId);
      if (ok === true) restored++;
    } catch {
      /* the app may be down; the cookies still went back */
    }
  }
  return restored;
}
