/** Observability must never hide a successfully created VM from its owner. */
export function recordStartedVm(start, record, warn = () => {}) {
  return async (input) => {
    const run = await start(input);
    try {
      await record(run);
    } catch {
      try {
        warn('VM recording failed; lifecycle journal and inventory cleanup remain required');
      } catch {}
    }
    return run;
  };
}
