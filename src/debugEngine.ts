export const DEBUG_ENGINES = ['debugpy', 'experimental'] as const;

export type DebugEngine = typeof DEBUG_ENGINES[number];

export const DEFAULT_DEBUG_ENGINE: DebugEngine = 'debugpy';

export function isDebugEngine(value: unknown): value is DebugEngine {
  return typeof value === 'string' && (DEBUG_ENGINES as readonly string[]).includes(value);
}

export function normalizeDebugEngine(value: unknown): DebugEngine {
  return isDebugEngine(value) ? value : DEFAULT_DEBUG_ENGINE;
}

export function debugEngineDisplayName(engine: DebugEngine): string {
  return engine === 'experimental' ? 'Experimental Native Tracer' : 'debugpy';
}

export function supportsHotReload(_engine: DebugEngine): boolean {
  return true;
}
