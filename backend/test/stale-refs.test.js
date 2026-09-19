// Cheap guards for the class of bug a refactor causes and nothing else catches:
// a reference to something that has moved. Both CONFIG bugs that broke the
// Societies tab would have failed here the moment they were made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (p) => readFile(join(root, p), "utf8");

test("every CONFIG.<key> used by the frontend actually exists", async () => {
  const config = await read("frontend/js/config.js");
  const defined = new Set([...config.matchAll(/^  ([a-zA-Z]+):/gm)].map((m) => m[1]));
  for (const file of ["frontend/js/app.js", "frontend/js/data.js"]) {
    const src = await read(file);
    for (const m of src.matchAll(/CONFIG\.([a-zA-Z]+)/g)) {
      assert.ok(defined.has(m[1]), `${file} uses CONFIG.${m[1]}, which config.js does not define`);
    }
  }
});

test("every name imported from shared/rules.js is exported by it", async () => {
  const rules = await read("shared/rules.js");
  const exported = new Set([
    ...[...rules.matchAll(/export (?:const|function|class) (\w+)/g)].map((m) => m[1]),
    ...[...rules.matchAll(/export \{([^}]+)\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())),
  ]);
  const importers = [
    "frontend/js/app.js", "frontend/js/data.js", "frontend/js/config.js",
    "backend/src/repo/bookings.js", "backend/src/repo/bookingWrites.js",
    "backend/src/repo/guestLinks.js", "backend/src/db/cli.js",
    "backend/src/http/routes/booking-actions.js",
  ];
  for (const file of importers) {
    const src = await read(file);
    for (const m of src.matchAll(/import \{([^}]+)\} from "[^"]*shared\/rules\.js"/g)) {
      for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        assert.ok(exported.has(name), `${file} imports ${name} from shared/rules.js, which does not export it`);
      }
    }
  }
});

test("every relative import resolves to a file that exists", async () => {
  const { readdir, stat } = await import("node:fs/promises");
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name.endsWith(".js")) files.push(rel.replace(/^\.\//, ""));
    }
  }
  await walk("./backend/src"); await walk("./frontend/js"); files.push("shared/rules.js");

  for (const file of files) {
    const src = await read(file);
    const dir = file.split("/").slice(0, -1).join("/");
    for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
      const target = join(root, dir, m[1]);
      await stat(target).catch(() => { throw new Error(`${file} imports ${m[1]}, which does not exist`); });
    }
  }
});
