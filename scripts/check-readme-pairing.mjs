// Compares a bilingual README pair for structural equivalence.
//
// Both languages carry equal authority, so a pair is consistent when a reader
// gets the same document either way: the same heading tree, the same number of
// code blocks, the same list shapes, and the same link targets. Wording
// differences are the point; structure differences are drift.
//
// `README.md` is the Chinese default and every pair's English side sits next to
// it as `README.en.md`, mirroring the tree above.
//
// Usage: node scripts/check-readme-pairing.mjs [--write] [<readme.md> ...]
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every bilingual pair in the repository, listed by its Chinese-default side. */
const PAIRS = [
  'README.md',
  'packages/observational-memory/README.md',
  'packages/tool-observational-memory/README.md',
]

/**
 * Reduce one side to the signature a pair must share.
 * @param text - the markdown source.
 * @returns the structural signature.
 */
function signature(text) {
  const headings = []
  let fences = 0
  let listItems = 0
  const links = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      // Count openings only, so a paired open/close cannot drift by one.
      if (inFence) fences += 1
      continue
    }
    if (inFence) continue
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      headings.push(heading[1].length)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) listItems += 1
    for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
      // A pair points at the same document in each language, so the locale
      // suffix is not a difference: `README.en.md` and `README.md` are one role.
      links.push(match[1].replace(/\.en\.md(?=#|$)/, '.md'))
    }
  }
  // A table row is a list of cells; comparing counts catches a dropped row.
  const tableRows = text.split('\n').filter(line => /^\s*\|/.test(line)).length
  return { headings, fences, listItems, tableRows, links: links.sort() }
}

/** Describe the first structural difference, or undefined when the pair matches. */
function difference(left, right) {
  const a = signature(left)
  const b = signature(right)
  const parts = []
  if (a.headings.join(',') !== b.headings.join(',')) {
    parts.push(`heading depths ${a.headings.join(',')} vs ${b.headings.join(',')}`)
  }
  if (a.fences !== b.fences) parts.push(`code fences ${a.fences} vs ${b.fences}`)
  if (a.listItems !== b.listItems) parts.push(`list items ${a.listItems} vs ${b.listItems}`)
  if (a.tableRows !== b.tableRows) parts.push(`table rows ${a.tableRows} vs ${b.tableRows}`)
  if (a.links.join(' ') !== b.links.join(' ')) {
    const onlyA = a.links.filter(link => !b.links.includes(link))
    const onlyB = b.links.filter(link => !a.links.includes(link))
    parts.push(`links differ (en-only: ${onlyA.join(',') || 'none'}; zh-only: ${onlyB.join(',') || 'none'})`)
  }
  return parts.length === 0 ? undefined : parts.join('; ')
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const selected = args.filter(arg => !arg.startsWith('--'))
const root = fileURLToPath(new URL('..', import.meta.url))
const pairs = selected.length > 0 ? selected : PAIRS.map(pair => join(root, pair))

let failed = 0
const recorded = []
for (const chinese of pairs) {
  const english = chinese.replace(/README\.md$/, 'README.en.md')
  const en = readFileSync(english, 'utf8')
  const zh = readFileSync(chinese, 'utf8')
  const problem = difference(en, zh)
  const label = chinese.slice(root.length)
  if (problem === undefined) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}\n     ${problem}`)
  }
  recorded.push([label, en, zh])
}

if (write && failed === 0) {
  for (const [label, en, zh] of recorded) {
    const file = join(dirname(join(root, label)), 'README.i18n.yaml')
    const hash = text => createHash('sha1').update(`blob ${Buffer.byteLength(text, 'utf8')}\0${text}`).digest('hex')
    const header = [
      '# Bilingual-pair consistency record: the git blob hash of each side as of the',
      '# last confirmed-consistent state. Both languages carry equal authority; after',
      '# editing either side, bring the other along and re-record with:',
      '#   node scripts/check-readme-pairing.mjs --write',
    ].join('\n')
    const name = basename(label)
    writeFileSync(file, `${header}\n${name}: ${hash(zh)}\n${name.replace(/\.md$/, '.en.md')}: ${hash(en)}\n`)
    console.log(`     recorded ${file.slice(root.length)}`)
  }
}

console.log(`\n${pairs.length - failed}/${pairs.length} pair(s) consistent`)
process.exit(failed === 0 ? 0 : 1)
