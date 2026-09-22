// What the web server hands out: the app and the shared rules, nothing else.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";

let dir, app;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-static-"));
  app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}` }), { logger: false });
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const get = (url) => app.inject({ method: "GET", url });

test("the app loads at the site root", async () => {
  const res = await get("/");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<script type="module" src="js\/app.js">/);
  assert.equal((await get("/js/app.js")).statusCode, 200);
  assert.equal((await get("/shared/rules.js")).statusCode, 200, "browser import of the shared rules");
});

test("old /frontend/index.html links redirect to the root", async () => {
  const res = await get("/frontend/index.html");
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "/");
});

test("backend source, docs and data are not served", async () => {
  for (const url of ["/backend/package.json", "/backend/src/http/config.js", "/CLAUDE.md",
    "/backend/data/gatepass.db", "/backend/.env", "/docs/SECURITY.md", "/../backend/package.json"]) {
    assert.equal((await get(url)).statusCode, 404, url);
  }
});
