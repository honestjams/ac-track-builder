// Data a build asked for and didn't get (an API down, tiles that never came back). The build goes
// ahead without it, so the UI and the headless script say so instead of shipping a quietly
// different track.

export const dataWarnings: string[] = [];

export function warnMissing(what: string): void {
  dataWarnings.push(what);
  console.warn("missing data:", what);
}

export function clearDataWarnings(): void {
  dataWarnings.length = 0;
}

/** fetch with retries on network errors, 429 and 5xx (backing off 1, 3, 7 s). A 404 is an answer. */
export async function fetchRetry(url: string, init?: RequestInit, attempts = 4): Promise<Response | null> {
  for (let a = 0; a < attempts; a++) {
    try {
      const r = await fetch(url, init);
      if (r.ok || r.status === 404) return r;
      if (r.status !== 429 && r.status < 500) return r;
    } catch {
      if (init?.signal?.aborted) return null;
    }
    if (a < attempts - 1) await new Promise((ok) => setTimeout(ok, 1000 * (2 ** (a + 1) - 1)));
  }
  return null;
}
