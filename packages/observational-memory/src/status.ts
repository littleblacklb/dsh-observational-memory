/**
 * What the memory workers have done, for `/om status` and the debug log.
 *
 * The background passes are invisible by design, which makes them hard to
 * diagnose when they are not running: an empty memory looks the same whether
 * the observer never ran, ran and failed, or ran and recorded nothing. This
 * module keeps the counts and the last failure so that question has an answer.
 *
 * @module @deepseek-ai/dsh-observational-memory/status
 */

/** One worker's outcome, as last observed in this process. */
export interface WorkerStatus {
  /** Passes that completed and wrote an event. */
  readonly recorded: number
  /** Passes that completed and deliberately wrote nothing. */
  readonly empty: number
  /** Passes that failed, including stream errors. */
  readonly failed: number
  /** Records a pass proposed that validation rejected. */
  readonly rejected: number
  /** Most recent failure message, or undefined when the last outcome was not a failure. */
  readonly lastError?: string
}

/** Every worker's status plus the last time a consolidation finished. */
export interface MemoryRuntimeStatus {
  readonly observer: WorkerStatus
  readonly reflector: WorkerStatus
  readonly dropper: WorkerStatus
  /** Wall-clock milliseconds of the last completed consolidation, if any. */
  readonly lastRunMs?: number
}

/** The worker names a status map tracks. */
export type WorkerName = keyof Pick<MemoryRuntimeStatus, 'observer' | 'reflector' | 'dropper'>

/** One worker's counters, mutated in place as passes complete. */
const WORKERS: readonly WorkerName[] = ['observer', 'reflector', 'dropper']

/** Start every worker at zero. */
function emptyStatus(): WorkerStatus {
  return { recorded: 0, empty: 0, failed: 0, rejected: 0 }
}

/**
 * Accumulates worker outcomes for one plugin instance.
 *
 * Counters are process-local and deliberately not durable: they describe what
 * this process has done, which is what makes them useful for answering "is it
 * working right now". Durable memory state lives in the log.
 */
export class MemoryStatus {
  private readonly workers: Record<WorkerName, WorkerStatus>
  private lastRunMs: number | undefined

  constructor() {
    this.workers = { observer: emptyStatus(), reflector: emptyStatus(), dropper: emptyStatus() }
  }

  /**
   * Record one completed pass.
   * @param worker - which worker ran.
   * @param outcome - what the pass produced.
   */
  record(worker: WorkerName, outcome: { recorded: number; rejected: number } | { failed: string }): void {
    const status = this.workers[worker]
    if ('failed' in outcome) {
      this.workers[worker] = {
        ...status,
        failed: status.failed + 1,
        lastError: outcome.failed,
      }
      return
    }
    this.workers[worker] = outcome.recorded > 0
      ? { ...status, recorded: status.recorded + 1, rejected: status.rejected + outcome.rejected }
      : { ...status, empty: status.empty + 1, rejected: status.rejected + outcome.rejected }
  }

  /**
   * Record that one consolidation finished.
   * @param durationMs - how long the whole consolidation took.
   */
  finishRun(durationMs: number): void {
    this.lastRunMs = durationMs
  }

  /**
   * Snapshot the current status for display.
   * @returns a frozen copy, so a reader cannot mutate the running counters.
   */
  snapshot(): MemoryRuntimeStatus {
    return {
      observer: this.workers.observer,
      reflector: this.workers.reflector,
      dropper: this.workers.dropper,
      ...this.lastRunMs === undefined ? {} : { lastRunMs: this.lastRunMs },
    }
  }
}

/**
 * Render the worker status as the lines `/om status` appends.
 * @param status - the current runtime status.
 * @returns one line per worker, then the last consolidation time when known.
 */
export function renderWorkerStatus(status: MemoryRuntimeStatus): string[] {
  const lines = WORKERS.map(worker => {
    const entry = status[worker]
    const parts = [`${String(entry.recorded)} recorded`, `${String(entry.empty)} empty`]
    if (entry.failed > 0) parts.push(`${String(entry.failed)} failed`)
    if (entry.rejected > 0) parts.push(`${String(entry.rejected)} rejected`)
    return `  ${worker}: ${parts.join(', ')}`
  })
  if (status.lastRunMs !== undefined) lines.push(`  last consolidation: ${String(status.lastRunMs)}ms`)
  const failures = WORKERS
    .map(worker => ({ worker, error: status[worker].lastError }))
    .filter(entry => entry.error !== undefined)
  for (const failure of failures) lines.push(`  ${failure.worker} error: ${failure.error as string}`)
  return lines
}
