/**
 * Link this plugin's build-time dependencies to an installed DSH runtime.
 *
 * The plugin is a third-party package: Harness packages (`@deepseek-ai/*`) are
 * peer dependencies the deployment owns, so this script never installs them —
 * it points `node_modules` at the runtime that will actually load the plugin.
 *
 * Runtime discovery order:
 *   1. `--runtime <path>` or `DSH_RUNTIME` (a directory holding `@deepseek-ai/`)
 *   2. the newest `_npx/<hash>/node_modules` containing `@deepseek-ai/dsh-llm`
 *   3. `$DSH_HOME/node_modules`
 *
 * Usage: node scripts/link-deps.mjs [--runtime <path>]
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, symlinkSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Packages the plugin imports at runtime, linked as the specifiers name them. */
const LINKS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
]

function isRuntime(dir) {
  return dir !== undefined && existsSync(join(dir, '@deepseek-ai', 'dsh-llm', 'package.json'))
}

function newestNpxRuntime() {
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : undefined,
    join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
    'E:\\npm-cache\\_npx',
  ].filter(Boolean)
  let best
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, 'node_modules')
      if (!isRuntime(candidate)) continue
      const stamp = statSync(join(candidate, '@deepseek-ai', 'dsh-llm')).mtimeMs
      if (best === undefined || stamp > best.stamp) best = { dir: candidate, stamp }
    }
  }
  return best?.dir
}

function parseArgs() {
  const index = process.argv.indexOf('--runtime')
  if (index >= 0 && process.argv[index + 1] !== undefined) return resolve(process.argv[index + 1])
  if (process.env.DSH_RUNTIME !== undefined) return resolve(process.env.DSH_RUNTIME)
  if (process.env.DSH_HOME !== undefined) {
    const candidate = join(process.env.DSH_HOME, 'node_modules')
    if (isRuntime(candidate)) return candidate
  }
  return newestNpxRuntime()
}

const runtime = parseArgs()
if (!isRuntime(runtime)) {
  console.error('link-deps: no DSH runtime found.')
  console.error('Pass one explicitly:  node scripts/link-deps.mjs --runtime <dir containing @deepseek-ai/>')
  process.exit(1)
}
console.log(`runtime: ${runtime}`)

/**
 * Remove a previous link. A Windows junction is a directory reparse point, so
 * `rmSync(recursive)` does not reliably unlink one (and can walk into the
 * target); `rmdir` removes the link itself and leaves the target alone.
 */
function removeLink(path) {
  if (!existsSync(path) && !isLink(path)) return
  if (!isLink(path)) {
    rmSync(path, { recursive: true, force: true })
    return
  }
  for (const attempt of [() => rmdirSync(path), () => unlinkSync(path), () => rmSync(path, { force: true })]) {
    try {
      attempt()
      return
    } catch {
      // try the next strategy
    }
  }
  rmSync(path, { recursive: true, force: true })
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

for (const target of LINKS) {
  const source = join(runtime, target)
  if (!existsSync(source)) {
    console.error(`link-deps: ${target} is not installed in that runtime`)
    process.exit(1)
  }
  const destination = join(ROOT, 'node_modules', target)
  removeLink(destination)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked: node_modules/${target} -> ${source}`)
}

const tsc = join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js')
console.log(existsSync(tsc) ? 'typescript: present' : 'typescript: MISSING (npm i -D typescript)')
