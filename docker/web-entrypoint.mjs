// Entrypoint of the `web` image target.
//
// NEXT_PUBLIC_* values are compiled into the browser bundle at `docker build` time. If a deploy
// passes different runtime values, the server and the browser would silently disagree (e.g. two
// different Supabase projects), so refuse to start. Provider keys are never part of this file.
import { readFileSync } from "node:fs";

const baked = JSON.parse(readFileSync(new URL("./public-env.json", import.meta.url), "utf8"));
const mismatched = Object.keys(baked).filter((name) => process.env[name] && process.env[name] !== baked[name]);
if (mismatched.length > 0 && process.env.AURAL_ALLOW_PUBLIC_ENV_MISMATCH !== "1") {
  console.error(
    `Refusing to start: runtime ${mismatched.join(", ")} differ from the values this image was built with. ` +
    "NEXT_PUBLIC_* settings are baked into the browser bundle; rebuild the image with matching --build-arg values " +
    "(or set AURAL_ALLOW_PUBLIC_ENV_MISMATCH=1 to override).",
  );
  process.exit(1);
}
await import("./server.js");
