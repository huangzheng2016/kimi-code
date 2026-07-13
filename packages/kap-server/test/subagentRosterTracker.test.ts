/**
 * `SubagentRosterTracker` — live subagent roster for snapshot rebuilds.
 */

import type { Event } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { SubagentRosterTracker } from '../src/transport/ws/v1/subagentRosterTracker';

const SID = 'sess_1';

function ev(partial: Record<string, unknown>): Event {
  return { agentId: 'main', sessionId: SID, ...partial } as unknown as Event;
}

function spawned(overrides: Record<string, unknown> = {}): Event {
  return ev({
    type: 'subagent.spawned',
    subagentId: 'agent_1',
    subagentName: 'explore',
    parentToolCallId: 'call_1',
    description: 'explore the auth flow',
    swarmIndex: 0,
    runInBackground: false,
    ...overrides,
  });
}

function taskTerminated(status: string, agentId = 'agent_1'): Event {
  return ev({
    type: 'task.terminated',
    info: {
      taskId: `task-${agentId}`,
      kind: 'agent',
      agentId,
      status,
      endedAt: 1_700_000_000_000,
    },
  });
}

describe('SubagentRosterTracker', () => {
  it('records the full swarm identity on spawn', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    expect(t.get(SID)).toMatchObject([
      {
        id: 'agent_1',
        session_id: SID,
        kind: 'subagent',
        description: 'explore the auth flow',
        status: 'running',
        subagent_phase: 'queued',
        subagent_type: 'explore',
        parent_tool_call_id: 'call_1',
        swarm_index: 0,
        run_in_background: false,
      },
    ]);
    expect(t.get(SID)[0]?.created_at).toBeDefined();
  });

  it('ignores lifecycle events for unknown subagent ids', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'ghost', resultSummary: 'x' }));
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'ghost' }));
    t.apply(SID, ev({ type: 'subagent.suspended', subagentId: 'ghost', reason: 'approval' }));
    expect(t.get(SID)).toEqual([]);
  });

  it('tracks suspend and resume, keeping the original started_at', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent_1' }));
    const startedAt = t.get(SID)[0]?.started_at;
    expect(startedAt).toBeDefined();

    t.apply(SID, ev({ type: 'subagent.suspended', subagentId: 'agent_1', reason: 'awaiting approval' }));
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'suspended',
      suspended_reason: 'awaiting approval',
    });

    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent_1' }));
    const resumed = t.get(SID)[0]!;
    expect(resumed.subagent_phase).toBe('working');
    expect(resumed.started_at).toBe(startedAt);
    expect(resumed.suspended_reason).toBeUndefined();
  });

  it('marks a foreground subagent as background when its Agent task detaches', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(
      SID,
      ev({
        type: 'task.started',
        info: {
          taskId: 'agent-task-1',
          kind: 'agent',
          agentId: 'agent_1',
          detached: true,
        },
      }),
    );
    expect(t.get(SID)[0]?.run_in_background).toBe(true);
  });

  it.each([
    ['completed', 'completed', 'completed'],
    ['failed', 'failed', 'failed'],
    ['timed_out', 'failed', 'failed'],
    ['killed', 'cancelled', 'failed'],
    ['lost', 'failed', 'failed'],
  ] as const)('maps Agent task terminal status %s into the snapshot', (taskStatus, status, phase) => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, taskTerminated(taskStatus));
    expect(t.get(SID)[0]).toMatchObject({
      status,
      subagent_phase: phase,
      completed_at: '2023-11-14T22:13:20.000Z',
    });
  });

  it('keeps a killed task terminal when subagent.completed arrives late', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, taskTerminated('killed'));
    const terminal = t.get(SID)[0];

    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent_1', resultSummary: 'late' }));

    expect(t.get(SID)[0]).toEqual(terminal);
  });

  it.each(['timed_out', 'lost'])('keeps %s terminal across late lifecycle events', (status) => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, taskTerminated(status));
    const terminal = t.get(SID)[0];

    t.apply(SID, ev({ type: 'subagent.failed', subagentId: 'agent_1', error: 'late' }));
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent_1' }));
    t.apply(SID, ev({ type: 'subagent.suspended', subagentId: 'agent_1', reason: 'late' }));
    t.apply(
      SID,
      ev({
        type: 'task.started',
        info: { kind: 'agent', agentId: 'agent_1', taskId: 'late-task' },
      }),
    );

    expect(t.get(SID)[0]).toEqual(terminal);
  });

  it('keeps running siblings updateable and ignores unknown ids after a terminal event', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, spawned({ subagentId: 'agent_2', swarmIndex: 1 }));
    t.apply(SID, taskTerminated('killed'));

    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent_2' }));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'ghost', resultSummary: 'late' }));

    expect(t.get(SID)).toMatchObject([
      { id: 'agent_1', status: 'cancelled', subagent_phase: 'failed' },
      { id: 'agent_2', status: 'running', subagent_phase: 'working' },
    ]);
  });

  it('lets a new spawn reset a terminal entry with the same agent id', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, taskTerminated('killed'));

    t.apply(SID, spawned({ description: 'new run', runInBackground: false }));

    expect(t.get(SID)[0]).toMatchObject({
      id: 'agent_1',
      description: 'new run',
      status: 'running',
      subagent_phase: 'queued',
      run_in_background: false,
    });
  });

  it('records completion with the result summary as output preview', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent_1', resultSummary: 'done' }));
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'completed',
      status: 'completed',
      output_preview: 'done',
    });
    expect(t.get(SID)[0]?.completed_at).toBeDefined();
  });

  it('records failure with the error as output preview', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, ev({ type: 'subagent.failed', subagentId: 'agent_1', error: 'boom' }));
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'failed',
      status: 'failed',
      output_preview: 'boom',
    });
  });

  it('keeps the roster when a child agent turn ends', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, spawned({ subagentId: 'agent_2', swarmIndex: 1 }));
    t.apply(
      SID,
      ev({ type: 'turn.ended', agentId: 'agent_1', turnId: 1, reason: 'completed' }),
    );
    expect(t.get(SID).map((entry) => entry.id)).toEqual(['agent_1', 'agent_2']);
  });

  it('drops the roster when the main agent turn ends', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    t.apply(SID, ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    expect(t.get(SID)).toEqual([]);
  });

  it('returns fresh copies that do not alias the tracked entries', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    const first = t.get(SID);
    first[0]!.status = 'failed';
    first.push({} as never);
    const second = t.get(SID);
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe('running');
  });

  it('clear drops the roster', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawned());
    expect(t.get(SID)).toHaveLength(1);
    t.clear(SID);
    expect(t.get(SID)).toEqual([]);
  });
});
