/**
 * @name ForumUnfollower
 * @author klem___s
 * @authorId 321332083731726338
 * @description Right-click a forum (or media) channel → "🔕 Se désabonner de tous les posts"
 *   to leave every post/thread in it you're currently following in one go, instead of
 *   opening and unfollowing each one by hand.
 * @version 1.0.0
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s
 */

module.exports = class ForumUnfollower {

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    constructor() {
        this._unpatches = [];
    }

    start() {
        this.ActiveJoinedThreadsStore = BdApi.Webpack.getStore("ActiveJoinedThreadsStore");

        this._unpatches.push(
            BdApi.ContextMenu.patch("channel-context", this._patchChannelMenu.bind(this))
        );
        BdApi.UI.showToast("ForumUnfollower enabled 🔕", { type: "success", timeout: 2000 });
    }

    stop() {
        this._unpatches.forEach(u => u());
        this._unpatches = [];
    }

    // ─────────────────────────────────────────────────────────────
    //  Token helper (same technique as BulkMove/ReportCopier)
    // ─────────────────────────────────────────────────────────────

    _getToken() {
        return this._getTokenFromWebpackModules() || this._getTokenFromWebpackChunk() || "";
    }

    _looksLikeToken(t) {
        return typeof t === "string" && t.length > 20;
    }

    _getTokenFromWebpackModules() {
        const filter = m => typeof m?.getToken === "function" || typeof m?.default?.getToken === "function";
        const candidates = BdApi.Webpack.getModule(filter, { first: false }) ?? [];

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
            console.warn("[ForumUnfollower] webpack chunk token fallback failed:", e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  REST helpers
    // ─────────────────────────────────────────────────────────────

    async _api(path, token, opts = {}) {
        const resp = await BdApi.Net.fetch(`https://discord.com/api/v9${path}`, {
            ...opts,
            headers: { Authorization: token, ...(opts.headers ?? {}) },
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`HTTP ${resp.status} on ${path} — ${body.slice(0, 200)}`);
        }
        return resp.status === 204 ? null : resp.json();
    }

    // Threads (posts) the current user has joined are the ones they're "following" —
    // notifications only fire for threads you're a member of.
    //
    // GET /guilds/{id}/threads/active is bot-only for a user token ("Only bots can use
    // this endpoint", code 20002) — the real client never calls it either; it instead
    // gets active-thread state from the gateway (GUILD_CREATE/THREAD_LIST_SYNC) and keeps
    // it in ActiveJoinedThreadsStore, so we read that local store directly for the active
    // half instead. Archived threads have no such restriction and stay REST-based.
    async _findFollowedPosts(channel, token) {
        const followed = new Set();

        const activeJoined = this.ActiveJoinedThreadsStore
            ?.getActiveJoinedThreadsForParent?.(channel.guild_id, channel.id) ?? {};
        for (const threadId of Object.keys(activeJoined)) followed.add(threadId);

        let before = null;
        for (;;) {
            const qs = new URLSearchParams({ limit: "100" });
            if (before) qs.set("before", before);
            const page = await this._api(`/channels/${channel.id}/threads/archived/public?${qs}`, token);
            for (const m of page?.members ?? []) followed.add(m.id ?? m.thread_id);

            if (!page?.has_more || !page.threads?.length) break;
            const oldest = page.threads.reduce((a, b) =>
                a.thread_metadata.archive_timestamp < b.thread_metadata.archive_timestamp ? a : b
            );
            before = oldest.thread_metadata.archive_timestamp;
        }

        return [...followed];
    }

    async _unfollowPosts(threadIds, token) {
        const failed = [];
        for (const id of threadIds) {
            try {
                await this._api(`/channels/${id}/thread-members/@me`, token, { method: "DELETE" });
            } catch (err) {
                console.warn("[ForumUnfollower] échec désabonnement", id, err);
                failed.push(id);
            }
            await new Promise(r => setTimeout(r, 150)); // éviter le rate-limit
        }
        return failed;
    }

    async _runUnfollowAll(channel) {
        const token = this._getToken();
        if (!token) {
            BdApi.UI.showToast("❌ Impossible de récupérer le token Discord.", { type: "error", timeout: 4000 });
            return;
        }

        BdApi.UI.showToast("🔎 Recherche des posts suivis…", { type: "info", timeout: 1500 });

        let threadIds;
        try {
            threadIds = await this._findFollowedPosts(channel, token);
        } catch (err) {
            console.error("[ForumUnfollower] recherche échouée:", err);
            BdApi.UI.showToast(`❌ Échec de la recherche : ${err.message}`, { type: "error", timeout: 4500 });
            return;
        }

        if (!threadIds.length) {
            BdApi.UI.showToast(`Tu ne suis aucun post dans #${channel.name}.`, { type: "info", timeout: 2500 });
            return;
        }

        BdApi.UI.showConfirmationModal(
            "🔕 Se désabonner de tous les posts",
            `Se désabonner de ${threadIds.length} post${threadIds.length > 1 ? "s" : ""} dans #${channel.name} ?`,
            {
                confirmText: "Se désabonner",
                cancelText: "Annuler",
                onConfirm: async () => {
                    BdApi.UI.showToast(`🔕 Désabonnement de ${threadIds.length} post(s)…`, { type: "info", timeout: 1500 });
                    const failed = await this._unfollowPosts(threadIds, token);
                    const successCount = threadIds.length - failed.length;

                    if (successCount > 0) {
                        BdApi.UI.showToast(`✅ Désabonné de ${successCount} post(s).`, { type: "success", timeout: 3000 });
                    }
                    if (failed.length) {
                        BdApi.UI.showToast(`❌ Échec pour ${failed.length} post(s).`, { type: "error", timeout: 4000 });
                    }
                },
            }
        );
    }

    // ─────────────────────────────────────────────────────────────
    //  Context menu
    // ─────────────────────────────────────────────────────────────

    _patchChannelMenu(retVal, props) {
        const channel = props.channel;
        // GUILD_FORUM = 15, GUILD_MEDIA = 16
        if (!channel || (channel.type !== 15 && channel.type !== 16)) return;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label  : "🔕 Se désabonner de tous les posts",
                action : () => this._runUnfollowAll(channel),
            }),
        ]);
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
            console.error("[ForumUnfollower] _pushToMenu failed:", e);
        }
    }
};
