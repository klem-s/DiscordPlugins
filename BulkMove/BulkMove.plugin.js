/**
 * @name BulkMove
 * @author klem___s
 * @authorId 321332083731726338
 * @description Ctrl/Cmd+Click (like selecting files in a file explorer) on any user who is
 *   currently in a voice channel to select them — click more users to add them to the
 *   selection. Then either right-click a selected user → "🔀 Déplacer vers…", or just
 *   drag any of them onto another voice channel — the whole selection moves together.
 * @version 1.0.1
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s
 */

module.exports = class BulkMove {

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    constructor() {
        this.selected     = new Map();   // userId -> displayName
        this._unpatches   = [];
        this._badgeEl     = null;
        this._dragPayload = null;        // Map(userId -> name) currently being dragged
        this._dragGhost   = null;

        this._onClick     = this._onClick.bind(this);
        this._onMouseOver = this._onMouseOver.bind(this);
        this._onDragStart = this._onDragStart.bind(this);
        this._onDragOver  = this._onDragOver.bind(this);
        this._onDragEnter = this._onDragEnter.bind(this);
        this._onDragLeave = this._onDragLeave.bind(this);
        this._onDrop      = this._onDrop.bind(this);
        this._onDragEnd   = this._onDragEnd.bind(this);
    }

    start() {
        this.VoiceStateStore    = this._getStore("VoiceStateStore",    "getVoiceStateForUser");
        this.SelectedGuildStore = this._getStore("SelectedGuildStore", "getGuildId");
        this.ChannelStore       = this._getStore("ChannelStore",       "getChannel");

        this._injectCSS();
        this._createBadge();

        // Capture phase so we can stop Discord opening a profile popout on our Ctrl+Click.
        document.addEventListener("click",     this._onClick,     true);
        document.addEventListener("mouseover", this._onMouseOver, true);
        document.addEventListener("dragstart", this._onDragStart, true);
        document.addEventListener("dragover",  this._onDragOver,  true);
        document.addEventListener("dragenter", this._onDragEnter, true);
        document.addEventListener("dragleave", this._onDragLeave, true);
        document.addEventListener("drop",      this._onDrop,      true);
        document.addEventListener("dragend",   this._onDragEnd,   true);

        this._unpatches.push(
            BdApi.ContextMenu.patch("user-context", this._patchUserMenu.bind(this))
        );

        BdApi.UI.showToast("BulkMove activé 🔀", { type: "success", timeout: 2000 });
    }

    stop() {
        document.removeEventListener("click",     this._onClick,     true);
        document.removeEventListener("mouseover", this._onMouseOver, true);
        document.removeEventListener("dragstart", this._onDragStart, true);
        document.removeEventListener("dragover",  this._onDragOver,  true);
        document.removeEventListener("dragenter", this._onDragEnter, true);
        document.removeEventListener("dragleave", this._onDragLeave, true);
        document.removeEventListener("drop",      this._onDrop,      true);
        document.removeEventListener("dragend",   this._onDragEnd,   true);

        this._unpatches.forEach(u => u());
        this._unpatches = [];

        document.querySelectorAll(".bkm-selected-row").forEach(el => el.classList.remove("bkm-selected-row"));
        document.querySelectorAll(".bkm-drop-target").forEach(el => el.classList.remove("bkm-drop-target"));
        this.selected.clear();
        this._dragPayload = null;
        this._dragGhost?.remove();
        this._dragGhost = null;

        this._badgeEl?.remove();
        this._badgeEl = null;

        BdApi.DOM.removeStyle("BulkMove");
    }

    // ─────────────────────────────────────────────────────────────
    //  Store / token helpers
    // ─────────────────────────────────────────────────────────────

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

    // Several unrelated modules (Spotify, RPC, ...) also expose a `getToken` method, and
    // the real one can sit behind a `.default` export depending on how it was bundled —
    // so we try BdApi.Webpack first, then fall back to walking the raw webpack module
    // cache directly (a technique widely used by BD plugins for exactly this).
    _getToken() {
        return this._getTokenFromWebpackModules() || this._getTokenFromWebpackChunk() || "";
    }

    _looksLikeToken(t) {
        return typeof t === "string" && t.length > 20;
    }

    _getTokenFromWebpackModules() {
        const filter = m => typeof m?.getToken === "function" || typeof m?.default?.getToken === "function";
        const candidates = BdApi.Webpack.getModule(filter, { first: false }) ?? [];

        // Prefer the standard 3-part token shape; keep the first plausible string as
        // a fallback in case Discord's token format ever changes.
        let fallback = null;
        for (const mod of candidates) {
            const getter = typeof mod?.getToken === "function" ? mod : mod?.default;
            let token;
            try { token = getter?.getToken?.(); } catch { continue; }
            if (!this._looksLikeToken(token)) continue;
            if (token.split(".").length === 3) return token;
            fallback ??= token;
        }
        return fallback;
    }

    // Last-resort: push a dummy chunk into Discord's webpack loader to get a handle on
    // its internal module cache, then scan every already-loaded module for a getToken().
    _getTokenFromWebpackChunk() {
        try {
            const chunkKey = Object.keys(window).find(k => /^webpackChunk/.test(k));
            if (!chunkKey) return null;

            let found = null;
            window[chunkKey].push([[Symbol()], {}, (req) => {
                for (const id in req.c) {
                    const exp    = req.c[id]?.exports;
                    const getter = typeof exp?.getToken === "function" ? exp
                                 : typeof exp?.default?.getToken === "function" ? exp.default
                                 : null;
                    if (!getter) continue;
                    try {
                        const t = getter.getToken();
                        if (this._looksLikeToken(t)) { found = t; break; }
                    } catch { /* not the right module — keep looking */ }
                }
            }]);
            return found;
        } catch (e) {
            console.warn("[BulkMove] webpack chunk token fallback failed:", e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  React fiber walking — resolves the Discord `user` object for
    //  whatever element was clicked, with no dependency on Discord's
    //  obfuscated class names.
    // ─────────────────────────────────────────────────────────────

    _fiberKeyOf(el) {
        return Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
    }

    // Looks only at `el`'s own fiber + its component ancestry (fiber.return) — no DOM climbing.
    _userFromFiber(el) {
        const key = this._fiberKeyOf(el);
        if (!key) return null;
        let fiber = el[key];
        for (let d = 0; fiber && d < 40; d++) {
            const props = fiber.memoizedProps ?? fiber.pendingProps;
            if (props?.user?.id) return props.user;
            fiber = fiber.return;
        }
        return null;
    }

    // Climbs DOM ancestors (covers icons/text nodes React didn't attach a fiber to directly).
    _resolveUserFromClick(startEl) {
        let el = startEl;
        for (let i = 0; i < 20 && el; i++) {
            const u = this._userFromFiber(el);
            if (u) return u;
            el = el.parentElement;
        }
        return null;
    }

    // Finds the outermost DOM element still associated with `userId` — used as the
    // "row" to visually highlight, again without hardcoding any class name.
    _findRowElement(startEl, userId) {
        let el  = startEl;
        let row = startEl;
        for (let i = 0; i < 20 && el; i++) {
            const u = this._userFromFiber(el);
            if (u?.id === userId) row = el;
            el = el.parentElement;
        }
        return row;
    }

    // Same idea as _userFromFiber/_findRowElement, but resolves a voice `channel` object —
    // used to detect drop targets without hardcoding Discord's obfuscated class names.
    _channelFromFiber(el) {
        const key = this._fiberKeyOf(el);
        if (!key) return null;
        let fiber = el[key];
        for (let d = 0; fiber && d < 40; d++) {
            const props = fiber.memoizedProps ?? fiber.pendingProps;
            if (props?.channel?.id && (props.channel.type === 2 || props.channel.type === 13)) {
                return props.channel;
            }
            fiber = fiber.return;
        }
        return null;
    }

    _resolveChannelFromEvent(startEl) {
        let el = startEl;
        for (let i = 0; i < 20 && el; i++) {
            const c = this._channelFromFiber(el);
            if (c) return c;
            el = el.parentElement;
        }
        return null;
    }

    _findChannelRowElement(startEl, channelId) {
        let el  = startEl;
        let row = startEl;
        for (let i = 0; i < 20 && el; i++) {
            const c = this._channelFromFiber(el);
            if (c?.id === channelId) row = el;
            el = el.parentElement;
        }
        return row;
    }

    // ─────────────────────────────────────────────────────────────
    //  Ctrl/Cmd+Click → toggle selection
    // ─────────────────────────────────────────────────────────────

    _onClick(e) {
        if (e.ctrlKey || e.metaKey) {
            const user = this._resolveUserFromClick(e.target);
            if (!user?.id) return;

            // Only selectable while actually connected to a voice channel — this is what
            // scopes the feature to "the voice channel list" without guessing at class names.
            const vs = this.VoiceStateStore?.getVoiceStateForUser(user.id);
            if (!vs?.channelId) return;

            e.preventDefault();
            e.stopPropagation();
            this._toggleSelection(user, e.target);
            return;
        }

        // Plain left-click anywhere else clears the current selection — same as clicking
        // empty space in a file explorer deselects everything.
        if (e.button === 0 && this.selected.size > 0) {
            this._clearSelection();
        }
    }

    _toggleSelection(user, clickTarget) {
        const wasSelected = this.selected.has(user.id);

        if (wasSelected) this.selected.delete(user.id);
        else             this.selected.set(user.id, user.username ?? user.id);

        const row = this._findRowElement(clickTarget, user.id);
        row?.classList.toggle("bkm-selected-row", !wasSelected);

        this._updateBadge();
        BdApi.UI.showToast(
            wasSelected
                ? `➖ ${user.username} retiré — ${this.selected.size} sélectionné(s)`
                : `➕ ${user.username} ajouté — ${this.selected.size} sélectionné(s)`,
            { type: wasSelected ? "info" : "success", timeout: 1500 }
        );
    }

    _clearSelection() {
        this.selected.clear();
        document.querySelectorAll(".bkm-selected-row").forEach(el => el.classList.remove("bkm-selected-row"));
        this._updateBadge();
    }

    // ─────────────────────────────────────────────────────────────
    //  Hover → make voice-connected user rows draggable on the fly
    //  (Discord doesn't mark them draggable itself, so we do it lazily
    //  instead of depending on a MutationObserver over the whole DOM).
    // ─────────────────────────────────────────────────────────────

    _onMouseOver(e) {
        const user = this._resolveUserFromClick(e.target);
        if (!user?.id) return;

        const vs = this.VoiceStateStore?.getVoiceStateForUser(user.id);
        if (!vs?.channelId) return;

        const row = this._findRowElement(e.target, user.id);
        if (row && !row.draggable) row.draggable = true;
    }

    // ─────────────────────────────────────────────────────────────
    //  Drag & drop → drop a user (or the whole selection) onto a
    //  voice channel row to move them there.
    // ─────────────────────────────────────────────────────────────

    _onDragStart(e) {
        const user = this._resolveUserFromClick(e.target);
        if (!user?.id) return;

        const vs = this.VoiceStateStore?.getVoiceStateForUser(user.id);
        if (!vs?.channelId) return;

        // Dragging a selected user moves the whole selection; dragging anyone
        // else just moves that one person — same fallback as the context menu.
        const targets = (this.selected.size > 0 && this.selected.has(user.id))
            ? new Map(this.selected)
            : new Map([[user.id, user.username ?? user.id]]);

        this._dragPayload = targets;
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", `bulkmove:${targets.size}`); } catch { /* some contexts block setData */ }

        const label = targets.size > 1
            ? `🔀 Déplacer ${targets.size} membres`
            : `🔀 Déplacer ${[...targets.values()][0]}`;
        const ghost = document.createElement("div");
        ghost.className   = "bkm-drag-ghost";
        ghost.textContent = label;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 12, 12);
        this._dragGhost = ghost;
    }

    _onDragOver(e) {
        if (!this._dragPayload) return;
        const channel = this._resolveChannelFromEvent(e.target);
        if (!channel) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
    }

    _onDragEnter(e) {
        if (!this._dragPayload) return;
        const channel = this._resolveChannelFromEvent(e.target);
        if (!channel) return;
        this._findChannelRowElement(e.target, channel.id)?.classList.add("bkm-drop-target");
    }

    _onDragLeave(e) {
        if (!this._dragPayload) return;
        const channel = this._resolveChannelFromEvent(e.target);
        if (!channel) return;
        const row = this._findChannelRowElement(e.target, channel.id);
        if (row && !row.contains(e.relatedTarget)) row.classList.remove("bkm-drop-target");
    }

    _onDrop(e) {
        if (!this._dragPayload) return;
        const channel = this._resolveChannelFromEvent(e.target);
        if (!channel) return;

        e.preventDefault();
        const guildId = this.SelectedGuildStore?.getGuildId();
        const targets = this._dragPayload;
        this._dragPayload = null;
        document.querySelectorAll(".bkm-drop-target").forEach(el => el.classList.remove("bkm-drop-target"));

        if (!guildId) {
            BdApi.UI.showToast("Aucun serveur sélectionné.", { type: "error", timeout: 2000 });
            return;
        }
        this._moveUsers(targets, channel.id, guildId);
    }

    _onDragEnd() {
        this._dragPayload = null;
        this._dragGhost?.remove();
        this._dragGhost = null;
        document.querySelectorAll(".bkm-drop-target").forEach(el => el.classList.remove("bkm-drop-target"));
    }

    // ─────────────────────────────────────────────────────────────
    //  Context menu — "Move to…" opens a small channel-picker modal
    // ─────────────────────────────────────────────────────────────

    _patchUserMenu(retVal, props) {
        const { user } = props;
        if (!user) return;

        const guildId = this.SelectedGuildStore?.getGuildId();
        if (!guildId) return; // DMs — nothing to move

        const channels = this._getGuildVoiceChannels(guildId);
        if (!channels.length) return;

        // 2+ selected → right-clicking *anyone* (selected or not) moves the whole group.
        // Otherwise, just move whoever was right-clicked.
        const targets = this.selected.size > 1
            ? new Map(this.selected)
            : new Map([[user.id, user.username ?? user.id]]);

        const label = targets.size > 1
            ? `🔀 Déplacer ${targets.size} membres vers…`
            : `🔀 Déplacer vers…`;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label,
                action: () => this._showChannelPicker(targets, guildId),
            }),
        ]);
    }

    // A flat list of channel items got unwieldy to scroll with more than a handful of
    // voice channels — this modal gives a search box instead, and avoids the nested
    // "submenu" hover-closing issue entirely since it isn't a context menu at all.
    _showChannelPicker(targets, guildId) {
        const channels = this._getGuildVoiceChannels(guildId);
        if (!channels.length) {
            BdApi.UI.showToast("Aucun salon vocal dans ce serveur.", { type: "warning", timeout: 2000 });
            return;
        }

        let selectedId = null;

        const Picker = () => {
            const [filter, setFilter]     = BdApi.React.useState("");
            const [selected, setSelected] = BdApi.React.useState(null);

            const filtered = channels.filter(ch => ch.name.toLowerCase().includes(filter.toLowerCase()));

            const selectedChannel = channels.find(ch => ch.id === selected);

            return BdApi.React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                BdApi.React.createElement("input", {
                    type        : "text",
                    placeholder : "Rechercher un salon…",
                    autoFocus   : true,
                    value       : filter,
                    onChange    : e => setFilter(e.target.value),
                    style: {
                        padding: "8px 10px", borderRadius: 4, fontSize: 14,
                        background: "var(--input-background)", color: "var(--text-normal)",
                        border: "1px solid var(--background-modifier-accent)", outline: "none",
                    },
                }),
                BdApi.React.createElement("div", {
                    style: {
                        fontSize: 12, fontWeight: 600, color: selectedChannel ? "#5865f2" : "var(--text-muted)",
                        minHeight: 16,
                    },
                }, selectedChannel ? `Sélectionné : 🔊 ${selectedChannel.name}` : "Aucun salon sélectionné"),
                BdApi.React.createElement("div", {
                    style: { overflowY: "auto", maxHeight: 280, display: "flex", flexDirection: "column", gap: 4 }
                },
                    filtered.length
                        ? filtered.map(ch => BdApi.React.createElement("div", {
                            key     : ch.id,
                            onClick : () => { selectedId = ch.id; setSelected(ch.id); },
                            style   : selected === ch.id ? {
                                padding      : "8px 10px",
                                borderRadius : 4,
                                cursor       : "pointer",
                                fontSize     : 14,
                                fontWeight   : 700,
                                background   : "#5865f2",
                                color        : "#fff",
                                boxShadow    : "0 0 0 2px #fff inset, 0 0 8px rgba(88,101,242,.8)",
                            } : {
                                padding      : "8px 10px",
                                borderRadius : 4,
                                cursor       : "pointer",
                                fontSize     : 14,
                                background   : "var(--background-secondary)",
                                color        : "var(--text-normal)",
                            },
                        }, `🔊 ${ch.name}`))
                        : BdApi.React.createElement("div", {
                            style: { color: "var(--text-muted)", padding: 8, textAlign: "center" }
                        }, "Aucun résultat.")
                )
            );
        };

        BdApi.UI.showConfirmationModal(
            targets.size > 1 ? `Déplacer ${targets.size} membres vers…` : "Déplacer vers…",
            BdApi.React.createElement(Picker),
            {
                confirmText : "Déplacer",
                cancelText  : "Annuler",
                onConfirm   : () => {
                    if (!selectedId) {
                        BdApi.UI.showToast("Choisis un salon avant de confirmer.", { type: "error", timeout: 2000 });
                        return;
                    }
                    this._moveUsers(targets, selectedId, guildId);
                },
            }
        );
    }

    _getGuildVoiceChannels(guildId) {
        const channels = this.ChannelStore?.getMutableGuildChannelsForGuild?.(guildId) ?? {};
        return Object.values(channels)
            .filter(ch => ch.type === 2 /* GUILD_VOICE */ || ch.type === 13 /* STAGE */)
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }

    // Safely push items into a context-menu React element (handles frozen/nested children).
    _pushToMenu(retVal, items) {
        if (!retVal?.props) return;
        try {
            let target = retVal.props;
            let ch     = target.children;

            if (!Array.isArray(ch) && Array.isArray(ch?.props?.children)) {
                target = ch.props;
                ch     = target.children;
            }

            if (Array.isArray(ch)) {
                if (Object.isFrozen(ch)) target.children = [...ch, ...items];
                else                     ch.push(...items);
            } else {
                target.children = [...(ch != null ? [ch] : []), ...items];
            }
        } catch (e) {
            console.error("[BulkMove] _pushToMenu failed:", e);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Move execution — REST API (same pattern as VoiceOverlap's search calls)
    // ─────────────────────────────────────────────────────────────

    async _moveUsers(targets, channelId, guildId) {
        const entries = [...targets.entries()];
        if (!entries.length) return;

        const token = this._getToken();
        if (!token) {
            BdApi.UI.showToast("❌ Impossible de récupérer le token Discord — déplacement annulé.", { type: "error", timeout: 4000 });
            return;
        }

        BdApi.UI.showToast(`Déplacement de ${entries.length} membre(s)...`, { type: "info", timeout: 1000 });

        const failed = [];
        for (const [userId, name] of entries) {
            try {
                const resp = await BdApi.Net.fetch(
                    `https://discord.com/api/v9/guilds/${guildId}/members/${userId}`,
                    {
                        method  : "PATCH",
                        headers : { Authorization: token, "Content-Type": "application/json" },
                        body    : JSON.stringify({ channel_id: channelId }),
                    }
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                this.selected.delete(userId);
            } catch (err) {
                console.warn("[BulkMove] échec déplacement", userId, err);
                failed.push(name);
            }
            await new Promise(r => setTimeout(r, 100)); // éviter le rate-limit
        }

        const successCount = entries.length - failed.length;
        if (successCount > 0) {
            BdApi.UI.showToast(`✅ ${successCount} membre(s) déplacé(s).`, { type: "success", timeout: 2500 });
        }
        if (failed.length) {
            BdApi.UI.showToast(`❌ Échec pour : ${failed.join(", ")}`, { type: "error", timeout: 4000 });
        }

        this._updateBadge();
    }

    // ─────────────────────────────────────────────────────────────
    //  Floating badge — shows selection count, click to clear
    // ─────────────────────────────────────────────────────────────

    _createBadge() {
        const el = document.createElement("div");
        el.id      = "bkm-badge";
        el.title   = "BulkMove — clique pour vider la sélection";
        el.style.display = "none";
        el.onclick = () => this._clearSelection();
        document.body.appendChild(el);
        this._badgeEl = el;
    }

    _updateBadge() {
        if (!this._badgeEl) return;
        const n = this.selected.size;
        if (n === 0) {
            this._badgeEl.style.display = "none";
            return;
        }
        this._badgeEl.style.display   = "flex";
        this._badgeEl.textContent     = `🔀 ${n} sélectionné(s) — clic pour vider`;
    }

    // ─────────────────────────────────────────────────────────────
    //  CSS
    // ─────────────────────────────────────────────────────────────

    _injectCSS() {
        BdApi.DOM.addStyle("BulkMove", `
            .bkm-selected-row {
                background     : rgba(88, 101, 242, 0.35) !important;
                box-shadow      : inset 2px 0 0 #5865f2;
                border-radius  : 4px;
            }

            .bkm-drop-target {
                background     : rgba(59, 165, 92, 0.30) !important;
                box-shadow      : inset 0 0 0 2px #3ba55c;
                border-radius  : 4px;
            }

            .bkm-drag-ghost {
                position       : fixed;
                top            : -1000px;
                left           : -1000px;
                background     : #5865f2;
                color          : #fff;
                font-size      : 12px;
                font-weight    : 600;
                padding        : 6px 12px;
                border-radius  : 14px;
                white-space    : nowrap;
                box-shadow     : 0 4px 14px rgba(0,0,0,.45);
                pointer-events : none;
            }

            #bkm-badge {
                position       : fixed;
                bottom         : 24px;
                left           : 24px;
                z-index        : 9999;
                background     : #5865f2;
                color          : #fff;
                font-size      : 12px;
                font-weight    : 600;
                padding        : 8px 14px;
                border-radius  : 20px;
                cursor         : pointer;
                box-shadow     : 0 4px 14px rgba(0,0,0,.45);
                align-items    : center;
                user-select    : none;
                transition     : background .15s, transform .1s;
            }
            #bkm-badge:hover  { background: #4752c4; transform: scale(1.03); }
            #bkm-badge:active { transform: scale(.97); }
        `);
    }
};
