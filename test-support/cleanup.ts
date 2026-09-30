export async function finishCleanup(bodyErrors: readonly unknown[], actions: readonly (() => unknown)[]): Promise<void> {
  const errors = [...bodyErrors];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Test body and cleanup failures");
}
