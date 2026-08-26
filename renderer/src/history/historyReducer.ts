// Pure, framework-free undo/redo stack (no React dependency -- see
// HistoryContext.tsx for the thin React wrapper). Snapshots are compared by
// reference, not deep equality: every mutator in SceneContext/BrandPresetContext
// already produces a new object/array on change (immutable update pattern),
// so reference identity is a correct and cheap "did anything change" check,
// and storing 100 old snapshots costs nothing beyond the arrays that already existed.
export interface HistoryState<T> {
  past: T[]
  future: T[]
  transactionActive: boolean
  transactionBaseline: T | null
}

export function createHistoryState<T>(): HistoryState<T> {
  return { past: [], future: [], transactionActive: false, transactionBaseline: null }
}

function capHistory<T>(list: T[], maxHistory: number): T[] {
  return list.length > maxHistory ? list.slice(list.length - maxHistory) : list
}

/** Records a discrete, already-committed change (e.g. a button click). A
 * no-op while a transaction (drag/typing session) is active -- the eventual
 * `endTransaction` call records the whole session as one entry instead. */
export function recordChange<T>(state: HistoryState<T>, previousValue: T, maxHistory: number): HistoryState<T> {
  if (state.transactionActive) return state
  return { past: capHistory([...state.past, previousValue], maxHistory), future: [], transactionActive: false, transactionBaseline: null }
}

/** Starts a continuous-change session (pointer drag, text typing). Intermediate
 * changes during the session are suppressed by `recordChange` above; the
 * session's net effect becomes exactly one entry when `endTransaction` runs. */
export function beginTransaction<T>(state: HistoryState<T>, baseline: T): HistoryState<T> {
  return { ...state, transactionActive: true, transactionBaseline: baseline }
}

/** Ends a session started by `beginTransaction`. Records one entry (the
 * pre-session baseline) unless nothing actually changed. Safe to call without
 * a matching `beginTransaction` (no-op) or when nothing changed (no-op). */
export function endTransaction<T>(state: HistoryState<T>, finalValue: T, maxHistory: number): HistoryState<T> {
  if (!state.transactionActive) return state
  const baseline = state.transactionBaseline
  if (baseline === null || baseline === finalValue) {
    return { ...state, transactionActive: false, transactionBaseline: null }
  }
  return { past: capHistory([...state.past, baseline], maxHistory), future: [], transactionActive: false, transactionBaseline: null }
}

export interface HistoryStep<T> {
  state: HistoryState<T>
  value: T
}

export function undoStep<T>(state: HistoryState<T>, currentValue: T): HistoryStep<T> | null {
  if (state.past.length === 0) return null
  const value = state.past[state.past.length - 1]
  return {
    value,
    state: { ...state, past: state.past.slice(0, -1), future: [currentValue, ...state.future] }
  }
}

export function redoStep<T>(state: HistoryState<T>, currentValue: T): HistoryStep<T> | null {
  if (state.future.length === 0) return null
  const value = state.future[0]
  return {
    value,
    state: { ...state, past: [...state.past, currentValue], future: state.future.slice(1) }
  }
}
