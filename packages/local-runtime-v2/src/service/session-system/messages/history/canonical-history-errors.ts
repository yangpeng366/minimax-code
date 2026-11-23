/**
 * Typed idempotency signals for canonical history writes.
 *
 * A duplicated message identity is not a programming error: it means the row is
 * already durable (a retried append, a replayed compaction, a restart). The
 * classes below extend `TypeError` because every pre-existing classifier on the
 * append/replace path treats that shape as a `TypeError`; the class replaces the
 * error-message text match without changing the message text itself.
 */

export type CanonicalHistoryIdentitySurface = 'append' | 'replace' | 'user-message-lane';

export class CanonicalHistoryDuplicateIdentityError extends TypeError {
  override readonly name = 'CanonicalHistoryDuplicateIdentityError';
  readonly surface: CanonicalHistoryIdentitySurface;
  readonly messageIds: readonly string[];

  constructor(surface: CanonicalHistoryIdentitySurface, messageIds: readonly string[]) {
    super(duplicateIdentityMessage(surface, messageIds));
    this.surface = surface;
    this.messageIds = Object.freeze([...messageIds]);
  }
}

/**
 * A replacement (compaction) was prepared against a parent revision that is no
 * longer active. Fail closed instead of minting a second generation for work
 * that is already durable.
 */
export class CanonicalHistoryParentRevisionMismatchError extends TypeError {
  override readonly name = 'CanonicalHistoryParentRevisionMismatchError';

  constructor(
    readonly sessionId: string,
    readonly expectedParentRevision: string,
    readonly activeRevision: string,
  ) {
    super(`Canonical history parent revision mismatch: ${sessionId}`);
  }
}

/** True for the typed signal and for providers that still throw the bare text. */
export function isDuplicateIdentityFailure(error: unknown): boolean {
  if (error instanceof CanonicalHistoryDuplicateIdentityError) return true;
  return error instanceof TypeError && /identity is duplicated/u.test(error.message);
}

function duplicateIdentityMessage(
  surface: CanonicalHistoryIdentitySurface,
  messageIds: readonly string[],
): string {
  const ids = messageIds.join(', ');
  if (surface === 'append') return `Canonical history append identity is duplicated: ${ids}`;
  if (surface === 'replace') return `Canonical history replacement identity is duplicated: ${ids}`;
  return `Canonical user message identity is duplicated: ${ids}`;
}
