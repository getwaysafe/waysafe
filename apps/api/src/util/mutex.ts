/**
 * A real FIFO async mutex -- a chain of promises, not a flag -- so two
 * concurrent `run` calls genuinely execute back-to-back, in the order they
 * were called. Used by every in-memory repository that needs to simulate a
 * Postgres row lock (`InMemoryAuthorizationRepository`'s per-mandate lock,
 * `InMemoryEvidenceRepository`'s per-organization lock): it proves the
 * *service's* locking logic is correct, but only a real transaction against
 * real Postgres (see the `prisma-repository.ts` files' `disableLockForTesting`
 * negative controls) proves the database itself serializes two connections
 * the same way.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
