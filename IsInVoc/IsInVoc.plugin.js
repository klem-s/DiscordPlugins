/**
 * @name IsInVoc
 * @author klem___s
 * @authorId 321332083731726338
 * @description Shows 🔊 after the username in the member list and chat
 *   when a user is in a voice channel on the current server.
 *   Hover the badge to see the channel name.
 * @version 1.0.2
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s
 */

module.exports = class IsInVoc {

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    constructor() {
        this._unpatches   = [];
        this._observer    = null;
        this._decorateAll = this._decorateAll.bind(this);
        this._rafId       = null;
    }

    /**
     * Loads a Flux store by name.
     * Tries BdApi.Webpack.getStore() (BD ≥ 1.9) then falls back to a manual filter.
     */
    _getStore(name, ...methods) {
        if (typeof BdApi.Webpack.getStore === "function") {
            const s = BdApi.Webpack.getStore(name);
            if (s) return s;
        }
        return BdApi.Webpack.getModule(m =>
            m?.constructor?.displayName === name ||
            m?.getName?.() === name ||
            (methods.length && methods.every(k => typeof m?.[k] === "function"))
        ) ?? null;
    }

    start() {
        this.VoiceStateStore    = this._getStore("VoiceStateStore",    "getVoiceStateForUser");
        this.SelectedGuildStore = this._getStore("SelectedGuildStore", "getGuildId");
        this.ChannelStore       = this._getStore("ChannelStore",       "getChannel");

        this._injectCSS();
        this._patchMemberList();
        this._startObserver();

        this._unpatches.push(
            BdApi.ContextMenu.patch("user-context", this._patchUserMenu.bind(this))
        );

        // Live-update when someone joins/leaves a voice channel
        this.VoiceStateStore?.addChangeListener(this._decorateAll);

        BdApi.UI.showToast("IsInVoc enabled 🔊", { type: "success", timeout: 2500 });
    }

    stop() {
        this._unpatches.forEach(u => u());
        this._unpatches = [];

        this._observer?.disconnect();
        this._observer = null;

        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }

        this.VoiceStateStore?.removeChangeListener(this._decorateAll);

        BdApi.DOM.removeStyle("IsInVoc");
        document.querySelectorAll(".iiv-badge").forEach(el => el.remove());
        // Reset markers in case of a clean restart
        document.querySelectorAll("[data-iiv]").forEach(el => delete el.dataset.iiv);
    }

    // ─────────────────────────────────────────────────────────────
    //  Voice check
    // ─────────────────────────────────────────────────────────────

    /**
     * Returns the voice channel (on the current server) where userId is located.
     * Checks via channel.guild_id (more reliable than vs.guildId across versions).
     */
    _getVoiceChannel(userId) {
        const guildId = this.SelectedGuildStore?.getGuildId();
        if (!guildId || !userId) return null;

        const vs = this.VoiceStateStore?.getVoiceStateForUser(userId);
        if (!vs?.channelId) return null;

        const ch = this.ChannelStore?.getChannel(vs.channelId);
        if (!ch) return null;

        // guild_id may be ch.guild_id or ch.guildId depending on the Discord version
        const chGuild = ch.guild_id ?? ch.guildId;
        if (chGuild !== guildId) return null;

        return ch;
    }

    // ─────────────────────────────────────────────────────────────
    //  CSS
    // ─────────────────────────────────────────────────────────────

    _injectCSS() {
        BdApi.DOM.addStyle("IsInVoc", `
            .iiv-badge {
                display: inline-flex;
                align-items: center;
                margin-left: 4px;
                font-size: 11px;
                cursor: default;
                vertical-align: middle;
                opacity: 0.80;
                user-select: none;
                line-height: 1;
            }
            .iiv-badge:hover { opacity: 1; }
        `);
    }

    // ─────────────────────────────────────────────────────────────
    //  Patch member list (React)
    // ─────────────────────────────────────────────────────────────

    _patchMemberList() {
        const filter = m =>
            m &&
            typeof m === "function" &&
            typeof m.prototype?.renderDecorators === "function" &&
            typeof m.prototype?.render === "function";

        const MemberListItem = BdApi.Webpack.getModule(filter);

        if (!MemberListItem) {
            console.warn("[IsInVoc] MemberListItem not found – member list patch skipped");
            return;
        }

        const self = this;
        this._unpatches.push(
            // IMPORTANT: BdApi.Patcher.after → callback(thisArg, args, returnValue)
            // "thisArg" is the React component instance, NOT the callback's "this".
            BdApi.Patcher.after("IsInVoc", MemberListItem.prototype, "renderDecorators",
                (thisArg, _args, ret) => {
                    const userId = thisArg.props?.user?.id;
                    const ch = self._getVoiceChannel(userId);
                    if (!ch) return ret;

                    const badge = BdApi.React.createElement("span", {
                        key: "iiv-member",
                        className: "iiv-badge",
                        title: `🔊 ${ch.name}`,
                    }, "🔊");

                    if (!ret) return badge;

                    const kids = [].concat(ret.props?.children ?? []);
                    return BdApi.React.cloneElement(ret, {}, ...kids, badge);
                }
            )
        );
    }

    // ─────────────────────────────────────────────────────────────
    //  Context-menu patch (right-click user → join their voice channel)
    // ─────────────────────────────────────────────────────────────

    _patchUserMenu(retVal, props) {
        const user = props?.user;
        if (!user) return;

        const ch = this._getVoiceChannel(user.id);
        if (!ch) return;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label  : `🔊 Join "${ch.name}"`,
                action : () => this._joinVoiceChannel(ch.id),
            }),
        ]);
    }

    // Looked up on demand (not at start) because this webpack module can be
    // loaded late (lazy chunk) depending on which screen Discord starts on.
    // searchExports also checks each named export of a module, which catches
    // the case where selectVoiceChannel is one level deeper (ESM interop).
    _getVoiceActions() {
        if (typeof this.VoiceActions?.selectVoiceChannel === "function") return this.VoiceActions;

        this.VoiceActions =
            BdApi.Webpack.getModule(
                m => typeof m?.selectVoiceChannel === "function" && typeof m?.selectChannel === "function",
                { searchExports: true }
            ) ??
            BdApi.Webpack.getModule(
                m => typeof m?.selectVoiceChannel === "function",
                { searchExports: true }
            );

        return this.VoiceActions;
    }

    _joinVoiceChannel(channelId) {
        const actions = this._getVoiceActions();
        if (typeof actions?.selectVoiceChannel !== "function") {
            console.warn("[IsInVoc] selectVoiceChannel module not found");
            // Diagnostic: list any module whose keys merely mention "selectvoicechannel"
            // (case-insensitive) so we can see the real shape of the export.
            const hits = BdApi.Webpack.getModule(
                m => m && typeof m === "object" && Object.keys(m).some(k => k.toLowerCase() === "selectvoicechannel"),
                { first: false }
            );
            console.warn("[IsInVoc] selectVoiceChannel candidates:", hits);
            BdApi.UI.showToast("❌ Unable to join the voice channel.", { type: "error", timeout: 2500 });
            return;
        }
        actions.selectVoiceChannel(channelId);
    }

    // Safely push items into a context-menu React element.
    // Handles: plain array, frozen array, single element, nested children.
    _pushToMenu(retVal, items) {
        if (!retVal?.props) return;
        try {
            let target = retVal.props;
            let ch     = target.children;

            // Some Discord versions nest children one level deeper
            if (!Array.isArray(ch) && Array.isArray(ch?.props?.children)) {
                target = ch.props;
                ch     = target.children;
            }

            if (Array.isArray(ch)) {
                if (Object.isFrozen(ch)) {
                    target.children = [...ch, ...items];
                } else {
                    ch.push(...items);
                }
            } else {
                target.children = [...(ch != null ? [ch] : []), ...items];
            }
        } catch (e) {
            console.error("[IsInVoc] _pushToMenu failed:", e);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Patch chat (DOM + MutationObserver)
    // ─────────────────────────────────────────────────────────────

    _startObserver() {
        this._decorateAll();

        this._observer = new MutationObserver(mutations => {
            let added = false;
            for (const m of mutations) {
                if (m.addedNodes.length) { added = true; break; }
            }
            if (!added) return;
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._decorateAll();
            });
        });

        this._observer.observe(document.body, { childList: true, subtree: true });
    }

    _decorateAll() {
        // New message containers
        for (const el of document.querySelectorAll("[data-author-id]:not([data-iiv])")) {
            el.dataset.iiv = "1";
            this._applyBadge(el, el.dataset.authorId);
        }
        // Already-processed containers: sync in case the voice state changed
        for (const el of document.querySelectorAll("[data-author-id][data-iiv]")) {
            this._applyBadge(el, el.dataset.authorId);
        }
    }

    _applyBadge(msgEl, userId) {
        const ch       = this._getVoiceChannel(userId);
        const existing = msgEl.querySelector(".iiv-badge");

        if (!ch) {
            existing?.remove();
            return;
        }

        // Already present → just update the tooltip
        if (existing) {
            existing.title = `🔊 ${ch.name}`;
            return;
        }

        const anchor = this._findUsernameEl(msgEl);
        if (!anchor) return;

        const badge = document.createElement("span");
        badge.className   = "iiv-badge";
        badge.textContent = "🔊";
        badge.title       = `🔊 ${ch.name}`;
        anchor.insertAdjacentElement("afterend", badge);
    }

    /**
     * Finds the username span inside a message container.
     * Discord's class names are obfuscated (e.g. username_e5d2b8)
     * but the "username_" prefix is stable across versions.
     */
    _findUsernameEl(msgEl) {
        return (
            msgEl.querySelector("[class*='username_']")   ??   // ex: username_abc123
            msgEl.querySelector("[class*='username']")    ??   // fallback large
            msgEl.querySelector("[class*='headerText_']") ??   // wrapper du header
            msgEl.querySelector("[class*='headerText']")  ??
            msgEl.querySelector("[class*='author_']")     ??
            msgEl.querySelector("[class*='author']")
        );
    }
};
