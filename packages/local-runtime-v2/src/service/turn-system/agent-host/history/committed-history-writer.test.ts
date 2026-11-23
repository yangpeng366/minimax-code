import { describe, expect, it, vi } from 'vitest';

import type { AgentEventContext, AgentEventDelivery } from '../events/contracts.js';
import { CanonicalHistoryDuplicateIdentityError } from '../../../session-system/messages/history/canonical-history-errors.js';
import { AgentHostCommittedHistoryWriter } from './committed-history-writer.js';
import type {
  CanonicalHistoryChange,
  CanonicalHistoryCommit,
  CanonicalHistorySnapshot,
  CanonicalHistoryStore,
} from './contracts.js';

const CONTEXT: AgentEventContext = {
  sessionId: 'session-writer',
  turnId: 'turn-writer',
  turnSequence: 1,
};

const USER_ROW = { role: 'user' as const, content: 'retried', timestamp: 1 };

describe('committed history writer append idempotency', () => {
  it('resolves a retried append as already durable without failing the Session', async () => {
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-settled',
      messages: [USER_ROW],
      identityVector: ['msg-user-v1-durable'],
    };
    const history = createHistory(settled, () => {
      throw new CanonicalHistoryDuplicateIdentityError('append', ['msg-user-v1-durable']);
    });
    const delivered: string[] = [];
    const historyFailure = { fail: vi.fn(async () => {}) };
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents((change) => delivered.push(change.committedRevision)),
      historyFailure,
    });

    const committed = await writer.commit(CONTEXT, appendChange());

    expect(committed.committedRevision).toBe('r-settled');
    expect(committed.committedMessages).toEqual([USER_ROW]);
    expect(delivered).toEqual(['r-settled']);
    expect(historyFailure.fail).not.toHaveBeenCalled();
  });

  it('keeps the failure path when the duplicated identity is not the committed tail', async () => {
    const settled: CanonicalHistorySnapshot = {
      revision: 'r-settled',
      messages: [{ role: 'assistant', content: 'other', timestamp: 2 }],
      identityVector: ['msg-assistant-other'],
    };
    const history = createHistory(settled, () => {
      throw new CanonicalHistoryDuplicateIdentityError('append', ['msg-user-v1-foreign']);
    });
    const historyFailure = { fail: vi.fn(async () => {}) };
    const writer = new AgentHostCommittedHistoryWriter({
      history,
      events: createEvents(() => {}),
      historyFailure,
    });

    await expect(writer.commit(CONTEXT, appendChange())).rejects.toThrow(
      CanonicalHistoryDuplicateIdentityError,
    );
    expect(historyFailure.fail).toHaveBeenCalledTimes(1);
  });
});

function appendChange(): CanonicalHistoryChange & {
  readonly operation: { readonly id: string; readonly kind: 'append' };
} {
  return {
    sessionId: CONTEXT.sessionId,
    turnId: CONTEXT.turnId,
    reason: 'messageDelta',
    messages: [USER_ROW],
    operation: { id: 'op-append-1', kind: 'append' },
  };
}

function createHistory(
  settled: CanonicalHistorySnapshot,
  append: () => Promise<CanonicalHistoryCommit>,
): CanonicalHistoryStore {
  return {
    read: async () => settled,
    append: async () => append(),
    replace: async () => {
      throw new Error('unexpected replace');
    },
  };
}

function createEvents(onCommitted: (change: { readonly committedRevision: string }) => void) {
  return {
    handleHistoryCommitted: async (
      _context: AgentEventContext,
      change: { readonly committedRevision: string },
    ) => onCommitted(change),
  } as unknown as AgentEventDelivery;
}
