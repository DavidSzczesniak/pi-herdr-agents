function throwFailures(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Test body and cleanup failures");
}

export function finishCleanupSync(bodyErrors: readonly unknown[], actions: readonly (() => void)[]): void {
  const errors = [...bodyErrors];
  for (const action of actions) {
    try { action(); } catch (error) { errors.push(error); }
  }
  throwFailures(errors);
}

export async function finishCleanup(bodyErrors: readonly unknown[], actions: readonly (() => unknown)[]): Promise<void> {
  const errors = [...bodyErrors];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  throwFailures(errors);
}
