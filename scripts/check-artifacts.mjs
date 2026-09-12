// Loads the BUILT artifacts under plain Node, which is what a profile loader
// does. The unit suite runs the TypeScript sources through vitest, so nothing
// else covers module resolution in the published shape — and a missing shared
// chunk is exactly the bug that would only appear here.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as domain from '../packages/observational-memory/lib/index.js'
import * as startup from '../packages/observational-memory/lib/startup.js'
import * as tool from '../packages/tool-observational-memory/lib/index.js'

/** Resolve a repository path regardless of the working directory. */
const at = relative => fileURLToPath(new URL(`../${relative}`, import.meta.url))

const checks = []
const check = (label, ok, detail = '') => checks.push({ label, ok, detail })

check('domain exports name', domain.name === 'observational-memory', domain.name)
check('domain requires no llm', !domain.inject.includes('llm'), domain.inject.join(','))
check(
  'domain requires the projection registry',
  domain.inject.includes('sessionProjections'),
  domain.inject.join(','),
)
check('domain exports MemoryStore', typeof domain.MemoryStore === 'function')
check('domain exports renderMemory', typeof domain.renderMemory === 'function')
check('domain exports memoryId', typeof domain.memoryId === 'function')

check('startup default is a class', typeof startup.default === 'function')
check(
  'engine injects the published store',
  startup.default.inject.includes('observationalMemoryStore'),
  startup.default.inject.join(','),
)
check('engine no longer injects sessionProjections', !startup.default.inject.includes('sessionProjections'))
check('startup re-exports readMemory', typeof startup.readMemory === 'function')

check(
  'tool injects the published store',
  tool.inject.includes('observationalMemoryStore'),
  tool.inject.join(','),
)

// The artifact has to actually work, not just import: write a ledger through the
// built store and read it back off disk.
const dir = mkdtempSync(join(tmpdir(), 'om-artifact-'))
const store = new domain.MemoryStore({ storageDir: dir, warn: message => { throw new Error(message) } })
const observation = {
  id: domain.memoryId('a fact'),
  content: 'a fact',
  timestamp: '2026-01-15 14:30',
  relevance: 'high',
  sourceSeqs: [0],
}
store.recordObservations('session-1', [observation], 3)
check('ledger file written', readdirSync(dir).includes('session-1.json'), readdirSync(dir).join(','))
const reopened = new domain.MemoryStore({ storageDir: dir, warn: () => {} })
check('ledger round-trips', reopened.state('session-1').observations.length === 1)
check('coverage persisted', reopened.state('session-1').coverage.observer === 3)

// The engine renders from that ledger with no model call.
const rendered = domain.renderMemory([], reopened.state('session-1').observations)
check('memory renders for the model', rendered.includes('a fact'), JSON.stringify(rendered.slice(0, 80)))

// The built package must not reference a file the tarball omits.
const libDir = at('packages/observational-memory/lib')
const entry = readFileSync(join(libDir, 'index.js'), 'utf8')
for (const match of entry.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
  const sibling = match[1].replace('./', '')
  check(`sibling chunk shipped: ${sibling}`, readdirSync(libDir).includes(sibling))
}

let failed = 0
for (const { label, ok, detail } of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  [${detail}]`}`)
}
console.log(`\n${checks.length - failed}/${checks.length} artifact checks passed`)
process.exit(failed === 0 ? 0 : 1)
