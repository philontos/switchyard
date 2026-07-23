import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface OwnedServeRoute {
  httpsPort: number;
  localPort: number;
}

interface OwnedServeRoutesFile {
  schema: 1;
  routes: OwnedServeRoute[];
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function routePath(dataDir: string): string {
  return path.join(dataDir, "tailscale-serve-routes.json");
}

export function ownedServeRoutes(dataDir: string): OwnedServeRoute[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(routePath(dataDir), "utf8")) as Partial<OwnedServeRoutesFile>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.routes)) return [];
    return parsed.routes
      .filter((route): route is OwnedServeRoute =>
        validPort(route?.httpsPort) && validPort(route?.localPort))
      .map((route) => ({ httpsPort: route.httpsPort, localPort: route.localPort }));
  } catch {
    return [];
  }
}

function writeOwnedServeRoutes(dataDir: string, routes: OwnedServeRoute[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = routePath(dataDir);
  const temp = path.join(
    dataDir,
    `.tailscale-serve-routes.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  const body: OwnedServeRoutesFile = { schema: 1, routes };
  fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Remember every listener this instance asked Switchyard to configure. */
export function recordOwnedServeRoute(dataDir: string, route: OwnedServeRoute): void {
  if (!validPort(route.httpsPort) || !validPort(route.localPort)) {
    throw new Error("Tailscale Serve ownership ports must be integers between 1 and 65535");
  }
  const routes = ownedServeRoutes(dataDir)
    .filter((existing) => existing.httpsPort !== route.httpsPort);
  routes.push({ httpsPort: route.httpsPort, localPort: route.localPort });
  writeOwnedServeRoutes(dataDir, routes);
}

/** Forget a listener only after the safe network-off operation has succeeded. */
export function forgetOwnedServeRoute(dataDir: string, route: OwnedServeRoute): void {
  const routes = ownedServeRoutes(dataDir)
    .filter((existing) =>
      existing.httpsPort !== route.httpsPort || existing.localPort !== route.localPort);
  writeOwnedServeRoutes(dataDir, routes);
}
