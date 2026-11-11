import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELAY_RUNTIME_PACKAGES, RELAY_TOOLING_PACKAGES, buildRelayManifest, relayExternalPackages } from "../scripts/relay-runtime.mjs";

test("every third-party package the relay entries import is declared for the relay image (no guessing)", async () => {
  const { packages, sources } = await relayExternalPackages();
  assert.deepEqual(packages.filter((p: string) => !RELAY_RUNTIME_PACKAGES.includes(p)), [], "undeclared relay dependency");
  for (const expected of ["@google/genai", "dotenv", "ws"]) assert.ok(packages.includes(expected), `${expected} should be detected`);
  assert.ok(!packages.includes("next") && !packages.includes("react"), "the relay must not drag in the web framework");
  assert.ok(sources.some((s: string) => s.startsWith("src/lib/")), "the shared src/lib closure is part of the relay image");
});

test("relay manifest pins exact lockfile versions, includes tsx, and carries the relay scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const manifest = buildRelayManifest(pkg, lock);
  const deps = manifest.dependencies as Record<string, string>;
  for (const name of [...RELAY_RUNTIME_PACKAGES, ...RELAY_TOOLING_PACKAGES]) {
    assert.match(deps[name], /^\d+\.\d+\.\d+/, `${name} must be an exact version`);
    assert.equal(deps[name], lock.packages[`node_modules/${name}`].version);
  }
  assert.equal(manifest.scripts["start:voice"], pkg.scripts["start:voice"]);
  assert.ok(!("next" in deps));
});
