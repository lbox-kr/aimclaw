/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes).
 *
 * Two observed modes, with different recovery:
 * - A one-off torn read: a single fresh read-only connection catches a page
 *   mid-host-commit. The next open sees a consistent view again — callers
 *   polling on an interval should treat this as "data not visible yet" and
 *   retry (2026-07-15 read_current_thread incident: the tool's poller threw
 *   once while the main poll loop read the same file cleanly).
 * - A poisoned kernel page cache: every fresh open in the container keeps
 *   seeing the same broken view. Reopening does NOT recover; only a fresh
 *   container mount does. The poll loop exits after a streak of these so the
 *   host respawns the container (see CORRUPTION_STREAK_EXIT in poll-loop.ts).
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}
