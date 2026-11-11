/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // The container `web` target sets AURAL_NEXT_OUTPUT=standalone to ship only the traced files.
  // Everything else (npm run dev/build/start) keeps the default output.
  ...(process.env.AURAL_NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  serverExternalPackages: [
    "pdf-parse",
    "ws",
    "bufferutil",
    "utf-8-validate",
  ],
};

export default nextConfig;
