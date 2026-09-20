import { requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { BackupCard } from "./backup-card.tsx";
import { listBackups } from "./backup-files.ts";

const SHOWN = 10;

/**
 * The server half of the Backup card: reads which backups already exist on this device and hands
 * the card plain strings. Dates are formatted here, in the owner's timezone, so the browser's own
 * zone never gets a say and the server and client render the same text.
 */
export async function BackupSection() {
  // The Settings page has already checked this. Repeating it keeps the listing safe wherever this
  // component is rendered from, and costs one cookie read.
  const access = await accessState();
  if (access.kind !== "ready") return null;

  const zone = requireService().zone;
  const existing = listBackups(SHOWN).map((file) => ({
    name: file.name,
    sizeText: formatBytes(file.bytes),
    savedText: new Date(file.modifiedAt).toLocaleString("en-GB", {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }),
  }));

  return <BackupCard existing={existing} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
