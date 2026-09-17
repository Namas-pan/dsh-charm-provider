/**
 * Fail the build if a credential ever travels with this repository.
 *
 * Three checks, none of which prints a secret:
 *
 *   1. EXACT — when a live Hyper key is available (`HYPER_API_KEY`, or the
 *      managed store `$DSH_HOME/.credentials.yaml`), it must not appear in any
 *      file under the package root. Skipped where no key exists, which is the
 *      case in CI.
 *   2. SHAPE — every credential-shaped string (`sk-hyper-…`, other providers'
 *      `sk-…`, PEM private keys) is listed redacted and classified. A value is
 *      REAL-LOOKING when it has 20+ alphanumerics after the prefix; placeholders
 *      such as `sk-hyper-...` or `sk-hyper-test` are reported but tolerated.
 *   3. The scan covers tracked and untracked files alike, so a scratch file left
 *      in the tree before `git add` is caught too.
 *
 * `node_modules`, `dist` and `.git` are skipped: the first two are gitignored
 * build inputs, and history is a separate question (`git log --all -S`).
 *
 * Usage: node scripts/check-secrets.mjs [--repo <dir>]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const repoArgument = argv.indexOf('--repo')
const REPO = resolve(repoArgument >= 0 ? argv[repoArgument + 1] : PACKAGE_ROOT)

/** Directories whose contents are never part of the published source. */
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage'])

/** Credential shapes worth failing on, most specific first. */
const SHAPES = [
  { name: 'hyper', pattern: /sk-hyper-[A-Za-z0-9._-]{3,}/g, realAfter: /^[A-Za-z0-9]{20,}$/ },
  { name: 'provider', pattern: /sk-(?!hyper-)[A-Za-z0-9]{24,}/g, realAfter: null },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, realAfter: null },
]

/** The live key, or undefined. Never logged. */
function readKey() {
  if (typeof process.env.HYPER_API_KEY === 'string' && process.env.HYPER_API_KEY.trim().length > 0) {
    return process.env.HYPER_API_KEY.trim()
  }
  if (process.env.CHECK_SECRETS_SKIP_STORE === '1') return undefined
  const store = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), '.credentials.yaml')
  if (!existsSync(store)) return undefined
  const text = readFileSync(store, 'utf-8')
  const inline = /^\s*HYPER_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m.exec(text)
  if (inline !== null) return inline[1]
  const nested = /^\s*HYPER_API_KEY\s*:\s*\n(?:\s+\w+:.*\n)*?\s+value\s*:\s*["']?([^"'\s#]+)["']?/m.exec(text)
  return nested === null ? undefined : nested[1]
}

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, found)
    else if (entry.isFile()) found.push(path)
  }
  return found
}

if (!existsSync(REPO)) {
  console.error(`check-secrets: no package at ${REPO}`)
  process.exit(1)
}

const key = readKey()
console.log(`check-secrets: root ${REPO}`)
console.log(`check-secrets: live key ${key === undefined ? 'not available (exact check skipped)' : `loaded (${key.length} chars, never printed)`}`)

const files = walk(REPO)
const exactHits = []
const shaped = []

for (const path of files) {
  let text
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    continue // binary or unreadable: no text credential can hide in it
  }
  const name = relative(REPO, path).replaceAll('\\', '/')
  if (key !== undefined && text.includes(key)) exactHits.push(name)
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    for (const shape of SHAPES) {
      shape.pattern.lastIndex = 0
      let match
      while ((match = shape.pattern.exec(lines[index])) !== null) {
        const after = match[0].slice(match[0].indexOf('-') + 1)
        const realLooking = shape.realAfter === null ? true : shape.realAfter.test(after.replace(/^hyper-/, ''))
        shaped.push({ kind: shape.name, file: name, line: index + 1, sample: match[0].slice(0, 14), realLooking })
      }
    }
  }
}

console.log(`check-secrets: scanned ${files.length} files`)

if (key !== undefined) {
  console.log(exactHits.length === 0
    ? '  exact: the live key appears in 0 files'
    : `  exact: LEAK in ${exactHits.join(', ')}`)
}

const realLooking = shaped.filter(hit => hit.realLooking)
const placeholders = shaped.filter(hit => !hit.realLooking)
for (const hit of placeholders) {
  console.log(`  placeholder: ${hit.file}:${hit.line} ${hit.sample}…`)
}
for (const hit of realLooking) {
  console.log(`  REAL-LOOKING ${hit.kind}: ${hit.file}:${hit.line} ${hit.sample}…`)
}

const failures = exactHits.length + realLooking.length
if (failures === 0) {
  console.log('check-secrets: CLEAN')
} else {
  console.log(`check-secrets: ${failures} suspect(s) — remove the credential, and rotate it if it was ever pushed`)
}
process.exitCode = failures === 0 ? 0 : 1
