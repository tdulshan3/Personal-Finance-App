/*
 * Entry point on the phone. Names the process, then hands over to Next's standalone server.
 *
 * Why this file exists: termox identifies a service by argv[0] and deliberately refuses to match on
 * a mention anywhere in the command line, because "a shell that merely mentions the name must not
 * be mistaken for the service" (home-lab-dashboard, services.py). Every Node process on this phone
 * is called `node`, and AutoClaim already occupies the "match the script path" fallback.
 *
 * Setting `process.title` rewrites /proc/<pid>/cmdline on Termux — verified on the device — so
 * argv[0] becomes `pfa-finance` and the dashboard can match it exactly. Immich does the same thing,
 * which the operations notes already document.
 *
 * The catch, found by looking at /proc after the first deploy: **Next.js sets its own title.** Once
 * booted it renames the process to `next-server (v16.3.5)`, overwriting anything set beforehand.
 * So the title is set again after the import resolves, and once more shortly after, because Next
 * does it during startup rather than at a single point. The timer is unref'd so it cannot hold the
 * process open.
 *
 * Run as: node start.js   (from the deployed app directory, beside server.js)
 */

const TITLE = "pfa-finance";

process.title = TITLE;

await import("./server.js");

// Next has now set its own title; take it back.
process.title = TITLE;

// ...and again, after its startup work has settled.
const settle = setTimeout(() => {
  process.title = TITLE;
}, 3000);
settle.unref();
