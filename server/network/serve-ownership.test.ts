import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  forgetOwnedServeRoute,
  ownedServeRoutes,
  recordOwnedServeRoute,
} from "./serve-ownership.ts";

test("Tailscale Serve ownership records exact instance-local routes and replaces one HTTPS port safely", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-serve-ownership-"));
  try {
    recordOwnedServeRoute(dataDir, { httpsPort: 443, localPort: 4500 });
    recordOwnedServeRoute(dataDir, { httpsPort: 14500, localPort: 14500 });
    assert.deepEqual(ownedServeRoutes(dataDir), [
      { httpsPort: 443, localPort: 4500 },
      { httpsPort: 14500, localPort: 14500 },
    ]);

    recordOwnedServeRoute(dataDir, { httpsPort: 14500, localPort: 15500 });
    assert.deepEqual(ownedServeRoutes(dataDir), [
      { httpsPort: 443, localPort: 4500 },
      { httpsPort: 14500, localPort: 15500 },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Tailscale Serve ownership forgets only the exact route after network off", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-serve-ownership-"));
  try {
    recordOwnedServeRoute(dataDir, { httpsPort: 443, localPort: 4500 });
    forgetOwnedServeRoute(dataDir, { httpsPort: 443, localPort: 9999 });
    assert.deepEqual(ownedServeRoutes(dataDir), [{ httpsPort: 443, localPort: 4500 }]);
    forgetOwnedServeRoute(dataDir, { httpsPort: 443, localPort: 4500 });
    assert.deepEqual(ownedServeRoutes(dataDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
