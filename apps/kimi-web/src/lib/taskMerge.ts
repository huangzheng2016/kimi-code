import type { AppTask } from '../api/types';

/**
 * Append the live-only swarm subagents that a fresh REST `/tasks` list does not
 * contain.
 *
 * REST `/tasks` lists only the main agent's background-task store — it never
 * returns foreground swarm subagents (kind `'subagent'`), which arrive purely
 * through the WS event stream. Both the session-load task fetch and the 1s
 * output poll rebuild `tasksBySession` from that REST list, so a plain replace
 * would drop the subagents on every refresh and the next event would re-add
 * them, flickering the swarm/subagent cards (and their live "currently doing"
 * line) about once per second.
 *
 * Keep WS-owned subagent tasks that REST omits, so the REST refresh only governs
 * background tasks. REST stays authoritative for anything it does return.
 */
export function keepLiveSubagents(restBased: AppTask[], existing: AppTask[]): AppTask[] {
  const restIds = new Set(restBased.map((t) => t.id));
  const liveSubagents = existing.filter((t) => t.kind === 'subagent' && !restIds.has(t.id));
  return liveSubagents.length === 0 ? restBased : [...restBased, ...liveSubagents];
}

/**
 * Seed the task store from the snapshot's subagent roster. When present, the
 * roster is authoritative for all subagents, while reducer-owned accumulated
 * output (outputLines/text) and non-subagent tasks survive the seed. Older
 * servers omit the roster, so `undefined` keeps the existing store unchanged.
 */
export function mergeSnapshotSubagents(
  roster: AppTask[] | undefined,
  existing: AppTask[],
): AppTask[] {
  if (roster === undefined) return existing;
  const existingById = new Map(existing.map((t) => [t.id, t] as const));
  const rosterIds = new Set(roster.map((t) => t.id));
  const merged = roster.map((task) => {
    const live = existingById.get(task.id);
    if (!live) return task;
    return { ...task, outputLines: live.outputLines, text: live.text };
  });
  const kept = existing.filter((t) => t.kind !== 'subagent' && !rosterIds.has(t.id));
  if (merged.length === 0 && kept.length === existing.length) return existing;
  return kept.length === 0 ? merged : [...merged, ...kept];
}
