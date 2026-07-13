/**
 * `SubagentRosterTracker` — accumulates the per-session roster of live
 * subagent tasks so a reconnecting client can rebuild swarm cards from the
 * session snapshot. The refresh flow subscribes at the snapshot watermark, so
 * earlier `subagent.spawned` events — the only carriers of the swarm identity
 * metadata — are never replayed to it.
 *
 * Owned by the `SessionEventBroadcaster` and updated inside its per-session
 * dispatch queue — same pattern as `InFlightTurnTracker`, keeping the roster,
 * the journal watermark, and fan-out order mutually consistent.
 *
 * Lifetime: the roster is dropped on the main agent's `turn.ended`. After the
 * main turn ends, the swarm's `<agent_swarm_result>` tool output is in the wire
 * transcript and becomes the restore source; this also bounds the roster's
 * lifetime (background subagents that outlive a turn are a known, pre-existing
 * bound — same trade-off as `InFlightTurnTracker`).
 */

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';
import type { Event, SnapshotSubagent } from '@moonshot-ai/protocol';

export class SubagentRosterTracker {
  private readonly bySession = new Map<string, Map<string, SnapshotSubagent>>();

  apply(sessionId: string, event: Event): void {
    switch (event.type) {
      case 'subagent.spawned': {
        let roster = this.bySession.get(sessionId);
        if (!roster) {
          roster = new Map();
          this.bySession.set(sessionId, roster);
        }
        roster.set(event.subagentId, {
          id: event.subagentId,
          session_id: sessionId,
          kind: 'subagent',
          description: event.description ?? event.subagentName ?? 'Sub Agent',
          status: 'running',
          subagent_phase: 'queued',
          subagent_type: event.subagentName,
          parent_tool_call_id: event.parentToolCallId,
          swarm_index: event.swarmIndex,
          run_in_background: event.runInBackground,
          created_at: new Date().toISOString(),
        });
        return;
      }
      case 'subagent.started': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'working';
        entry.suspended_reason = undefined;
        // Keep an existing started_at: a resumed (previously suspended)
        // subagent re-fires `subagent.started`.
        entry.started_at ??= new Date().toISOString();
        return;
      }
      case 'subagent.suspended': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'suspended';
        entry.suspended_reason = event.reason;
        return;
      }
      case 'task.started': {
        if (event.info.kind !== 'agent') return;
        const agentId = event.info.agentId;
        if (agentId === undefined) return;
        const entry = this.bySession.get(sessionId)?.get(agentId);
        if (!entry) return;
        entry.run_in_background = true;
        return;
      }
      case 'task.terminated': {
        if (event.info.kind !== 'agent' || event.info.status === 'running') return;
        const agentId = event.info.agentId;
        if (agentId === undefined) return;
        const entry = this.bySession.get(sessionId)?.get(agentId);
        if (!entry) return;
        entry.status =
          event.info.status === 'completed'
            ? 'completed'
            : event.info.status === 'killed'
              ? 'cancelled'
              : 'failed';
        entry.subagent_phase = event.info.status === 'completed' ? 'completed' : 'failed';
        entry.suspended_reason = undefined;
        entry.completed_at = new Date(event.info.endedAt ?? Date.now()).toISOString();
        return;
      }
      case 'subagent.completed': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'completed';
        entry.status = 'completed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.resultSummary;
        return;
      }
      case 'subagent.failed': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'failed';
        entry.status = 'failed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.error;
        return;
      }
      case 'turn.ended': {
        if (event.agentId !== MAIN_AGENT_ID) return;
        // After turn end the swarm's `<agent_swarm_result>` tool output is in
        // the wire transcript and becomes the restore source; dropping the
        // roster here also bounds its lifetime.
        this.bySession.delete(sessionId);
        return;
      }
      default:
        return;
    }
  }

  /** Fresh copies — callers must not mutate the tracked entries. */
  get(sessionId: string): SnapshotSubagent[] {
    const roster = this.bySession.get(sessionId);
    if (!roster) return [];
    return Array.from(roster.values(), (entry) => ({ ...entry }));
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
