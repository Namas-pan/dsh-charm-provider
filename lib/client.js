window.__ModuleLoader__.load({
  id: "dsh-charm-provider",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    /** Credential reference the Host plugin resolves per request. */
    const CREDENTIAL_REF = "HYPER_API_KEY";
    /** Settings namespace the Host plugin registered. */
    const SETTINGS_NS = "llm-hyper";
    const DEFAULT_BASE_URL = "https://hyper.charm.land/v1";
    const STYLE_ID = "dsh-hyper-provider-styles";

    /* ------------------------------------------------------------------ */
    /* Faces                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * `remote.credentials` is the shipped credential Remote: reads answer
     * `{ok, value: {[ref]: {configured, writable}}}`, writes answer `{ok}`.
     * Every call is guarded because a rejected Remote must leave the page
     * usable rather than blank.
     */
    function credentialFaces(credentials) {
      return {
        async describe(ref) {
          try {
            const response = await credentials.describe([ref]);
            if (!response || response.ok !== true) return undefined;
            const view = response.value ? response.value[ref] : undefined;
            return { configured: view ? view.configured === true : false, writable: view ? view.writable !== false : true };
          } catch {
            return undefined;
          }
        },
        async set(ref, value) {
          try {
            const response = await credentials.set(ref, value);
            return response && response.ok === true
              ? { ok: true }
              : { ok: false, error: messageOf(response) };
          } catch (error) {
            return { ok: false, error: String((error && error.message) || error) };
          }
        },
        async unset(ref) {
          try {
            const response = await credentials.unset(ref);
            return response && response.ok === true
              ? { ok: true }
              : { ok: false, error: messageOf(response) };
          } catch (error) {
            return { ok: false, error: String((error && error.message) || error) };
          }
        },
      };
    }

    function messageOf(response) {
      const error = response && response.error;
      if (error && typeof error.message === "string") return error.message;
      return "操作被拒绝";
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                             */
    /* ------------------------------------------------------------------ */

    /** Theme-token CSS, injected once per page so light and dark both work. */
    const CSS = [
      ".hyper-page{display:flex;flex-direction:column;gap:16px;padding:20px 4px;max-width:660px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}",
      ".hyper-page h2{margin:0;font-size:16px;font-weight:600}",
      ".hyper-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".hyper-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}",
      ".hyper-card h3{margin:0;font-size:13px;font-weight:600}",
      ".hyper-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".hyper-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".hyper-input{flex:1;min-width:180px;box-sizing:border-box;padding:7px 10px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}",
      ".hyper-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".hyper-btn{padding:7px 13px;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".hyper-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}",
      ".hyper-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".hyper-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;margin:0}",
      ".hyper-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}",
      ".hyper-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}",
      ".hyper-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;margin:0;font-size:12px}",
      ".hyper-kv dt{color:var(--dsw-alias-label-secondary)}",
      ".hyper-kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
      ".hyper-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px}",
      ".hyper-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}",
      ".hyper-dot.on{background:var(--dsw-alias-state-success-primary)}",
      ".hyper-provider{display:flex;flex-direction:column;gap:8px;padding-top:6px}",
      ".hyper-provider .hyper-title{font-size:12px;font-weight:600}",
    ].join("\n");

    function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ */
    /* Shared pieces                                                      */
    /* ------------------------------------------------------------------ */

    /** Subscribe one component to a settings-namespace snapshot. */
    function useSettingsSnapshot(scope) {
      const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
      react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
      return snapshot;
    }

    /** Track the credential state of one reference, re-reading after writes. */
    function useCredentialState(faces, initialConfigured) {
      const [state, setState] = react.useState({
        configured: initialConfigured === true,
        writable: true,
        known: false,
      });
      const refresh = react.useCallback(() => {
        let live = true;
        faces.credentials.describe(faces.ref).then((next) => {
          if (live && next !== undefined) setState({ ...next, known: true });
        });
        return () => { live = false; };
      }, [faces]);
      react.useEffect(() => refresh(), [refresh]);
      return [state, refresh];
    }

    /** Password field + save/clear actions, used by both seats. */
    function KeyControls(props) {
      const { faces, compact } = props;
      const [draft, setDraft] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [feedback, setFeedback] = react.useState(null);
      const [state, refresh] = useCredentialState(faces, props.initialConfigured);

      const save = async () => {
        const value = draft.trim();
        if (value.length === 0) return;
        setBusy(true);
        setFeedback(null);
        const result = await faces.credentials.set(faces.ref, value);
        if (result.ok) {
          setDraft("");
          setFeedback({ kind: "ok", text: "已保存到凭据存储 " + faces.ref });
          refresh();
        } else {
          setFeedback({ kind: "err", text: "保存失败：" + result.error });
        }
        setBusy(false);
      };

      const clear = async () => {
        setBusy(true);
        setFeedback(null);
        const result = await faces.credentials.unset(faces.ref);
        if (result.ok) {
          setFeedback({ kind: "ok", text: "已清除 " + faces.ref });
          refresh();
        } else {
          setFeedback({ kind: "err", text: "清除失败：" + result.error });
        }
        setBusy(false);
      };

      return react.createElement("div", { className: "hyper-row" },
        react.createElement("input", {
          className: "hyper-input",
          type: "password",
          value: draft,
          placeholder: "sk-hyper-...",
          disabled: busy || !state.writable,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === "Enter") save(); },
        }),
        react.createElement("button", {
          className: "hyper-btn primary",
          disabled: busy || draft.trim().length === 0 || !state.writable,
          onClick: save,
        }, busy ? "处理中…" : "保存"),
        !compact && state.configured
          ? react.createElement("button", { className: "hyper-btn", disabled: busy || !state.writable, onClick: clear }, "清除")
          : null,
        feedback === null
          ? null
          : react.createElement("p", { className: feedback.kind === "ok" ? "hyper-ok" : "hyper-err" }, feedback.text),
      );
    }

    /** The Models-page provider card: key state and the fastest way to set it. */
    function HyperProviderCard(props) {
      const faces = props.faces;
      const [state] = useCredentialState(faces, props.keyConfigured);
      return react.createElement("div", { className: "hyper-provider" },
        react.createElement("div", { className: "hyper-row" },
          react.createElement("span", { className: "hyper-title" }, "Hyper"),
          react.createElement("span", { className: "hyper-chip" },
            react.createElement("span", { className: "hyper-dot" + (state.configured ? " on" : "") }),
            state.configured ? "密钥已配置" : "密钥未配置",
          ),
          react.createElement("span", { className: "hyper-note" }, faces.ref),
        ),
        react.createElement(KeyControls, { faces, compact: true, initialConfigured: props.keyConfigured }),
      );
    }

    /** The full settings page under Settings → Hyper. */
    function HyperSettingsPage(props) {
      const faces = props.faces;
      const [state] = useCredentialState(faces, props.keyConfigured);
      const snapshot = useSettingsSnapshot(faces.scope);
      const value = snapshot.value || {};
      const baseURL = typeof value.baseURL === "string" && value.baseURL.length > 0 ? value.baseURL : DEFAULT_BASE_URL;
      const apiKeyEnv = typeof value.apiKeyEnv === "string" && value.apiKeyEnv.length > 0 ? value.apiKeyEnv : CREDENTIAL_REF;
      const [baseDraft, setBaseDraft] = react.useState(null);
      const [baseFeedback, setBaseFeedback] = react.useState(null);

      const editable = snapshot.status === "ready" && snapshot.writable;
      const draftValue = baseDraft === null ? baseURL : baseDraft;

      const saveBase = async () => {
        const next = draftValue.trim();
        if (next.length === 0) return;
        setBaseFeedback(null);
        try {
          await faces.scope.set("baseURL", next);
          setBaseDraft(null);
          setBaseFeedback({ kind: "ok", text: "已保存，下一次请求生效" });
        } catch (error) {
          setBaseFeedback({ kind: "err", text: "保存失败：" + String((error && error.message) || error) });
        }
      };

      const resetBase = async () => {
        setBaseFeedback(null);
        try {
          await faces.scope.unset("baseURL");
          setBaseDraft(null);
          setBaseFeedback({ kind: "ok", text: "已恢复组合层默认值" });
        } catch (error) {
          setBaseFeedback({ kind: "err", text: "重置失败：" + String((error && error.message) || error) });
        }
      };

      return react.createElement("section", { className: "hyper-page" },
        react.createElement("div", null,
          react.createElement("h2", null, "Hyper"),
          react.createElement("p", { className: "hyper-sub" }, "hyper.charm.land · openai-completions · 路由 hyper"),
        ),

        react.createElement("div", { className: "hyper-card" },
          react.createElement("h3", null, "API Key"),
          react.createElement("p", { className: "hyper-row" },
            react.createElement("span", { className: "hyper-chip" },
              react.createElement("span", { className: "hyper-dot" + (state.configured ? " on" : "") }),
              state.configured ? "已配置" : "未配置",
            ),
            react.createElement("span", { className: "hyper-note" }, "凭据引用 " + apiKeyEnv + "（只写不读回）"),
          ),
          react.createElement(KeyControls, { faces, compact: false, initialConfigured: props.keyConfigured }),
          react.createElement("p", { className: "hyper-note" }, "密钥存在本地凭据存储里，不会写进 settings.yaml，也不会回显。"),
        ),

        react.createElement("div", { className: "hyper-card" },
          react.createElement("h3", null, "连接"),
          react.createElement("label", { className: "hyper-label", htmlFor: "hyper-base-url" }, "API Base URL"),
          react.createElement("div", { className: "hyper-row" },
            react.createElement("input", {
              id: "hyper-base-url",
              className: "hyper-input",
              value: draftValue,
              disabled: !editable,
              onChange: (event) => setBaseDraft(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") saveBase(); },
            }),
            react.createElement("button", {
              className: "hyper-btn primary",
              disabled: !editable || draftValue.trim() === baseURL,
              onClick: saveBase,
            }, "保存"),
            react.createElement("button", {
              className: "hyper-btn",
              disabled: !editable,
              onClick: resetBase,
            }, "重置"),
          ),
          baseFeedback === null
            ? null
            : react.createElement("p", { className: baseFeedback.kind === "ok" ? "hyper-ok" : "hyper-err" }, baseFeedback.text),
          snapshot.status === "unavailable"
            ? react.createElement("p", { className: "hyper-note" }, "当前连接没有暴露 settings 命名空间，连接项不可编辑。")
            : null,
          react.createElement("dl", { className: "hyper-kv" },
            react.createElement("dt", null, "settings 命名空间"),
            react.createElement("dd", null, SETTINGS_NS),
            react.createElement("dt", null, "模型目录"),
            react.createElement("dd", null, "GET " + baseURL + "/models（免鉴权，插件内缓存 6 小时）"),
          ),
        ),

        react.createElement("div", { className: "hyper-card" },
          react.createElement("h3", null, "模型与用量"),
          react.createElement("p", { className: "hyper-note" },
            "模型选择器里的列表来自上面那个端点的实时目录，上下文窗口、图片支持、思考强度和价格都按端点自报显示。",
          ),
          react.createElement("p", { className: "hyper-note" },
            "切换模型：在输入框的模型菜单里选 Hyper 下的条目，或直接 /model hyper/<model-id>。",
          ),
          react.createElement("p", { className: "hyper-note" },
            "用量与花费：Hyper 在响应的 usage 里回传 cost.usd 与剩余 hypercredits，执行 /hyper 可查看最近一次请求与模型清单（/hyper models）。",
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Entry                                                              */
    /* ------------------------------------------------------------------ */

    exports.inject = ["slots", "connection", "remote", "settingsScope"];

    exports.apply = function (ctx) {
      injectStyles();

      // The credential Remote is what makes the key field usable; without it
      // the model picker still works and the page explains why the field is off.
      ctx.inject(["remote.credentials"], (remoteCtx) => {
        const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
        const faces = { credentials: credentialFaces(remoteCtx.remote.credentials), scope, ref: CREDENTIAL_REF, ns: SETTINGS_NS };

        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "hyper",
          order: 16,
          label: () => "Hyper",
          inject: () => ({ faces }),
        }, HyperSettingsPage));

        ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
          name: "settings.models.provider-card",
          key: SETTINGS_NS,
          inject: () => ({ faces }),
        }, HyperProviderCard));
      });
    };

    return module.exports;
  },
});
