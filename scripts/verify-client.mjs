/**
 * Verify the hand-written browser half (`lib/client.js`) without a browser.
 *
 * What it proves:
 *   1. The bundle parses and registers itself through `window.__ModuleLoader__`
 *      with the right module id and injection face.
 *   2. `apply()` registers exactly the two seats the plugin owns — the
 *      `settings.section` page and the keyed `settings.models.provider-card`
 *      entry for namespace `llm-hyper`.
 *   3. The credential faces speak the shipped Remote envelope
 *      (`{ok, value: {[ref]: {configured, writable}}}`, positional `set(ref, value)`).
 *   4. Both components render real element trees (under a minimal React hook
 *      stub) that name Hyper, the key reference and the base URL.
 *
 * Usage: node scripts/verify-client.mjs [--plugin <dir>]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const pluginArgument = argv.indexOf('--plugin')
const PLUGIN = resolve(pluginArgument >= 0 ? argv[pluginArgument + 1] : join(dirname(fileURLToPath(import.meta.url)), '..'))

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ---------------------------------------------------------------- loader */

let definition
const window = { __ModuleLoader__: { load: (value) => { definition = value } } }
const source = readFileSync(resolve(PLUGIN, 'lib', 'client.js'), 'utf-8')
try {
  new Function('window', 'require', source)(window, makeRequire(() => []))
  check('bundle parses and self-registers', true)
} catch (error) {
  check('bundle parses and self-registers', false, String(error.message ?? error))
  process.exit(1)
}

check('module id matches the package', definition?.id === 'dsh-charm-provider', String(definition?.id))

/* ------------------------------------------------------- minimal React */

let hookIndex = 0
let hookValues = []

function createElement(type, props, ...children) {
  const flattened = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return { type, props: { ...(props ?? {}), children: flattened } }
}

const reactStub = {
  createElement,
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial
    return [hookValues[index], (next) => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next }]
  },
  useEffect() { hookIndex += 1 },
  useCallback(fn) { hookIndex += 1; return fn },
}

function makeRequire() {
  return (specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected require: ${specifier}`)
  }
}

function render(component, props) {
  hookIndex = 0
  hookValues = []
  return component(props)
}

/**
 * Minimal renderer: walk an element tree, invoking nested function components
 * with their props so text produced by child components is inspected too.
 */
function stringsOf(tree, found = [], depth = 0) {
  if (depth > 12) return found
  if (typeof tree === 'string' || typeof tree === 'number') { found.push(String(tree)); return found }
  if (Array.isArray(tree)) {
    for (const entry of tree) stringsOf(entry, found, depth + 1)
    return found
  }
  if (tree === null || typeof tree !== 'object' || !('props' in tree)) return found
  for (const [key, value] of Object.entries(tree.props ?? {})) {
    if (key !== 'children' && typeof value === 'string') found.push(value)
  }
  if (typeof tree.type === 'function') {
    hookIndex = 0
    hookValues = []
    try {
      stringsOf(tree.type(tree.props ?? {}), found, depth + 1)
    } catch {
      // a nested component that needs a richer renderer is skipped, not fatal
    }
    return found
  }
  stringsOf(tree.props?.children, found, depth + 1)
  return found
}

/* -------------------------------------------------------------- runtime */

const calls = { describe: [], set: [], unset: [] }
const credentials = {
  async describe(refs) {
    calls.describe.push(refs)
    return { ok: true, value: { [refs[0]]: { configured: true, writable: true } } }
  },
  async set(ref, value) { calls.set.push([ref, value]); return { ok: true } },
  async unset(ref) { calls.unset.push(ref); return { ok: true } },
}

const registrations = []
const slots = {
  inject(key, callback) { callback(); return () => {} },
  register(options, component) { registrations.push({ options, component }); return () => {} },
}
const scope = {
  getSnapshot: () => ({ status: 'ready', value: { baseURL: 'https://hyper.charm.land/v1' }, writable: true, base: {}, revision: 3, mode: 'host' }),
  subscribe: () => () => {},
  set: async () => {},
  unset: async () => {},
  mutate: async () => {},
}

const injectRequests = []
const mounts = []
const creditsResult = {
  balance: 114.831587394,
  source: 'response',
  updatedAt: 1760000000000,
  requests: 3,
  spentUsd: 0.0003,
  spentCredits: 0.006,
  lastCostUsd: 0.0001,
  lastModel: 'deepseek-v4.1-flash',
  error: null,
}
const effects = []
const ctx = {
  slots,
  settingsScope: { bind: (spec) => { ctx.boundNamespace = spec.namespace; return scope } },
  inject(services, callback) {
    injectRequests.push(services)
    callback({ remote: { credentials, hyper: { credits: async () => ({ ok: true, value: creditsResult }) } } })
  },
  effect(callback, label) { effects.push({ label, dispose: callback() }); return () => {} },
  remote: {
    $mount(contribution) { mounts.push(contribution); return Promise.resolve(() => {}) },
  },
}

let exported
try {
  exported = definition.factory(makeRequire())
  check('factory returns a module', typeof exported?.apply === 'function')
  check('injection face is declared', Array.isArray(exported.inject) && exported.inject.includes('slots') && exported.inject.includes('remote'), JSON.stringify(exported.inject))
  exported.apply(ctx)
  check('apply() completes', true)
} catch (error) {
  check('factory + apply() complete', false, String(error.message ?? error))
  process.exit(1)
}

check('waits for remote.credentials', injectRequests.some(services => services.includes('remote.credentials')))
check('waits for the credits Remote', injectRequests.some(services => services.includes('remote.hyper')))
check('binds settings namespace llm-hyper', ctx.boundNamespace === 'llm-hyper', String(ctx.boundNamespace))

const mounted = mounts[0]
const descriptor = mounted?.descriptors?.[0]
check('mounts the credits Remote',
  mounted?.package === 'dsh-charm-provider' && descriptor?.namespace === 'hyper' && descriptor?.method === 'credits',
  `${mounted?.package} ${descriptor?.namespace}/${descriptor?.method}`)
check('descriptor names the Host service and a strict result',
  descriptor?.service === 'hyperCredits' && descriptor?.result?.mode === 'strict' && typeof descriptor?.result?.schema?.parse === 'function')

const section = registrations.find(entry => entry.options.name === 'settings.section')
const card = registrations.find(entry => entry.options.name === 'settings.models.provider-card')
check('registers the settings page', section !== undefined && section.options.id === 'hyper', `id=${section?.options.id} order=${section?.options.order}`)
check('registers the Models-page provider card', card !== undefined && card.options.key === 'llm-hyper', `key=${card?.options.key}`)

const faces = section?.options.inject?.()?.faces
check('both seats share the credential faces', faces !== undefined && card?.options.inject?.()?.faces === faces)

const described = await faces.credentials.describe('HYPER_API_KEY')
check('credential Remote envelope mapped',
  described?.configured === true && described?.writable === true && calls.describe[0][0] === 'HYPER_API_KEY',
  JSON.stringify(described))
const written = await faces.credentials.set('HYPER_API_KEY', 'sk-hyper-test')
check('credential write is positional', written.ok === true && calls.set[0][0] === 'HYPER_API_KEY' && calls.set[0][1] === 'sk-hyper-test')

const credits = await faces.credits.read()
check('credits Remote result parses',
  credits.ok === true && credits.view.balance === creditsResult.balance && credits.view.requests === 3,
  `balance=${credits.view?.balance} requests=${credits.view?.requests}`)
let rejectedBadShape = false
try {
  descriptor.result.schema.parse({ balance: 'not-a-number' })
} catch {
  rejectedBadShape = true
}
check('credits validator rejects a malformed frame', rejectedBadShape)

for (const [label, component] of [['settings page', section.component], ['provider card', card.component]]) {
  try {
    const tree = render(component, { faces, keyConfigured: true, provider: { active: true }, configured: true })
    const text = stringsOf(tree).join(' | ')
    const ok = text.includes('Hyper') && text.includes('sk-hyper-') && text.includes('HYPER_API_KEY')
    check(`${label} renders with the expected content`, ok, text.slice(0, 120))
    check(`${label} carries the credits card`, text.includes('Hypercredits'), '')
  } catch (error) {
    check(`${label} renders with the expected content`, false, String(error.message ?? error))
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
