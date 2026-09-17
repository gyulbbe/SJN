/** Photo-derived observations follow their own run; public model weights keep their existing cache. */
export type AnalysisCachePolicy = 'persistent' | 'transient';
const transientSignals = new WeakSet<AbortSignal>();

/** Create a private signal so a caller's shared cancellation signal never changes another run's policy. */
export function photoAnalysisSignal(
  parent: AbortSignal | undefined,
  policy: AnalysisCachePolicy,
): AbortSignal | undefined {
  if (policy !== 'transient') return parent;
  const signal = parent ? AbortSignal.any([parent]) : new AbortController().signal;
  transientSignals.add(signal);
  return signal;
}
export function analysisCacheAllowed(signal?: AbortSignal | null): boolean {
  return !signal || !transientSignals.has(signal);
}
