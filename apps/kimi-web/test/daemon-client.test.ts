// apps/kimi-web/test/daemon-client.test.ts
// DaemonKimiWebApi wire → app mapping for session goal and snapshot endpoints.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const WIRE_GOAL = {
  goalId: 'goal_1',
  objective: 'fix all lint warnings',
  status: 'active',
  turnsUsed: 1,
  tokensUsed: 0,
  wallClockMs: 0,
  budget: {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

const WIRE_SESSION_SNAPSHOT = {
  as_of_seq: 3,
  epoch: 'epoch_1',
  session: {
    id: 'sess_1',
    title: 'Test session',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:01.000Z',
    status: 'idle',
    archived: false,
    metadata: { cwd: '/workspace' },
    agent_config: { model: 'test-model' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 3,
  },
  messages: { items: [], has_more: false },
  in_flight_turn: null,
  pending_approvals: [],
  pending_questions: [],
};

function createApi(): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    serverHttpUrl: 'http://daemon.test',
    clientId: 'web_test',
    clientName: 'test',
    clientVersion: '0.0.0',
    clientUiMode: 'test',
  });
}

describe('DaemonKimiWebApi.getSessionGoal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a present goal snapshot', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_GOAL));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal?.objective).toBe('fix all lint warnings');
    expect(goal?.status).toBe('active');
    expect(goal?.turnsUsed).toBe(1);
  });

  it('maps null to null (no active goal)', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal).toBeNull();
  });

  it('requests the session goal endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    await createApi().getSessionGoal('sess_42');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess_42/goal',
    );
  });
});

describe('DaemonKimiWebApi.getSessionSnapshot', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves an omitted subagent roster from an older server', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_SESSION_SNAPSHOT));

    const snapshot = await createApi().getSessionSnapshot('sess_1');

    expect(snapshot.subagents).toBeUndefined();
  });

  it('preserves an explicitly empty authoritative subagent roster', async () => {
    vi.mocked(fetch).mockResolvedValue(
      envelope({ ...WIRE_SESSION_SNAPSHOT, subagents: [] }),
    );

    const snapshot = await createApi().getSessionSnapshot('sess_1');

    expect(snapshot.subagents).toEqual([]);
  });
});
