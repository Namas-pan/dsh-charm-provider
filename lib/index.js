/**
 * Hyper (hyper.charm.land) LLM provider plugin for DeepSeek Harness.
 *
 * Registers one provider route (`hyper`) speaking the OpenAI-compatible
 * chat-completions protocol Charm Hyper serves at `{baseURL}/chat/completions`,
 * with a live model catalog read from `{baseURL}/models` (that endpoint needs no
 * credential), image input for vision models, reasoning-effort dispatch, and the
 * mandatory app-attribution headers.
 *
 * @module dsh-charm-provider
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { LlmError, ReasoningEffortId, ToolCallId, assertUsableApiKey, attributionHeaders, } from '@deepseek-ai/dsh-llm';
/** Plugin label; matches the `llm-hyper` row id this package's bundle inserts. */
export const name = 'llm-hyper';
/** `llm` is the seam this plugin registers a route on; `settings` carries its config. */
export const inject = ['llm', 'settings'];
/** The single provider route this plugin owns. */
export const PROVIDER = 'hyper';
/** Display name shown by provider selectors. */
export const PROVIDER_DISPLAY_NAME = 'Hyper';
/** Settings namespace holding this route's connection facts. */
export const NS = 'llm-hyper';
const DEFAULT_API_KEY_ENV = 'HYPER_API_KEY';
const DEFAULT_BASE_URL = 'https://hyper.charm.land/v1';
const DEFAULT_CACHE_FILE = join(homedir(), '.hyper', 'models-cache.json');
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/* -------------------------------------------------------------------------- */
/* Credits Remote                                                              */
/* -------------------------------------------------------------------------- */
/**
 * Hyper bills in Hypercredits. Two independent sources agree on the number and
 * disagree on precision: `GET /v1/credits` answers the account balance rounded
 * to whole credits, while every chat response carries the exact post-request
 * value as `usage.remaining.hypercredits` (plus `usage.cost.usd` and
 * `usage.cost.hypercredits` for that request). The card therefore prefers the
 * response value and falls back to the endpoint.
 */
const REMOTE_PACKAGE = 'dsh-charm-provider';
const REMOTE_SERVICE = 'hyperCredits';
const REMOTE_NAMESPACE = 'hyper';
const CREDITS_TYPE = `${REMOTE_PACKAGE}#HyperCredits`;
/** Endpoint balance is an account-wide fact; re-asking inside this window is waste. */
const BALANCE_MIN_INTERVAL_MS = 10_000;
/** Strict boundary validator for the credits Remote result. */
export function parseCreditsView(value) {
    if (!isRecord(value))
        throw new Error('credits: expected an object');
    const number = (key, nullable) => {
        const raw = value[key];
        if (raw === null && nullable)
            return null;
        if (typeof raw !== 'number' || !Number.isFinite(raw))
            throw new Error(`credits.${String(key)}: expected a finite number`);
        return raw;
    };
    const source = value.source;
    if (source !== 'endpoint' && source !== 'response' && source !== 'none')
        throw new Error('credits.source: unexpected value');
    if (typeof value.estimated !== 'boolean')
        throw new Error('credits.estimated: expected a boolean');
    const lastModel = value.lastModel;
    if (lastModel !== null && typeof lastModel !== 'string')
        throw new Error('credits.lastModel: expected a string or null');
    const error = value.error;
    if (error !== null && typeof error !== 'string')
        throw new Error('credits.error: expected a string or null');
    return {
        balance: number('balance', true),
        source,
        estimated: value.estimated,
        updatedAt: number('updatedAt', true),
        requests: number('requests', false) ?? 0,
        spentUsd: number('spentUsd', false) ?? 0,
        spentCredits: number('spentCredits', false) ?? 0,
        lastCostUsd: number('lastCostUsd', true),
        lastModel,
        error,
    };
}
/**
 * The invocation both halves declare. The Host registers it through
 * `ctx.typert.register`; the browser half mounts the same descriptor through
 * `ctx.remote.$mount`, which is what makes `remote.hyper.credits()` callable.
 */
const CREDITS_DESCRIPTOR = {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/credits`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method: 'credits',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: CREDITS_TYPE, schema: { parse: parseCreditsView } },
};
/** The Host service the credits Remote invokes. */
class HyperCreditsService extends TypertRemoteService {
    constructor(ctx, read) {
        super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE });
        this.credits = () => read();
    }
}
export const Config = z.object({
    apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
    baseURL: z.string().default(DEFAULT_BASE_URL),
    modelsCachePath: z.string().default(''),
    catalogTtlMs: z.number().default(DEFAULT_CATALOG_TTL_MS),
    visibleModels: z.array(z.string()).default([]),
    requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
    streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    /** 0 leaves the cap unset: the model's own capacity governs, not this plugin. */
    defaultMaxTokens: z.number().default(0),
});
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** Parse one `/models` entry; `undefined` when it names no usable model id. */
function parseModel(raw) {
    if (!isRecord(raw))
        return undefined;
    const id = str(raw.id);
    if (id === undefined)
        return undefined;
    const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
    const reasoning = isRecord(raw.reasoning) ? raw.reasoning : {};
    const levels = Array.isArray(reasoning.effort_levels) ? reasoning.effort_levels : [];
    const efforts = [];
    for (const level of levels) {
        const value = isRecord(level) ? str(level.value) : str(level);
        if (value === undefined)
            continue;
        const display = (isRecord(level) ? str(level.display) : undefined) ?? value;
        if (!efforts.some(e => e.value === value))
            efforts.push({ value, display });
    }
    const pricingRaw = isRecord(raw.pricing) ? raw.pricing : {};
    const pricing = {
        input: num(pricingRaw.input),
        output: num(pricingRaw.output),
        cacheHit: num(pricingRaw.cache_hit),
        cacheCreate: num(pricingRaw.cache_create),
    };
    const hasPricing = Object.values(pricing).some(v => v !== undefined);
    const contextWindow = num(raw.context_window) ?? 0;
    const maxTokens = num(raw.max_output_tokens) ?? 0;
    return {
        id,
        name: str(raw.display_name) ?? id,
        contextWindow: contextWindow > 0 ? contextWindow : 262_144,
        maxTokens: maxTokens > 0 ? maxTokens : 32_768,
        vision: capabilities.vision === true,
        efforts,
        ...(str(reasoning.default_effort_level) !== undefined ? { defaultEffort: str(reasoning.default_effort_level) } : {}),
        ...(hasPricing ? { pricing } : {}),
    };
}
/** Parse a `/models` response body into catalog models. */
export function parseCatalog(payload) {
    const list = isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload) ? payload : [];
    const models = [];
    for (const entry of list) {
        const model = parseModel(entry);
        if (model !== undefined && !models.some(m => m.id === model.id))
            models.push(model);
    }
    return models;
}
/**
 * Fetch and normalize the live catalog. The endpoint publishes it without
 * authentication, so a profile with no key yet still gets a model picker; a key
 * is attached when one resolves, because a private deployment may require it.
 */
async function fetchCatalog(baseURL, apiKey, timeoutMs) {
    const response = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers: {
            accept: 'application/json',
            ...attributionHeaders(),
            ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new LlmError(`Hyper model catalog failed: HTTP ${response.status}`, 'PROVIDER_HTTP_ERROR', { status: response.status });
    }
    return parseCatalog(await response.json());
}
async function readCacheFile(path) {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf-8'));
        if (!isRecord(parsed) || !Array.isArray(parsed.models))
            return undefined;
        const models = [];
        for (const entry of parsed.models) {
            const model = parseModel(entry);
            if (model !== undefined)
                models.push(model);
        }
        if (models.length === 0)
            return undefined;
        return {
            fetchedAt: num(parsed.fetchedAt) ?? 0,
            baseURL: str(parsed.baseURL) ?? '',
            models,
        };
    }
    catch {
        return undefined;
    }
}
async function writeCacheFile(path, snapshot) {
    try {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf-8');
        await rename(temporary, path);
    }
    catch {
        // A read-only or missing home directory must not break requests; the
        // in-memory snapshot already serves this process.
    }
}
function blocksOf(message) {
    const content = message.content;
    return Array.isArray(content) ? content : [];
}
function blockText(block) {
    const record = block;
    return (record.type === 'text' || record.type === 'reasoning') && typeof record.text === 'string' ? record.text : '';
}
function joinBlocks(blocks, type) {
    return blocks.filter(b => b.type === type).map(blockText).join('');
}
/** Build one user message's content, embedding images as data URLs when accepted. */
async function userContent(blocks, readImage, allowImages) {
    const text = joinBlocks(blocks, 'text');
    const images = blocks.filter(b => b.type === 'image');
    if (images.length === 0)
        return text.length > 0 ? text : undefined;
    if (!allowImages || readImage === undefined) {
        const note = text.length > 0 ? text : '(image omitted: this model accepts text only)';
        return note;
    }
    const parts = [];
    if (text.length > 0)
        parts.push({ type: 'text', text });
    for (const image of images) {
        const ref = image.attachment;
        const stored = await readImage(ref);
        parts.push({
            type: 'image_url',
            image_url: { url: `data:${stored.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` },
        });
    }
    return parts;
}
/**
 * Serialize harness messages into OpenAI chat-completions wire messages.
 * `tool-result` blocks become standalone `{ role: 'tool' }` messages; system
 * messages are collected by the caller into the leading system message.
 */
async function messagesToCompletions(messages, readImage, allowImages) {
    const out = [];
    for (const message of messages) {
        const role = message.role;
        const source = message.source;
        const blocks = blocksOf(message);
        if (role === 'system')
            continue;
        if (role === 'user' && source?.kind !== 'tool') {
            const content = await userContent(blocks, readImage, allowImages);
            if (content !== undefined)
                out.push({ role: 'user', content });
            continue;
        }
        if (role === 'assistant') {
            const text = joinBlocks(blocks, 'text');
            const reasoning = joinBlocks(blocks, 'reasoning');
            const toolCalls = blocks
                .filter(b => b.type === 'tool-call')
                .map((b) => {
                const call = b;
                return {
                    id: String(call.id ?? ''),
                    type: 'function',
                    function: { name: String(call.name ?? ''), arguments: typeof call.arguments === 'string' ? call.arguments : '{}' },
                };
            });
            // Only tool calls with a paired result may be replayed; the provider
            // rejects an assistant turn naming a call the conversation never answered.
            const answered = new Set();
            for (const other of messages) {
                const otherRole = other.role;
                if (otherRole !== 'user' || other.source?.kind !== 'tool')
                    continue;
                for (const block of blocksOf(other)) {
                    const record = block;
                    if (record.type === 'tool-result' && record.toolCallId !== undefined)
                        answered.add(String(record.toolCallId));
                }
            }
            const replayed = toolCalls.filter(call => answered.has(call.id));
            out.push({
                role: 'assistant',
                content: text,
                ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
                ...(replayed.length > 0 ? { tool_calls: replayed } : {}),
            });
            continue;
        }
        if (role === 'user' && source?.kind === 'tool') {
            const block = blocks.find(b => b.type === 'tool-result');
            if (block === undefined)
                continue;
            const inner = Array.isArray(block.content) ? block.content : [];
            const text = inner.map(blockText).filter(Boolean).join('\n');
            out.push({ role: 'tool', tool_call_id: String(block.toolCallId ?? ''), content: text.length > 0 ? text : '(no output)' });
        }
    }
    return out;
}
/** Map one HTTP failure onto the harness's provider-neutral failure codes. */
function httpFailure(status, body, retryAfterMs) {
    const detail = body.slice(0, 300);
    const code = status === 401 ? 'INVALID_CREDENTIAL'
        : status === 402 ? 'QUOTA'
            : status === 403 ? 'AUTH'
                : status === 404 ? 'UNKNOWN_MODEL'
                    : status === 429 ? 'RATE_LIMIT'
                        : 'PROVIDER_HTTP_ERROR';
    return new LlmError(`Hyper API HTTP ${status}: ${detail}`, code, {
        status,
        ...(retryAfterMs !== undefined ? { providerRetryAfterMs: retryAfterMs } : {}),
    });
}
function retryAfterMs(response) {
    const raw = response.headers.get('retry-after');
    if (raw === null)
        return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
export function apply(ctx, config) {
    const scope = ctx.settings.register(NS, Config, { base: config, applies: 'live' });
    const current = () => scope.get();
    const cachePath = () => {
        const configured = current().modelsCachePath;
        return configured.length > 0 ? configured : DEFAULT_CACHE_FILE;
    };
    let snapshot;
    let refresh;
    let lastStats;
    let credits = { source: 'none', spentSinceReading: 0, requests: 0, spentUsd: 0, spentCredits: 0 };
    let balanceAskedAt = 0;
    let balanceAsk;
    const models = () => snapshot?.models ?? [];
    const visible = () => {
        const allow = current().visibleModels;
        if (allow.length === 0)
            return models();
        return models().filter(model => allow.includes(model.id));
    };
    /**
     * Refresh the catalog at most once per TTL. The endpoint is unauthenticated,
     * so this also warms a keyless profile's picker; a failure keeps the previous
     * snapshot (or the disk cache) serving rather than breaking the route.
     */
    const ensureCatalog = async (signal) => {
        const cfg = current();
        const age = snapshot === undefined ? Number.POSITIVE_INFINITY : Date.now() - snapshot.fetchedAt;
        if (refresh === undefined && snapshot !== undefined && age < cfg.catalogTtlMs)
            return;
        if (refresh !== undefined)
            return refresh;
        refresh = (async () => {
            let apiKey;
            try {
                apiKey = await resolveApiKey();
            }
            catch {
                apiKey = undefined;
            }
            try {
                const fetched = await fetchCatalog(cfg.baseURL, apiKey, cfg.requestTimeoutMs);
                if (fetched.length > 0) {
                    snapshot = { fetchedAt: Date.now(), baseURL: cfg.baseURL, models: fetched };
                    await writeCacheFile(cachePath(), snapshot);
                    return;
                }
            }
            catch {
                // Fall through to the cached snapshot.
            }
            const cached = await readCacheFile(cachePath());
            if (cached !== undefined)
                snapshot = cached;
        })().finally(() => { refresh = undefined; });
        return refresh;
    };
    const resolveApiKey = async () => {
        const ref = current().apiKeyEnv.length > 0 ? current().apiKeyEnv : DEFAULT_API_KEY_ENV;
        const credentials = ctx.get('credentials');
        if (credentials === undefined) {
            throw new LlmError(`no credential service is mounted to resolve ${ref}`, 'NO_CREDENTIAL_STORE');
        }
        const hit = await credentials.resolve(credentialRef(ref));
        if (hit === undefined || hit.value.length === 0) {
            throw new LlmError(`no Hyper API key: store ${ref} (Settings → Models → Hyper, or the CHARM_API_KEY/HYPER_API_KEY environment)`, 'MISSING_CREDENTIAL');
        }
        return assertUsableApiKey(hit.value, 'hyper', ref);
    };
    /**
     * Ask the endpoint for the account balance, at most once per interval and
     * never twice concurrently. A failure is recorded on the state (so the card
     * can show it) instead of thrown — the last known balance stays useful.
     */
    const askBalance = async () => {
        if (balanceAsk !== undefined)
            return balanceAsk;
        if (Date.now() - balanceAskedAt < BALANCE_MIN_INTERVAL_MS)
            return;
        balanceAsk = (async () => {
            try {
                const apiKey = await resolveApiKey();
                const response = await fetch(`${current().baseURL}/credits`, {
                    method: 'GET',
                    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, ...attributionHeaders() },
                    signal: AbortSignal.timeout(current().requestTimeoutMs),
                });
                if (!response.ok)
                    throw httpFailure(response.status, await response.text().catch(() => ''), retryAfterMs(response));
                const payload = await response.json();
                const balance = isRecord(payload) ? num(payload.balance) : undefined;
                if (balance === undefined)
                    throw new LlmError('Hyper /credits answered without a balance', 'PROVIDER_PROTOCOL_ERROR');
                credits = { ...credits, balance, source: 'endpoint', updatedAt: Date.now(), spentSinceReading: 0, error: undefined };
            }
            catch (error) {
                credits = { ...credits, error: error instanceof Error ? error.message : String(error) };
            }
            finally {
                balanceAskedAt = Date.now();
                balanceAsk = undefined;
            }
        })();
        return balanceAsk;
    };
    /** The Remote's read: current state, with a stale endpoint balance refreshed. */
    const readCredits = async () => {
        await askBalance();
        const reading = credits.balance;
        const spentSince = credits.spentSinceReading;
        const estimated = reading !== undefined && spentSince > 0;
        return {
            balance: reading === undefined ? null : Math.max(0, Math.round((reading - spentSince) * 1e4) / 1e4),
            source: credits.source,
            estimated,
            updatedAt: credits.updatedAt ?? null,
            requests: credits.requests,
            spentUsd: credits.spentUsd,
            spentCredits: credits.spentCredits,
            lastCostUsd: credits.lastCostUsd ?? null,
            lastModel: credits.lastModel ?? null,
            error: credits.error ?? null,
        };
    };
    const resolveModel = async (provider, model) => {
        await ensureCatalog();
        const entry = visible().find(candidate => candidate.id === model) ?? models().find(candidate => candidate.id === model);
        const allowImages = entry?.vision === true;
        return {
            provider,
            id: model,
            name: entry?.name ?? model,
            inputModalities: allowImages ? ['text', 'image'] : ['text'],
            ...(entry !== undefined ? { context: { contextWindow: entry.contextWindow } } : {}),
            ...(current().defaultMaxTokens > 0 ? { defaultMaxTokens: current().defaultMaxTokens } : {}),
            ...(entry !== undefined && entry.efforts.length > 0
                ? {
                    reasoning: {
                        efforts: entry.efforts.map(effort => ({ id: ReasoningEffortId(effort.value), name: effort.display })),
                    },
                }
                : {}),
        };
    };
    /**
     * Stream one chat-completions call, translating SSE deltas into harness
     * chunks. Reasoning arrives as `reasoning_content`, tools as indexed
     * `tool_calls` fragments, and usage as an aggregate chunk before `finish`.
     */
    async function* stream(options) {
        const cfg = current();
        const apiKey = await resolveApiKey();
        await ensureCatalog();
        const entry = models().find(candidate => candidate.id === options.model);
        const allowImages = entry?.vision === true;
        const attachments = ctx.get('attachments');
        const readImage = attachments === undefined
            ? undefined
            : async (ref) => {
                const stored = await attachments.readImage(ref, options.signal);
                return { data: stored.data, mediaType: stored.mediaType };
            };
        if (allowImages && readImage === undefined && options.messages.some(m => blocksOf(m).some(b => b.type === 'image'))) {
            throw new LlmError('Hyper image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
        }
        const systemParts = [
            options.system ?? '',
            ...options.messages
                .filter(message => message.role === 'system')
                .map(message => blocksOf(message).map(blockText).filter(Boolean).join('\n')),
        ].filter(part => part.length > 0);
        const messages = await messagesToCompletions(options.messages, readImage, allowImages);
        const tools = (options.tools ?? []).map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        const body = {
            model: options.model,
            messages: systemParts.length > 0 ? [{ role: 'system', content: systemParts.join('\n\n') }, ...messages] : messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(tools.length > 0 ? { tools } : {}),
            ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
            ...(options.reasoningEffort !== undefined ? { reasoning_effort: String(options.reasoningEffort) } : {}),
        };
        const response = await fetch(`${cfg.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'text/event-stream',
                authorization: `Bearer ${apiKey}`,
                ...attributionHeaders(),
            },
            body: JSON.stringify(body),
            signal: options.signal === undefined
                ? AbortSignal.timeout(cfg.requestTimeoutMs)
                : AbortSignal.any([options.signal, AbortSignal.timeout(cfg.requestTimeoutMs)]),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw httpFailure(response.status, text, retryAfterMs(response));
        }
        if (response.body === null)
            throw new LlmError('Hyper API returned no response body', 'PROVIDER_PROTOCOL_ERROR');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let nextIndex = 0;
        let textIndex;
        let textContent = '';
        let reasoningIndex;
        let reasoningContent = '';
        const toolBlocks = new Map();
        let emittedBlocks = 0;
        let pendingFinish;
        let pendingUsage;
        let finished = false;
        const drain = (payload) => {
            const chunks = [];
            if (payload === '[DONE]') {
                if (textIndex !== undefined) {
                    chunks.push({ type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } });
                    textIndex = undefined;
                }
                if (reasoningIndex !== undefined) {
                    chunks.push({ type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningContent } });
                    reasoningIndex = undefined;
                }
                for (const block of toolBlocks.values()) {
                    chunks.push({
                        type: 'block-end',
                        index: block.index,
                        block: { type: 'tool-call', id: ToolCallId(block.id), name: block.name ?? '', arguments: block.arguments },
                    });
                }
                toolBlocks.clear();
                if (pendingUsage !== undefined)
                    chunks.push(pendingUsage);
                chunks.push(pendingFinish ?? { type: 'finish', reason: emittedBlocks === 0
                        ? { kind: 'error', failure: { message: 'Hyper returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
                        : { kind: 'stop' } });
                finished = true;
                return chunks;
            }
            let parsed;
            try {
                parsed = JSON.parse(payload);
            }
            catch {
                throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'PROVIDER_PROTOCOL_ERROR');
            }
            if (!isRecord(parsed))
                return chunks;
            const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
            for (const choice of choices) {
                if (!isRecord(choice))
                    continue;
                const delta = isRecord(choice.delta) ? choice.delta : {};
                const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
                if (reasoning !== undefined) {
                    if (reasoningIndex === undefined) {
                        reasoningIndex = nextIndex++;
                        emittedBlocks += 1;
                        chunks.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' });
                    }
                    reasoningContent += reasoning;
                    chunks.push({ type: 'reasoning-delta', index: reasoningIndex, text: reasoning });
                }
                const content = str(delta.content);
                if (content !== undefined) {
                    if (textIndex === undefined) {
                        textIndex = nextIndex++;
                        emittedBlocks += 1;
                        chunks.push({ type: 'block-start', index: textIndex, blockType: 'text' });
                    }
                    textContent += content;
                    chunks.push({ type: 'text-delta', index: textIndex, text: content });
                }
                const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
                for (const call of calls) {
                    if (!isRecord(call))
                        continue;
                    const callIndex = num(call.index) ?? 0;
                    let block = toolBlocks.get(callIndex);
                    if (block === undefined) {
                        block = { index: nextIndex++, id: '', arguments: '' };
                        toolBlocks.set(callIndex, block);
                        emittedBlocks += 1;
                        chunks.push({ type: 'block-start', index: block.index, blockType: 'tool-call' });
                    }
                    if (str(call.id) !== undefined)
                        block.id = String(call.id);
                    const fn = isRecord(call.function) ? call.function : {};
                    if (str(fn.name) !== undefined)
                        block.name = String(fn.name);
                    const fragment = str(fn.arguments) ?? '';
                    block.arguments += fragment;
                    chunks.push({
                        type: 'tool-call-delta',
                        index: block.index,
                        id: ToolCallId(block.id),
                        ...(block.name !== undefined ? { name: block.name } : {}),
                        argumentsDelta: fragment,
                    });
                }
                const finishReason = str(choice.finish_reason);
                if (finishReason !== undefined) {
                    pendingFinish = {
                        type: 'finish',
                        reason: finishReason === 'stop' ? { kind: 'stop' }
                            : finishReason === 'tool_calls' ? { kind: 'tool-calls' }
                                : finishReason === 'length' ? { kind: 'max-tokens' }
                                    : { kind: 'error', failure: { message: `Hyper stopped: ${finishReason}`, code: finishReason.toUpperCase() } },
                    };
                }
            }
            if (isRecord(parsed.usage)) {
                const usage = parsed.usage;
                const cacheRead = num(isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : undefined)
                    ?? num(usage.prompt_cache_hit_tokens);
                const reasoningTokens = num(isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details.reasoning_tokens : undefined);
                const promptTokens = num(usage.prompt_tokens) ?? 0;
                const completionTokens = num(usage.completion_tokens) ?? 0;
                pendingUsage = {
                    type: 'usage',
                    usage: {
                        inputTokens: promptTokens - (cacheRead ?? 0),
                        outputTokens: completionTokens,
                        totalTokens: num(usage.total_tokens) ?? promptTokens + completionTokens,
                        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
                        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
                    },
                };
                const cost = isRecord(usage.cost) ? num(usage.cost.usd) : undefined;
                const costCredits = isRecord(usage.cost) ? num(usage.cost.hypercredits) : undefined;
                const remaining = isRecord(usage.remaining) ? num(usage.remaining.hypercredits) : undefined;
                lastStats = {
                    inputTokens: promptTokens,
                    outputTokens: completionTokens,
                    ...(cost !== undefined ? { costUsd: cost } : {}),
                    ...(remaining !== undefined ? { remainingCredits: remaining } : {}),
                };
                // The response's post-request balance is exact when present (non-streamed
                // responses carry it; streamed ones carry only `cost`), so it wins outright and
                // resets the derived-spend counter. Otherwise the spend accumulates against the
                // last endpoint reading.
                credits = {
                    ...credits,
                    requests: credits.requests + 1,
                    spentUsd: credits.spentUsd + (cost ?? 0),
                    spentCredits: credits.spentCredits + (costCredits ?? 0),
                    ...(cost !== undefined ? { lastCostUsd: cost } : {}),
                    lastModel: options.model,
                    ...(remaining !== undefined
                        ? { balance: remaining, source: 'response', updatedAt: Date.now(), spentSinceReading: 0, error: undefined }
                        : { spentSinceReading: credits.spentSinceReading + (costCredits ?? 0) }),
                };
            }
            return chunks;
        };
        const readChunk = async () => {
            let timer;
            const stall = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new LlmError(`Hyper stream stalled for ${cfg.streamIdleTimeoutMs}ms`, 'PROVIDER_TIMEOUT')), cfg.streamIdleTimeoutMs);
            });
            try {
                return await Promise.race([reader.read(), stall]);
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
            }
        };
        try {
            while (!finished) {
                const { done, value } = await readChunk();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() ?? '';
                for (const event of events) {
                    const dataLine = event.split('\n').find(line => line.startsWith('data:'));
                    if (dataLine === undefined)
                        continue;
                    const data = dataLine.slice(5).trim();
                    if (data.length === 0)
                        continue;
                    for (const chunk of drain(data)) {
                        yield chunk;
                        if (chunk.type === 'finish')
                            finished = true;
                    }
                }
            }
            if (!finished) {
                // A connection that ended without `[DONE]` still settles the stream.
                for (const chunk of drain('[DONE]'))
                    yield chunk;
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    const adapter = {
        providerInfo(provider) { return { id: provider, name: PROVIDER_DISPLAY_NAME }; },
        providerRetryPolicy() { return undefined; },
        imageRequestPricing() { return undefined; },
        async listModels(provider) {
            await ensureCatalog();
            return visible().map(model => ({
                provider,
                id: model.id,
                name: model.name,
                description: describe(model),
                inputModalities: model.vision ? ['text', 'image'] : ['text'],
            }));
        },
        async resolveModel(provider, model) {
            return resolveModel(provider, model);
        },
        async prepareCall(provider, model) {
            const resolved = await resolveModel(provider, model);
            return { model: resolved, stream: (options) => stream({ ...options, provider, model }) };
        },
        stream,
    };
    /** One-line picker annotation: context, image support, efforts, price. */
    function describe(model) {
        const parts = [`${Math.round(model.contextWindow / 1000)}K ctx`];
        if (model.vision)
            parts.push('image');
        if (model.efforts.length > 0)
            parts.push(`effort: ${model.efforts.map(e => e.value).join('/')}`);
        const price = model.pricing;
        if (price?.input !== undefined && price.output !== undefined) {
            parts.push(`$${price.input}/$${price.output} per Mtok`);
        }
        return parts.join(' · ');
    }
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: PROVIDER_DISPLAY_NAME, settingsNs: NS, settingsPath: [], declared: true },
    ]);
    ctx.llm.registerAdapter([PROVIDER], adapter);
    // The browser card reads the balance through this Remote: the Host registers
    // the invocation and the service that answers it, and the client half mounts
    // the same descriptor to make `remote.hyper.credits()` callable.
    const typert = ctx;
    if (typeof typert.inject === 'function') {
        typert.inject(['typert'], (remoteCtx) => {
            const registry = remoteCtx.typert;
            if (registry === undefined)
                return;
            new HyperCreditsService(remoteCtx, readCredits);
            const release = registry.register({
                package: REMOTE_PACKAGE,
                face: 'host',
                schemas: [],
                model: { services: [], events: [], objects: [] },
                invocations: [CREDITS_DESCRIPTOR],
            });
            remoteCtx.effect(() => () => release(), 'dsh-charm-provider: credits remote');
        });
    }
    // Warm the catalog once at mount so the first picker render is populated.
    void ensureCatalog().catch(() => undefined);
    scope.watch(() => { void ensureCatalog().catch(() => undefined); });
    const commands = ctx.get('commands');
    if (commands !== undefined) {
        commands.register({
            name: 'hyper',
            description: 'Hyper provider status and model catalog',
            input: { hint: '[models]' },
            handler: async (invocation) => {
                await ensureCatalog().catch(() => undefined);
                const view = await readCredits();
                const cfg = current();
                const header = [
                    `provider: ${PROVIDER} (${PROVIDER_DISPLAY_NAME})`,
                    `baseURL: ${cfg.baseURL}`,
                    `key ref: ${cfg.apiKeyEnv}`,
                    `models: ${models().length}${cfg.visibleModels.length > 0 ? ` (${visible().length} visible)` : ''}`,
                    `hypercredits: ${view.balance === null ? 'unknown' : view.balance}${view.estimated ? ' (est.)' : ''} (${view.source}${view.updatedAt === null ? '' : `, ${new Date(view.updatedAt).toLocaleTimeString()}`})`,
                    `this session: ${view.requests} requests · $${view.spentUsd.toFixed(6)} · ${view.spentCredits.toFixed(4)} credits`,
                    ...(lastStats !== undefined
                        ? [`last request: in ${lastStats.inputTokens} / out ${lastStats.outputTokens}${lastStats.costUsd !== undefined ? ` · $${lastStats.costUsd.toFixed(6)}` : ''}`]
                        : []),
                    ...(view.error !== null ? [`last balance refresh failed: ${view.error}`] : []),
                ].join('\n');
                if ((invocation?.rawInput ?? '').trim() !== 'models')
                    return { kind: 'success', text: header };
                const lines = visible().map(model => `• ${model.id} — ${model.name} — ${describe(model)}`);
                return { kind: 'success', text: `${header}\n\n${lines.join('\n')}` };
            },
        });
    }
}
//# sourceMappingURL=index.js.map