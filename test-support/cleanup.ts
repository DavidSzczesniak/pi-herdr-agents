function throwFailures(errors: readonly unknown[]): void {
  const failures: unknown[] = [];
  const collect = (error: unknown) => {
    if (error instanceof AggregateError && error.errors.length) error.errors.forEach(collect);
    else failures.push(error);
  };
  errors.forEach(collect);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Test body and cleanup failures");
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
