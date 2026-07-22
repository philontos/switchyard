import type Database from "better-sqlite3";
import type { Provider } from "../core/db.js";

type DB = Database.Database;

// trim a body field to a non-empty string, or null — providers store the
// optional ANTHROPIC_* values, and "" must round-trip to NULL (== "unset").
export const str = (v: unknown): string | null => {
  const s = (v ?? "").toString().trim();
  return s || null;
};

// Map a provider row to the env claude is launched with. Only set the vars that
// are present, so a provider can override just the model, just the endpoint, etc.
// Returns undefined when there's nothing to inject (→ default claude login).
export function providerEnv(p?: Provider): Record<string, string> | undefined {
  if (!p) return undefined;
  const env: Record<string, string> = {};
  if (p.base_url) env.ANTHROPIC_BASE_URL = p.base_url;
  if (p.auth_token) env.ANTHROPIC_AUTH_TOKEN = p.auth_token;
  if (p.model) env.ANTHROPIC_MODEL = p.model;
  if (p.small_fast_model) env.ANTHROPIC_SMALL_FAST_MODEL = p.small_fast_model;
  return Object.keys(env).length ? env : undefined;
}

// Format + reachability gate for a provider, shared by the test endpoint (green
// light) and the create endpoint (enforced on save). The reachability probe
// mirrors how claude calls a compatible backend at runtime — same bearer token
// and same <base_url>/v1/messages path.
export async function checkProvider(body: any): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = str(body?.base_url);
  const token = str(body?.auth_token);
  const model = str(body?.model);
  if (!baseUrl) return { ok: false, error: "base_url required" };
  let u: URL;
  try { u = new URL(baseUrl); } catch { return { ok: false, error: "invalid base_url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "base_url must be http(s)" };
  if (!token) return { ok: false, error: "auth_token required" };
  if (!model) return { ok: false, error: "model required" };

  const endpoint = baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: ctl.signal,
    });
    if (r.ok) return { ok: true };
    let detail = "";
    try { const j: any = await r.json(); detail = j?.error?.message || j?.message || ""; } catch { /* non-JSON body */ }
    return { ok: false, error: `HTTP ${r.status}${detail ? ": " + detail : ""}` };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export function listProviders(db: DB): Provider[] {
  return db.prepare("SELECT * FROM providers ORDER BY id DESC").all() as Provider[];
}

export interface ProviderSummary {
  id: number;
  name: string;
  model: string | null;
}

/** Re-project any provider rows received over a node boundary to picker-safe metadata. */
export function providerSummaries(rows: unknown): ProviderSummary[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ""),
      model: row.model == null ? null : String(row.model),
    }))
    .filter((row) => Number.isInteger(row.id) && row.id > 0 && !!row.name);
}

/** Picker-safe provider metadata; credentials and endpoint coordinates stay local. */
export function providersForList(db: DB): ProviderSummary[] {
  return providerSummaries(listProviders(db));
}

export async function insertCheckedProvider(db: DB, body: any): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const { name } = body ?? {};
  if (!name || !String(name).trim()) return { ok: false, error: "name required" };
  const chk = await checkProvider(body ?? {});
  if (!chk.ok) return chk;
  const info = db.prepare(
    "INSERT INTO providers (name, base_url, auth_token, model, small_fast_model) VALUES (?,?,?,?,?)",
  ).run(String(name).trim(), str(body?.base_url), str(body?.auth_token), str(body?.model), str(body?.small_fast_model));
  return { ok: true, id: Number(info.lastInsertRowid) };
}
