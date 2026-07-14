/**
 * Web daemon projector contract for transcript isolation, task progress, and
 * client-visible error projection.
 */

import { describe, expect, it } from 'vitest';
import { classifyFrame, createAgentProjector, subagentProgressText } from '../src/api/daemon/agentEventProjector';

describe('subagentProgressText', () => {
  it('drops turn.step.started as noise', () => {
    expect(subagentProgressText('turn.step.started', {})).toBeNull();
  });

  it('summarizes a read tool call with its path', () => {
    const text = subagentProgressText('tool.use', { name: 'read', args: { path: 'src/foo.ts' } });
    expect(text).toContain('src/foo.ts');
    expect(text).not.toContain('"path"');
  });

  it('summarizes a bash tool call with its command', () => {
    const text = subagentProgressText('tool.call.started', { name: 'bash', args: { command: 'pnpm test' } });
    expect(text).toContain('pnpm test');
    expect(text).not.toContain('"command"');
  });

  it('drops tool.result lines as noise', () => {
    expect(subagentProgressText('tool.result', { name: 'read' })).toBeNull();
    expect(subagentProgressText('tool.result', { name: 'Read_0' })).toBeNull();
  });

  it('returns tool.progress update text', () => {
    expect(subagentProgressText('tool.progress', { update: { text: 'working…' } })).toBe('working…');
  });

  it('caps a long tool.progress text', () => {
    const long = 'x'.repeat(3000);
    const text = subagentProgressText('tool.progress', { update: { text: long } });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(long.length);
    expect(text!.endsWith('…')).toBe(true);
  });

  it('returns null for unknown event types', () => {
    expect(subagentProgressText('turn.delta', {})).toBeNull();
  });
});

describe('subagent streaming text', () => {
  it('forwards a subagent assistant.delta as a text-kind taskProgress', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: 'Hello' }, 's1');
    expect(events).toContainEqual({
      type: 'taskProgress',
      sessionId: 's1',
      taskId: 'sub-1',
      outputChunk: 'Hello',
      stream: 'stdout',
      kind: 'text',
    });
  });

  it('drops an empty subagent assistant.delta', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: '' }, 's1');
    expect(events).toEqual([]);
  });
});

describe('detached Agent task projection', () => {
  it('keeps a detached Agent as one subagent keyed by its task resource id', () => {
    const projector = createAgentProjector();
    projector.project(
      'subagent.spawned',
      { subagentId: 'agent-1', description: 'Review files', runInBackground: false },
      's1',
    );

    const events = projector.project(
      'task.started',
      {
        info: {
          taskId: 'agent-task-1',
          agentId: 'agent-1',
          kind: 'agent',
          status: 'running',
          startedAt: 1_700_000_000_000,
        },
      },
      's1',
    );

    expect(events).toEqual([
      {
        type: 'taskCreated',
        sessionId: 's1',
        task: expect.objectContaining({
          id: 'agent-task-1',
          agentId: 'agent-1',
          kind: 'subagent',
          runInBackground: true,
        }),
      },
    ]);
  });

  it('keeps the task resource id on later subagent lifecycle events', () => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.project(
      'task.started',
      { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } },
      's1',
    );

    const events = projector.project(
      'subagent.completed',
      { subagentId: 'agent-1', resultSummary: 'done' },
      's1',
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({
          id: 'agent-task-1',
          status: 'completed',
        }),
      }),
    );
  });

  it.each([
    ['completed', 'completed', 'completed'],
    ['failed', 'failed', 'failed'],
    ['timed_out', 'failed', 'failed'],
    ['killed', 'cancelled', 'failed'],
    ['lost', 'failed', 'failed'],
  ] as const)('maps Agent task terminal status %s', (taskStatus, status, phase) => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.project(
      'task.started',
      { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } },
      's1',
    );

    const events = projector.project(
      'task.terminated',
      {
        info: {
          taskId: 'agent-task-1',
          agentId: 'agent-1',
          kind: 'agent',
          status: taskStatus,
          endedAt: 1_700_000_000_000,
        },
      },
      's1',
    );

    expect(events).toEqual([
      {
        type: 'taskCompleted',
        sessionId: 's1',
        taskId: 'agent-task-1',
        agentId: 'agent-1',
        status,
        subagentPhase: phase,
        completedAt: '2023-11-14T22:13:20.000Z',
        runInBackground: true,
      },
    ]);
  });

  it('does not let late ordinary lifecycle events reopen a terminated Agent', () => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.project(
      'task.started',
      { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } },
      's1',
    );
    const stopped = projector.project(
      'task.terminated',
      {
        info: {
          taskId: 'agent-task-1',
          agentId: 'agent-1',
          kind: 'agent',
          status: 'killed',
          endedAt: 1_700_000_000_000,
        },
      },
      's1',
    );
    expect(stopped).toContainEqual(
      expect.objectContaining({ type: 'taskCompleted', status: 'cancelled' }),
    );

    expect(projector.project('task.started', { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } }, 's1')).toEqual([]);
    expect(projector.project('subagent.completed', { subagentId: 'agent-1', resultSummary: 'late' }, 's1')).toEqual([]);
    expect(projector.project('subagent.started', { subagentId: 'agent-1' }, 's1')).toEqual([]);
  });

  it('allows task.started after a new spawned run resets a terminal Agent', () => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.project(
      'task.started',
      { info: { taskId: 'old-task', agentId: 'agent-1', kind: 'agent' } },
      's1',
    );
    projector.project(
      'task.terminated',
      { info: { taskId: 'old-task', agentId: 'agent-1', kind: 'agent', status: 'killed' } },
      's1',
    );
    projector.project('subagent.spawned', { subagentId: 'agent-1', description: 'new run' }, 's1');

    expect(
      projector.project(
        'task.started',
        { info: { taskId: 'new-task', agentId: 'agent-1', kind: 'agent' } },
        's1',
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({ id: 'new-task', status: 'running', runInBackground: true }),
      }),
    );
  });

  it('seeds snapshot ownership so a late detach task.started updates the foreground row', () => {
    const projector = createAgentProjector();
    projector.seedSubagents('s1', [
      {
        id: 'agent-1',
        agentId: 'agent-1',
        sessionId: 's1',
        kind: 'subagent',
        description: 'Review files',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        runInBackground: false,
      },
    ]);

    expect(
      projector.project(
        'task.started',
        { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } },
        's1',
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({ id: 'agent-task-1', agentId: 'agent-1', runInBackground: true }),
      }),
    );
  });

  it('ignores a late task.started after a terminal snapshot seed', () => {
    const projector = createAgentProjector();
    projector.seedSubagents('s1', [
      {
        id: 'agent-task-1',
        agentId: 'agent-1',
        sessionId: 's1',
        kind: 'subagent',
        description: 'Review files',
        status: 'cancelled',
        subagentPhase: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        runInBackground: true,
      },
    ]);

    expect(
      projector.project(
        'task.started',
        { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } },
        's1',
      ),
    ).toEqual([]);
  });

  it('ignores an old task.started after a newer detached task owns the run', () => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.project(
      'task.started',
      { info: { taskId: 'new-task', agentId: 'agent-1', kind: 'agent' } },
      's1',
    );

    expect(
      projector.project(
        'task.started',
        { info: { taskId: 'old-task', agentId: 'agent-1', kind: 'agent' } },
        's1',
      ),
    ).toEqual([]);
  });

  it('ignores an old task termination after a new spawned run', () => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.project(
      'task.started',
      { info: { taskId: 'old-task', agentId: 'agent-1', kind: 'agent' } },
      's1',
    );
    projector.project('subagent.spawned', { subagentId: 'agent-1', description: 'new run' }, 's1');

    expect(
      projector.project(
        'task.terminated',
        { info: { taskId: 'old-task', agentId: 'agent-1', kind: 'agent', status: 'killed' } },
        's1',
      ),
    ).toEqual([]);
  });

  it('drops projector members omitted by an authoritative snapshot', () => {
    const projector = createAgentProjector();
    projector.project('subagent.spawned', { subagentId: 'agent-1' }, 's1');
    projector.seedSubagents('s1', []);

    expect(projector.project('subagent.started', { subagentId: 'agent-1' }, 's1')).toEqual([]);
    expect(projector.project('assistant.delta', { agentId: 'agent-1', delta: 'late' }, 's1')).toEqual([]);
  });

  it('keeps legacy lifecycle recovery when an older snapshot omits the roster', () => {
    const projector = createAgentProjector();
    projector.seedSubagents('s1', undefined);

    expect(projector.project('subagent.started', { subagentId: 'agent-1' }, 's1')).toContainEqual(
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({ id: 'agent-1', status: 'running' }),
      }),
    );
    expect(
      projector.project(
        'task.started',
        { info: { taskId: 'agent-task-1', agentId: 'agent-1', kind: 'agent' } },
        's1',
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({ id: 'agent-task-1', runInBackground: true }),
      }),
    );
  });
});

describe('agent error projection', () => {
  it('drops a subagent error instead of surfacing it as a session warning', () => {
    const projector = createAgentProjector();

    expect(
      projector.project(
        'error',
        { agentId: 'sub-1', code: 'provider.rate_limit', message: 'Rate limited' },
        's1',
      ),
    ).toEqual([]);
  });

  it('keeps a main-agent error visible to the session', () => {
    const projector = createAgentProjector();

    expect(
      projector.project(
        'error',
        { agentId: 'main', code: 'provider.rate_limit', message: 'Rate limited' },
        's1',
      ),
    ).toEqual([
      {
        type: 'unknown',
        raw: {
          _agentError: true,
          code: 'provider.rate_limit',
          message: 'Rate limited',
        },
      },
    ]);
  });
});

describe('cron.fired', () => {
  it('synthesizes a user message so the cron notice renders live', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'cron.fired',
      {
        origin: {
          kind: 'cron_job',
          jobId: 'a3f9c2',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 2,
          stale: false,
        },
        prompt: 'Check the deploy status',
      },
      's1',
    );
    const created = events.find((e) => e.type === 'messageCreated');
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      type: 'messageCreated',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Check the deploy status' }],
        metadata: { origin: { kind: 'cron_job', jobId: 'a3f9c2' } },
      },
    });
  });

  it('ignores cron.fired events missing a prompt or a cron_job origin', () => {
    const projector = createAgentProjector();
    expect(projector.project('cron.fired', { origin: { kind: 'cron_job' } }, 's1')).toEqual([]);
    expect(projector.project('cron.fired', { prompt: 'hi' }, 's1')).toEqual([]);
  });
});

describe('cron.fired prompt id isolation', () => {
  it('omits promptId so the synthesized notice does not clobber the abort cache', () => {
    const projector = createAgentProjector();
    projector.project(
      'prompt.submitted',
      { promptId: 'pr_user', userMessageId: 'u1', content: [{ type: 'text', text: 'hi' }] },
      's1',
    );
    const events = projector.project(
      'cron.fired',
      {
        origin: {
          kind: 'cron_job',
          jobId: 'j',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
        prompt: 'Check the deploy status',
      },
      's1',
    );
    const created = events.find((e) => e.type === 'messageCreated');
    expect(created).toBeDefined();
    expect((created as { message: { promptId?: string } }).message.promptId).toBeUndefined();
  });
});

describe('classifyFrame cron.fired', () => {
  it('routes both raw and event.-prefixed cron.fired to the agent projector', () => {
    const payload = { origin: { kind: 'cron_job' }, prompt: 'x' };
    expect(classifyFrame('cron.fired', payload)).toEqual({ route: 'agent', agentType: 'cron.fired' });
    expect(classifyFrame('event.cron.fired', payload)).toEqual({ route: 'agent', agentType: 'cron.fired' });
  });
});

// Session status has a single source: the daemon's event.session.status_changed
// (mapped by toAppEvent). The raw turn stream must NOT project a second
// sessionStatusChanged per transition — when it did, every turn end fired
// turn-end consumers (completion notification, sound) twice.
describe('session status single-sourcing', () => {
  it('turn.started projects no sessionStatusChanged', () => {
    const projector = createAgentProjector();
    const events = projector.project('turn.started', { turnId: 1 }, 's1');
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
  });

  it('turn.ended finalizes the message and usage but projects no sessionStatusChanged', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    const events = projector.project(
      'turn.ended',
      { turnId: 1, reason: 'completed', durationMs: 123 },
      's1',
    );
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'messageUpdated', status: 'completed', durationMs: 123 }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionUsageUpdated' }));
  });

  it('seedInFlight returns only the seeded message — status comes from the snapshot', () => {
    const projector = createAgentProjector();
    const events = projector.seedInFlight('s1', {
      turnId: 1,
      assistantText: 'partial',
      thinkingText: '',
      runningTools: [],
    });
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'messageCreated',
        message: expect.objectContaining({ role: 'assistant' }),
      }),
    );
  });
});

describe('step-boundary delta alignment', () => {
  it('resets stream offsets at step boundaries — a post-step delta ahead of local state signals a gap', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    projector.project('assistant.delta', { turnId: 1, delta: 'step-one text' }, 's1', { offset: 0 });
    projector.project('turn.step.completed', { turnId: 1, step: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 2 }, 's1');

    const events = projector.project('assistant.delta', { turnId: 1, delta: 'tail' }, 's1', { offset: 12 });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'historyCompacted', reason: 'delta_gap' }),
    );
  });

  it('appends step-2 deltas to the fresh step message at step-relative offsets', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    projector.project('assistant.delta', { turnId: 1, delta: 'step one' }, 's1', { offset: 0 });
    projector.project('turn.step.completed', { turnId: 1, step: 1 }, 's1');

    const step2 = projector.project('turn.step.started', { turnId: 1, step: 2 }, 's1');
    const created = step2.find((e) => e.type === 'messageCreated');
    const msgId = (created as { message: { id: string } } | undefined)?.message.id;
    expect(msgId).toBeDefined();

    // Offset restarts at 0 for the new step and appends to ITS message.
    const events = projector.project('assistant.delta', { turnId: 1, delta: 'step two' }, 's1', { offset: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'assistantDelta',
        messageId: msgId,
        delta: { text: 'step two' },
      }),
    );
  });

  it('seeds only the current step and aligns live deltas against the seeded length', () => {
    const projector = createAgentProjector();
    const seeded = projector.seedInFlight('s1', {
      turnId: 7,
      promptId: 'pr_1',
      thinkingText: 'step two thinking',
      assistantText: 'step two partial',
      runningTools: [{ toolCallId: 'tc_1', name: 'bash', args: { command: 'ls' } }],
    });
    const created = seeded.find((e) => e.type === 'messageCreated');
    const message = (created as { message: { id: string; content: unknown[] } } | undefined)?.message;
    expect(message).toBeDefined();

    expect(message!.content).toEqual([
      { type: 'thinking', thinking: 'step two thinking' },
      { type: 'text', text: 'step two partial' },
      { type: 'toolUse', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'ls' } },
    ]);

    const dup = projector.project('assistant.delta', { turnId: 7, delta: 'two part' }, 's1', { offset: 5 });
    expect(dup).toEqual([]);

    const cont = projector.project(
      'assistant.delta',
      { turnId: 7, delta: ' continues' },
      's1',
      { offset: 'step two partial'.length },
    );
    expect(cont).toContainEqual(
      expect.objectContaining({
        type: 'assistantDelta',
        messageId: message!.id,
        contentIndex: 3,
        delta: { text: ' continues' },
      }),
    );
  });
});
