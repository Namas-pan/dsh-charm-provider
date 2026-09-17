/**
 * Verify the built Hyper provider plugin without loading a DSH profile.
 *
 * What it proves:
 *   1. `lib/index.js` imports cleanly against the installed DSH runtime — every
 *      Harness peer it names actually resolves there.
 *   2. The plugin exports the contract the loader expects (`name`, `inject`,
 *      `apply`) and builds its route metadata (`PROVIDER`).
 *   3. `Config` resolves its schema defaults.
 *   4. `parseCatalog` maps the LIVE `GET https://hyper.charm.land/v1/models`
 *      payload — ids, context windows, vision, reasoning levels — which is the
 *      one part of the adapter that can be checked without an API key.
 *
 * The plugin directory's own `node_modules` is unusable (stale junctions), so
 * the artifact is imported from a clean temp tree holding links to the runtime.
 *
 * Usage: node scripts/verify-plugin.mjs [--plugin <dir>] [--runtime <dir>]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findRuntime, runtimeArgument } from './runtime.mjs'

const argv = process.argv.slice(2)
const pluginArgument = argv.indexOf('--plugin')
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = resolve(pluginArgument >= 0 ? argv[pluginArgument + 1] : PACKAGE_ROOT)
const noRuntime = argv.includes('--no-runtime')
const RUNTIME = noRuntime ? undefined : findRuntime(runtimeArgument(argv))

const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-typert-protocol',
]

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// Peers come from the installed runtime when there is one, otherwise from this
// package's own node_modules (CI, or `--no-runtime`).
const PEER_ROOT = RUNTIME ?? join(PACKAGE_ROOT, 'node_modules')
for (const peer of PEERS) {
  if (!existsSync(join(PEER_ROOT, peer, 'package.json'))) {
    console.error(`no peer ${peer} under ${PEER_ROOT}`)
    console.error('Install the devDependencies (pnpm install), or pass --runtime <dir containing @deepseek-ai/>')
    process.exit(1)
  }
}
console.log(`plugin:  ${PLUGIN}`)
console.log(`peers:   ${PEER_ROOT}\n`)

const sandbox = mkdtempSync(join(tmpdir(), 'hyper-verify-'))
mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true })
writeFileSync(join(sandbox, 'package.json'), '{ "type": "module" }\n', 'utf-8')
for (const peer of PEERS) {
  symlinkSync(join(PEER_ROOT, peer), join(sandbox, 'node_modules', peer), 'junction')
}
const artifact = join(PLUGIN, 'lib', 'index.js')
const staged = join(sandbox, 'index.js')
cpSync(artifact, staged)

let mod
try {
  mod = await import(pathToFileURL(staged).href)
  check('lib/index.js imports against the runtime', true)
} catch (error) {
  check('lib/index.js imports against the runtime', false, String(error.message ?? error))
  process.exitCode = 1
  throw new Error('artifact did not import; fix the build before the remaining checks')
}

check('exports name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
check('exports apply()', typeof mod.apply === 'function')
check('injects llm + settings', Array.isArray(mod.inject) && mod.inject.includes('llm') && mod.inject.includes('settings'), JSON.stringify(mod.inject))
check('route id is hyper', mod.PROVIDER === 'hyper', String(mod.PROVIDER))
check('settings namespace is llm-hyper', mod.NS === 'llm-hyper', String(mod.NS))

const defaults = mod.Config({})
check('Config defaults resolve', defaults.apiKeyEnv === 'HYPER_API_KEY' && defaults.baseURL === 'https://hyper.charm.land/v1',
  `${defaults.apiKeyEnv} / ${defaults.baseURL}`)
check('visibleModels defaults to all', Array.isArray(defaults.visibleModels) && defaults.visibleModels.length === 0)

/* ------------------------------------------------- credits remote wiring */

// Mount the plugin with a stub context and exercise the credits service the way
// the Gateway does: through `ctx.get(serviceKey)`, a WRAPPED receiver. A method
// reading `this` (or a `#private` field) throws there — the failure the balance
// card hit as "Cannot read private member #read from an object whose class did
// not declare it". This runs without a credential, so CI covers it.
let creditsService
const stub = {
  settings: { register: () => ({ get: () => defaults, watch: () => () => {} }) },
  get: () => undefined,
  llm: { registerConfigurableProviders() {}, registerAdapter() {} },
  reflect: { provide(name, instance) { if (name === 'hyperCredits') creditsService = instance } },
  effect: (callback) => callback(),
  inject(services, callback) {
    if (!services.includes('typert')) return
    callback({ reflect: stub.reflect, effect: () => () => {}, typert: { register: () => () => {} } })
  },
}
mod.apply(stub, defaults)
check('mounts the credits service', typeof creditsService?.credits === 'function')

let throughWrapper
try {
  const wrapper = new Proxy(creditsService, {})
  throughWrapper = await Reflect.apply(Reflect.get(wrapper, 'credits'), wrapper, [])
} catch (error) {
  throughWrapper = { failure: String(error.message ?? error) }
}
check('the credits method survives a wrapped receiver',
  throughWrapper?.failure === undefined && typeof throughWrapper.requests === 'number',
  throughWrapper?.failure ?? `balance=${throughWrapper?.balance} error=${throughWrapper?.error}`)
check('a keyless mount reports the failure instead of throwing',
  throughWrapper?.failure === undefined && throughWrapper?.balance === null && typeof throughWrapper?.error === 'string',
  String(throughWrapper?.error).slice(0, 80))

const response = await fetch(`${defaults.baseURL}/models`)
const payload = await response.json()
const models = mod.parseCatalog(payload)
check('live catalog parses', models.length === payload.data.length && models.length > 0, `${models.length} models`)

const flash = models.find(model => model.id === 'deepseek-v4.1-flash')
check('deepseek-v4.1-flash: vision + efforts from the endpoint',
  flash !== undefined && flash.vision === true && flash.efforts.map(e => e.value).join(',') === 'low,high,max',
  flash === undefined ? 'missing' : `vision=${flash.vision} efforts=${flash.efforts.map(e => e.value).join(',')}`)
check('catalog carries context windows', models.every(model => model.contextWindow > 0 && model.maxTokens > 0))

const names = models.map(model => model.name)
check('display names preferred over ids', names.includes('DeepSeek V4.1 Flash'))
check('pricing captured when published', models.filter(model => model.pricing?.input !== undefined).length > 0,
  `${models.filter(model => model.pricing?.input !== undefined).length} priced`)

/**
 * Best-effort temp cleanup. Removing Windows junctions can abort the process
 * during teardown, so a failure here must never change the verdict.
 */
function cleanup() {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // the OS reclaims %TEMP% anyway
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
cleanup()
process.exitCode = failed.length === 0 ? 0 : 1
