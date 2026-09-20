import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { accessState } from "../../../../server/session.ts";
import { BACKUP_NAME_PATTERN, backupsDirectory } from "../../../settings/backup-files.ts";

export const dynamic = "force-dynamic";

/**
 * Hands the owner a backup file they just made.
 *
 * The file is already encrypted under its own password (buildspec.md §18), but it is still the
 * whole ledger, so this is not a public download: the vault must be unlocked *and* the request
 * must carry this browser's session cookie. The cookie is `SameSite=Strict`, so a link on another
 * site cannot trigger the download on the owner's behalf.
 *
 * The `file` parameter is the only attacker-controlled input and it never reaches the filesystem
 * unless it matches `BACKUP_NAME_PATTERN` exactly — digits, one fixed prefix, one fixed suffix.
 * No slash, no `..`, no encoded separator can survive that, which is what rules out traversal.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  const access = await accessState();
  if (access.kind !== "ready") {
    return Response.json(
      { error: "unauthorized", detail: "Unlock the app in this browser first." },
      { status: 401, headers: NO_STORE },
    );
  }

  const file = new URL(request.url).searchParams.get("file") ?? "";
  if (!BACKUP_NAME_PATTERN.test(file)) {
    return Response.json({ error: "bad_file_name" }, { status: 400, headers: NO_STORE });
  }

  const path = join(backupsDirectory(), file);
  let payload: Buffer;
  try {
    // `lstat`, not `stat`: a symlink planted under a valid name must not be followed out of the folder.
    const info = await lstat(path);
    if (!info.isFile()) {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    payload = await readFile(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ error: "read_failed" }, { status: 500, headers: NO_STORE });
  }

  return new Response(new Uint8Array(payload), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      // Safe to interpolate: the name has already matched a pattern with no quote or control char.
      "content-disposition": `attachment; filename="${file}"`,
      "content-length": String(payload.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
