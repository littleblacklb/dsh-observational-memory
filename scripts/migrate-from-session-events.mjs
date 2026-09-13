// Migrates memory written by the frozen log-backed line into the ledger store.
//
// The frozen line recorded memory as `memory/*` session events; this line keeps
// it in a per-session store. Both fold the same three transitions, so a replay
// of the events through the store reproduces the ledger exactly — including the
// idempotence guards, which is why this can be re-run safely.
//
// Dry run by default: it reports what it would write and touches nothing.
//
//   node scripts/migrate-from-session-events.mjs
//   node scripts/migrate-from-session-events.mjs --write
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyDrops, applyObservations, applyReflections, emptyMemoryState,
  MemoryStore, resolveDshHome, resolveStorageDir,
} from '../packages/observational-memory/lib/index.js'

const args = process.argv.slice(2)
const write = args.includes('--write')
const force = args.includes('--force')
const flag = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const home = resolveDshHome()
const sessionsRoot = flag('--sessions-root') ?? join(home, 'sessions')
const storeDir = flag('--store-dir') ?? resolveStorageDir()

/** Every session log under the sessions root, compressed or not. */
function logs() {
  const found = []
  for (const workspace of readdirSync(sessionsRoot)) {
    const workspaceDir = join(sessionsRoot, workspace)
    if (!statSync(workspaceDir).isDirectory()) continue
    for (const session of readdirSync(workspaceDir)) {
      for (const name of ['session.v3.jsonl.zstd', 'session.v3.jsonl']) {
        const file = join(workspaceDir, session, name)
        if (existsSync(file)) found.push({ session, file, compressed: name.endsWith('.zstd') })
      }
    }
  }
  return found
}

/**
 * Parse one log into its events.
 *
 * A `.zstd` log is a concatenation of independently compressed frames, one per
 * append, which is why this shells out rather than using `zlib.zstdDecompress`:
 * the Node API decodes the first frame only and silently returns a fraction of
 * the log. The `zstd` CLI reads the whole container.
 */
function events(file, compressed) {
  const text = compressed
    ? execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
    : readFileSync(file, 'utf8')
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/** Fold this session's memory events, exactly as the store would. */
function fold(memoryEvents) {
  let state = emptyMemoryState()
  for (const event of memoryEvents) {
    const data = event.data ?? {}
    if (event.type === 'memory/observations-recorded') {
      state = applyObservations(state, data.observations ?? [], data.coversUpToSeq)
    } else if (event.type === 'memory/reflections-recorded') {
      state = applyReflections(state, data.reflections ?? [], data.coversUpToSeq)
    } else if (event.type === 'memory/observations-dropped') {
      state = applyDrops(state, data.observationIds ?? [], data.coversUpToSeq)
    }
  }
  return state
}

const store = new MemoryStore({ storageDir: storeDir, warn: message => console.log(`warn ${message}`) })
let migrated = 0
let skipped = 0

for (const { session, file, compressed } of logs()) {
  let parsed
  try {
    parsed = events(file, compressed)
  } catch (error) {
    console.log(`skip  ${session}  (unreadable: ${String(error).slice(0, 60)})`)
    continue
  }
  const memoryEvents = parsed.filter(event => typeof event.type === 'string' && event.type.startsWith('memory/'))
  if (memoryEvents.length === 0) continue

  const state = fold(memoryEvents)
  const counts = `${String(state.reflections.length)} reflections, ${String(state.observations.length)} observations, ${String(state.dropped.length)} dropped`
  const coverage = `observer ${String(state.coverage.observer)} / reflector ${String(state.coverage.reflector)} / dropper ${String(state.coverage.dropper)}`

  // The store writes the moment a pass lands, so a dry run has to stop here.
  if (!write) {
    console.log(`dry   ${session}  ${memoryEvents.length} events -> ${counts}  [${coverage}]`)
    migrated += 1
    continue
  }

  const already = store.state(session)
  const present = already.observations.length + already.reflections.length + already.dropped.length
  if (present > 0 && !force) {
    console.log(`keep  ${session}  ledger already holds ${String(present)} records (use --force to replay)`)
    skipped += 1
    continue
  }

  for (const event of memoryEvents) {
    const data = event.data ?? {}
    if (event.type === 'memory/observations-recorded') {
      store.recordObservations(session, data.observations ?? [], data.coversUpToSeq)
    } else if (event.type === 'memory/reflections-recorded') {
      store.recordReflections(session, data.reflections ?? [], data.coversUpToSeq)
    } else if (event.type === 'memory/observations-dropped') {
      store.recordDrops(session, data.observationIds ?? [], data.coversUpToSeq)
    }
  }
  console.log(`wrote ${session}  ${memoryEvents.length} events -> ${counts}  [${coverage}]`)
  migrated += 1
}

console.log(`\n${String(migrated)} session(s) ${write ? 'migrated' : 'would be migrated'}${skipped > 0 ? `, ${String(skipped)} already present` : ''}`)
console.log(`store: ${storeDir}`)
if (!write) console.log('dry run — pass --write to apply')