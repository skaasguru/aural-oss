#!/usr/bin/env node
/**
 * Relay container dependency tooling. The voice relay (server/voice-relay.ts, run with tsx) needs
 * a handful of npm packages, not the whole web app tree. Rather than guessing, this script
 * measures the relay's real import closure with esbuild and compares it with a declared list.
 *
 *   node scripts/relay-runtime.mjs check             # fail if the relay imports an undeclared package
 *   node scripts/relay-runtime.mjs manifest <dir>    # write <dir>/package.json with versions pinned from package-lock.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Packages the relay may import (directly, or ws's optional native accelerators). */
export const RELAY_RUNTIME_PACKAGES = ["@google/genai", "dotenv", "ws", "bufferutil", "utf-8-validate"];
/** Needed to run the TypeScript sources as-is (`node --import tsx server/voice-relay.ts`). */
export const RELAY_TOOLING_PACKAGES = ["tsx"];
export const RELAY_ENTRIES = ["server/voice-relay.ts", "server/openai-voice-relay.ts"];

const packageName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** Real third-party packages imported by the entry's source closure (relative + `@/` paths resolved). */
export async function relayExternalPackages(entries = RELAY_ENTRIES) {
  const { build } = await import("esbuild"); // dev tool; not present in the relay image
  const found = new Set();
  const sources = new Set();
  for (const entry of entries) {
    const result = await build({
      entryPoints: [path.join(root, entry)], bundle: true, write: false, metafile: true, platform: "node", format: "esm",
      packages: "external", logLevel: "silent", tsconfig: path.join(root, "tsconfig.json"), absWorkingDir: root,
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imp of output.imports) {
        if (!imp.external) continue;
        const spec = imp.path.replace(/^node:/, "");
        if (builtinModules.includes(spec) || builtinModules.includes(spec.split("/")[0])) continue;
        found.add(packageName(spec));
      }
    }
    for (const input of Object.keys(result.metafile.inputs)) sources.add(input);
  }
  return { packages: [...found].sort(), sources: [...sources].sort() };
}

export function pinnedVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`${name} is not in package-lock.json`);
  return version;
}

export function buildRelayManifest(pkg, lock) {
  const dependencies = {};
  for (const name of [...RELAY_RUNTIME_PACKAGES, ...RELAY_TOOLING_PACKAGES].sort()) dependencies[name] = pinnedVersion(lock, name);
  return {
    name: "aural-relay-runtime", version: pkg.version, private: true, engines: pkg.engines,
    scripts: { "start:voice": pkg.scripts["start:voice"], "start:openai-voice": "node --import tsx server/openai-voice-relay.ts" },
    dependencies,
  };
}

const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

async function main() {
  const [command, outDir] = process.argv.slice(2);
  if (command === "check") {
    const { packages } = await relayExternalPackages();
    const undeclared = packages.filter((p) => !RELAY_RUNTIME_PACKAGES.includes(p));
    if (undeclared.length) {
      console.error(`relay imports packages missing from RELAY_RUNTIME_PACKAGES in scripts/relay-runtime.mjs: ${undeclared.join(", ")}`);
      process.exit(1);
    }
    console.log(`relay runtime packages OK: ${packages.join(", ")}`);
  } else if (command === "manifest" && outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(buildRelayManifest(readJson("package.json"), readJson("package-lock.json")), null, 2)}\n`);
  } else {
    console.error("usage: relay-runtime.mjs check | manifest <dir>");
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
