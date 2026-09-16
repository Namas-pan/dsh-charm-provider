import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Plugin label; matches the `llm-hyper` row id this package's bundle inserts. */
export declare const name = "llm-hyper";
/** `llm` is the seam this plugin registers a route on; `settings` carries its config. */
export declare const inject: string[];
/** The single provider route this plugin owns. */
export declare const PROVIDER = "hyper";
/** Display name shown by provider selectors. */
export declare const PROVIDER_DISPLAY_NAME = "Hyper";
/** Settings namespace holding this route's connection facts. */
export declare const NS = "llm-hyper";
export interface Config {
    /** Credential reference (environment-variable name) resolved per request. */
    apiKeyEnv: string;
    /** API root; every request path is appended to it. */
    baseURL: string;
    /** Model-catalog cache path; empty uses `~/.hyper/models-cache.json`. */
    modelsCachePath: string;
    /** How long a cached catalog serves before a refresh is attempted. */
    catalogTtlMs: number;
    /** When non-empty, only these catalog model ids are offered in pickers. */
    visibleModels: string[];
    /** Milliseconds to wait for a response's first byte. */
    requestTimeoutMs: number;
    /** Milliseconds a stream may stall before it is treated as dead. */
    streamIdleTimeoutMs: number;
    /** Optional per-request output cap materialized when a caller omits one. */
    defaultMaxTokens: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    apiKeyEnv: z<string, string>;
    baseURL: z<string, string>;
    modelsCachePath: z<string, string>;
    catalogTtlMs: z<number, number>;
    visibleModels: z<string[], string[]>;
    requestTimeoutMs: z<number, number>;
    streamIdleTimeoutMs: z<number, number>;
    /** 0 leaves the cap unset: the model's own capacity governs, not this plugin. */
    defaultMaxTokens: z<number, number>;
}>, Schemastery.ObjectT<{
    apiKeyEnv: z<string, string>;
    baseURL: z<string, string>;
    modelsCachePath: z<string, string>;
    catalogTtlMs: z<number, number>;
    visibleModels: z<string[], string[]>;
    requestTimeoutMs: z<number, number>;
    streamIdleTimeoutMs: z<number, number>;
    /** 0 leaves the cap unset: the model's own capacity governs, not this plugin. */
    defaultMaxTokens: z<number, number>;
}>>;
/** One selectable reasoning level, exactly as the endpoint spells it on the wire. */
export interface EffortLevel {
    /** Value sent as `reasoning_effort`. */
    value: string;
    /** Human-readable label. */
    display: string;
}
/** One model as the endpoint describes it, normalized. */
export interface CatalogModel {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    vision: boolean;
    efforts: EffortLevel[];
    defaultEffort?: string;
    pricing?: {
        input?: number;
        output?: number;
        cacheHit?: number;
        cacheCreate?: number;
    };
}
/** Parse a `/models` response body into catalog models. */
export declare function parseCatalog(payload: unknown): CatalogModel[];
export declare function apply(ctx: Context, config: Config): void;
