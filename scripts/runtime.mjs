/**
 * Locate the installed DSH runtime this plugin compiles and loads against.
 *
 * A third-party plugin never installs the Harness: `@deepseek-ai/*` are peer
 * dependencies owned by the deployment. Build and editor tooling therefore need
 * to point at that deployment's `node_modules` instead of duplicating it.
 *
 * Discovery order:
 *   1. `--runtime <dir>` (also persisted to `dsh.runtime.json` for next time)
 *   2. `DSH_RUNTIME`
 *   3. `$DSH_HOME/node_modules`
 *   4. `dsh.runtime.json` written by an earlier run
 *   5. every npm `_npx/<hash>/node_modules` under the configured/system caches,
 *      newest first
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = join(ROOT, 'dsh.runtime.json')

/** True when `dir` looks like a DSH runtime root. */
export function isRuntime(dir) {
  return dir !== undefined && existsSync(join(dir, '@deepseek-ai', 'dsh-llm', 'package.json'))
}

function readRecorded() {
  try {
    const parsed = JSON.parse(readFileSync(RECORD, 'utf-8'))
    return typeof parsed.runtime === 'string' ? parsed.runtime : undefined
  } catch {
    return undefined
  }
}

/** Record a runtime so later builds and editors need no flags. */
export function recordRuntime(dir) {
  writeFileSync(RECORD, `${JSON.stringify({ runtime: dir }, null, 2)}\n`, 'utf-8')
}

/** Every `_npx` directory npm may be using on this machine. */
function npxRoots() {
  const roots = new Set()
  for (const cache of [process.env.npm_config_cache, process.env.NPM_CONFIG_CACHE]) {
    if (cache !== undefined && cache.length > 0) roots.add(join(cache, '_npx'))
  }
  if (process.env.LOCALAPPDATA !== undefined) roots.add(join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  roots.add(join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'))
  roots.add(join(homedir(), '.npm', '_npx'))
  // Windows deployments frequently relocate the npm cache to a data drive.
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    if (existsSync(drive)) roots.add(join(drive, 'npm-cache', '_npx'))
  }
  return [...roots].filter(root => existsSync(root))
}

function newestNpxRuntime() {
  let best
  for (const root of npxRoots()) {
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, 'node_modules')
      if (!isRuntime(candidate)) continue
      const stamp = statSync(join(candidate, '@deepseek-ai', 'dsh-llm')).mtimeMs
      if (best === undefined || stamp > best.stamp) best = { dir: candidate, stamp }
    }
  }
  return best?.dir
}

/**
 * Resolve the runtime root.
 * @param explicit - a path from `--runtime`; persisted when it resolves.
 * @returns the runtime `node_modules` directory, or `undefined` when none is found.
 */
export function findRuntime(explicit) {
  if (explicit !== undefined && isRuntime(resolve(explicit))) {
    const dir = resolve(explicit)
    recordRuntime(dir)
    return dir
  }
  if (isRuntime(process.env.DSH_RUNTIME)) return resolve(process.env.DSH_RUNTIME)
  if (process.env.DSH_HOME !== undefined) {
    const candidate = join(process.env.DSH_HOME, 'node_modules')
    if (isRuntime(candidate)) return candidate
  }
  const recorded = readRecorded()
  if (isRuntime(recorded)) return recorded
  return newestNpxRuntime()
}

/** Read `--runtime <path>` from an argument list. */
export function runtimeArgument(argv) {
  const index = argv.indexOf('--runtime')
  return index >= 0 ? argv[index + 1] : undefined
}
