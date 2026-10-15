/**
 * Decide what a dropped browser socket should do next.
 *
 * The relay's unauthenticated `GET /health` is `{ok:true}` and omits `agent`.
 * A logged-in response includes `agent`. The LAN bridge has no `/health` and
 * falls through to the SPA, which is not that JSON.
 *
 * `pageBody` is only consulted when this attempt never received hello and the
 * relay says the desktop is up. A document without the app shell is an access
 * gate (relay login, pairing, or waiting page) and a reload shows it.
 */
export function bridgeRecovery(healthBody: string, pageBody: string | null): "reload" | "retry" {
  if (isUnauthenticatedRelayHealth(healthBody)) return "reload";
  if (pageBody !== null && !isAppShell(pageBody)) return "reload";
  return "retry";
}

/** Logged-in relay health that reports the selected desktop is connected. */
export function relayDesktopUp(healthBody: string): boolean {
  const health = parseHealth(healthBody);
  return health?.ok === true && health.agent === true;
}

function isUnauthenticatedRelayHealth(healthBody: string): boolean {
  const health = parseHealth(healthBody);
  return health?.ok === true && !("agent" in health);
}

function parseHealth(healthBody: string): { ok?: unknown; agent?: unknown } | null {
  try {
    const value: unknown = JSON.parse(healthBody);
    if (!value || typeof value !== "object") return null;
    return value as { ok?: unknown; agent?: unknown };
  } catch {
    return null;
  }
}

function isAppShell(html: string): boolean {
  return html.includes('id="root"') || html.includes("id='root'");
}
