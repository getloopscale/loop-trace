#!/usr/bin/env node
/**
 * Hermetic ForwardAuth broker shim (M22 invariant 6 — the REAL edge proof).
 *
 * Stands in for the theo-cloud Model B broker so the edge job can run with NO
 * theo-cloud dependency. Traefik's `forwardAuth` middleware calls this shim for
 * every `/v1/*` request; the shim implements the gateway contract:
 *
 *   1. Read the customer key from `X-Customer-Key: cust_<tenant>`.
 *   2. No / malformed key  → 401 (Traefik denies; the service is never reached).
 *   3. First time for a tenant → mint a per-tenant `theo_live_*` key by calling the
 *      lens service's REAL admin endpoint (`POST /v1/admin/keys`) with the platform
 *      bootstrap token, workspace_id = tenant, scopes [read,write,delete]. Cache it.
 *   4. Respond 200 with `Authorization: Bearer <minted>` — Traefik copies it upstream
 *      via `authResponseHeaders`. A companion Traefik headers middleware strips the
 *      customer key, so it NEVER reaches the service (CWE-441 edge half).
 *
 * No DB driver, no deps — Node 20 global fetch only. Run via `node:20-alpine`.
 */
import { createServer } from "node:http";

const API_URL = process.env.API_URL ?? "http://api:4318";
const BOOTSTRAP = process.env.BOOTSTRAP ?? "";
const PORT = Number(process.env.PORT ?? 4181);

/** tenant → minted `theo_live_*` secret (mint-once, then cache). */
const minted = new Map();

async function brokerKeyFor(tenant) {
  const cached = minted.get(tenant);
  if (cached) return cached;
  const res = await fetch(`${API_URL}/v1/admin/keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${BOOTSTRAP}`,
    },
    body: JSON.stringify({
      name: `broker-${tenant}`,
      workspace_id: tenant,
      scopes: ["lens:read", "lens:write", "lens:delete"],
    }),
  });
  if (!res.ok) {
    throw new Error(`mint failed for ${tenant}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  minted.set(tenant, body.secret);
  return body.secret;
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const customer = req.headers["x-customer-key"];
      const m = typeof customer === "string" ? customer.match(/^cust_(.+)$/) : null;
      if (!m) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "EDGE_DENIED", message: "customer key required" }));
        return;
      }
      const minted = await brokerKeyFor(m[1]);
      // Traefik copies `Authorization` upstream via authResponseHeaders.
      res.writeHead(200, { authorization: `Bearer ${minted}` });
      res.end();
    } catch (err) {
      // Fail closed — a broker error denies the request (never authorizes).
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "BROKER_UNAVAILABLE", message: String(err) }));
    }
  })();
});

server.listen(PORT, () => {
   
  console.log(JSON.stringify({ level: "info", msg: "forward-auth shim listening", port: PORT, api: API_URL }));
});
