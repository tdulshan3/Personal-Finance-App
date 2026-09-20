import type { NextConfig } from "next";

/*
 * buildspec.md §3 places the database on the phone and makes it the authority. Here the phone runs
 * the whole server under Termux, so the build must produce something that starts with a plain
 * `node server.js`: SWC's prebuilt binaries target glibc/musl and will not load against Termux's
 * bionic libc. `standalone` output is compiled here on the PC and copied across, so nothing on the
 * phone ever needs to run the compiler.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,

  // The one native dependency. Bundling it would break the .node binary resolution in standalone
  // output, and on the phone it has to be the copy that was compiled against Termux's own clang.
  serverExternalPackages: ["better-sqlite3-multiple-ciphers"],

  experimental: {
    // Money crosses the server/client boundary as decimal strings (buildspec.md §16), never as
    // JS numbers, so there is nothing here that needs a custom serializer.
    typedRoutes: true,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // buildspec.md §18: the UI must not be able to pull remote images or scripts, so a
          // sanitized bank email can never phone home from a rendered excerpt.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "img-src 'self' data:",
              "style-src 'self' 'unsafe-inline'",
              "script-src 'self' 'unsafe-inline'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
