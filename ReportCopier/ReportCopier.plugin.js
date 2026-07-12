/**
 * @name ReportCopier
 * @author klem___s
 * @authorId 321332083731726338
 * @description Fixes accidental duplicate forum reports. Paste the link of the duplicate
 *   (source) post and the link of the post to keep (destination) — the plugin re-sends the
 *   source's text, links and @mention into the destination, and re-uploads its images as real
 *   attachments (never a pasted CDN link). Optional checkbox deletes the duplicate afterward.
 * @version 1.0.0
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s
 */

module.exports = class ReportCopier {

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    constructor() {
        this._toggleBtn  = null;
        this._unpatches  = [];
        this._sourceLink = "";
        this._destLink   = "";
    }

    start() {
        this._injectCSS();
        this._createToggleButton();
        this._unpatches.push(
            BdApi.ContextMenu.patch("message", this._patchMessageMenu.bind(this))
        );
        // A pasted Discord channel/thread/message link gets rendered inline as a
        // "channel mention" chip (its own component, not a plain <a>), with its own
        // context menu — patch that one too so right-clicking a specific link inside
        // a message with several links scopes capture to just that link.
        this._unpatches.push(
            BdApi.ContextMenu.patch("channel-mention-context", this._patchChannelMentionMenu.bind(this))
        );
        BdApi.UI.showToast("ReportCopier enabled 📤", { type: "success", timeout: 2000 });
    }

    stop() {
        this._unpatches.forEach(u => u());
        this._unpatches = [];
        this._toggleBtn?.remove();
        this._toggleBtn = null;
        BdApi.DOM.removeStyle("ReportCopier");
    }

    // ─────────────────────────────────────────────────────────────
    //  Token helpers (same technique as BulkMove)
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
            console.warn("[ReportCopier] webpack chunk token fallback failed:", e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Link parsing — accepts a message jump link, a plain channel/thread
    //  link (forum-post starter messages share their thread's ID), or a
    //  .../{parentChannelId}/threads/{threadId}/{messageId} thread link.
    // ─────────────────────────────────────────────────────────────

    _parseLink(link) {
        const m = String(link ?? "").trim().match(
            /channels\/(@me|\d+)\/(?:\d+\/threads\/)?(\d+)(?:\/(\d+))?/
        );
        if (!m) return null;
        return { guildId: m[1], channelId: m[2], messageId: m[3] ?? null };
    }

    // ─────────────────────────────────────────────────────────────
    //  REST helpers
    // ─────────────────────────────────────────────────────────────

    async _api(path, token, opts = {}) {
        const url     = `https://discord.com/api/v9${path}`;
        const headers = { Authorization: token, ...(opts.headers ?? {}) };

        const resp = await BdApi.Net.fetch(url, { ...opts, headers });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`HTTP ${resp.status} on ${path} — ${body.slice(0, 200)}`);
        }
        return resp.status === 204 ? null : resp.json();
    }

    // Walks the whole source thread from `afterId` (exclusive) onward, oldest first —
    // a duplicate report is rarely a single message, it's the starter post plus whatever
    // follow-up text/images the reporter added afterward, and all of it needs migrating.
    async _fetchMessagesFrom(channelId, afterId, token) {
        const messages = [];
        let after = (BigInt(afterId) - 1n).toString();
        for (;;) {
            const batch = await this._api(`/channels/${channelId}/messages?after=${after}&limit=100`, token);
            if (!batch?.length) break;
            messages.push(...batch);
            after = batch[0].id;
            if (batch.length < 100) break;
        }
        if (!messages.length) throw new Error("Message(s) source introuvable(s) (supprimé ou inaccessible).");
        messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        return messages;
    }

    _collectImages(message) {
        const images = [];
        for (const a of message.attachments ?? []) {
            const isImage = (a.content_type ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? "");
            if (isImage) images.push({ url: a.url, filename: a.filename || "image.png" });
        }
        for (const e of message.embeds ?? []) {
            const src = e.image?.url || e.thumbnail?.url;
            if (src) images.push({ url: src, filename: (src.split("/").pop() || "image.png").split("?")[0] });
        }
        const seen = new Set();
        return images.filter(i => (seen.has(i.url) ? false : (seen.add(i.url), true)));
    }

    async _downloadImages(images) {
        const files = [];
        for (const img of images) {
            try {
                const resp = await BdApi.Net.fetch(img.url);
                if (!resp.ok) continue;
                files.push({ blob: await resp.blob(), filename: img.filename });
            } catch (e) {
                console.warn("[ReportCopier] failed to download image", img.url, e);
            }
        }
        return files;
    }

    // Builds the multipart body by hand with a boundary we choose ourselves. FormData
    // won't do here: BdApi.Net.fetch re-wraps the body into its own Request internally,
    // and Chromium mints a *new* random boundary each time a FormData body is extracted —
    // so a boundary read off one Request never matches the bytes serialized by another,
    // and Discord's parser silently fails to find the payload_json field.
    _buildMultipartBody(payload, files) {
        const boundary = `ReportCopier${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const CRLF = "\r\n";
        const parts = [
            `--${boundary}${CRLF}Content-Disposition: form-data; name="payload_json"${CRLF}Content-Type: application/json${CRLF}${CRLF}${JSON.stringify(payload)}${CRLF}`,
        ];
        files.forEach((f, i) => {
            parts.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="files[${i}]"; filename="${f.filename}"${CRLF}Content-Type: ${f.blob.type || "application/octet-stream"}${CRLF}${CRLF}`);
            parts.push(f.blob);
            parts.push(CRLF);
        });
        parts.push(`--${boundary}--${CRLF}`);

        return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` };
    }

    async _postMessage(channelId, content, files, token) {
        const payload = { content };
        if (files.length) payload.attachments = files.map((f, i) => ({ id: i, filename: f.filename }));

        const { body, contentType } = this._buildMultipartBody(payload, files);
        return this._api(`/channels/${channelId}/messages`, token, {
            method: "POST", body, headers: { "Content-Type": contentType },
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  Core copy operation
    // ─────────────────────────────────────────────────────────────

    async _runCopy(sourceLink, destLink, deleteSource) {
        const src = this._parseLink(sourceLink);
        const dst = this._parseLink(destLink);
        if (!src?.channelId) { BdApi.UI.showToast("❌ Lien source invalide.", { type: "error", timeout: 3000 }); return; }
        if (!dst?.channelId) { BdApi.UI.showToast("❌ Lien destination invalide.", { type: "error", timeout: 3000 }); return; }

        const token = this._getToken();
        if (!token) { BdApi.UI.showToast("❌ Impossible de récupérer le token Discord.", { type: "error", timeout: 4000 }); return; }

        BdApi.UI.showToast("📤 Copie en cours…", { type: "info", timeout: 1500 });

        try {
            // Forum-post starter messages share their thread's ID, so a plain thread
            // link (no message ID) still resolves to the report's original content.
            const srcMsgId = src.messageId ?? src.channelId;
            const messages = await this._fetchMessagesFrom(src.channelId, srcMsgId, token);

            let totalImages = 0;
            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                const images  = this._collectImages(message);
                const files   = await this._downloadImages(images);
                totalImages  += files.length;

                let content = (message.content || "").trim();
                if (content.length > 1990) content = content.slice(0, 1987) + "…";

                if (!content && !files.length) continue; // nothing to migrate from this message

                await this._postMessage(dst.channelId, content, files, token);
            }

            BdApi.UI.showToast(
                `✅ ${messages.length} message${messages.length > 1 ? "s" : ""} copié${messages.length > 1 ? "s" : ""}` +
                `${totalImages ? ` (${totalImages} image${totalImages > 1 ? "s" : ""})` : ""} vers la destination.`,
                { type: "success", timeout: 3000 }
            );

            if (deleteSource) {
                const isThreadRoot = srcMsgId === src.channelId;
                if (isThreadRoot) {
                    await this._api(`/channels/${src.channelId}`, token, { method: "DELETE" });
                    BdApi.UI.showToast("🗑️ Post source (doublon) supprimé.", { type: "info", timeout: 2000 });
                } else {
                    for (const m of messages) {
                        await this._api(`/channels/${src.channelId}/messages/${m.id}`, token, { method: "DELETE" });
                    }
                    BdApi.UI.showToast("🗑️ Message(s) source supprimé(s).", { type: "info", timeout: 2000 });
                }
            }
        } catch (err) {
            console.error("[ReportCopier] copy failed:", err);
            BdApi.UI.showToast(`❌ Échec de la copie : ${err.message}`, { type: "error", timeout: 4500 });
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Context menu — capture a message's link as source/destination
    //  without leaving the chat to paste it into the modal by hand.
    // ─────────────────────────────────────────────────────────────

    _patchMessageMenu(retVal, props) {
        const { message, channel } = props;
        if (!message) return;

        const guildId  = channel?.guild_id ?? "@me";
        const channelId = message.channel_id ?? channel?.id;
        const link = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label  : "📤 ReportCopier : définir comme Source",
                action : () => this._captureLink("source", link),
            }),
            BdApi.ContextMenu.buildItem({
                label  : "📥 ReportCopier : définir comme Destination",
                action : () => this._captureLink("dest", link),
            }),
        ]);
    }

    // A pasted Discord channel/thread/message link is rendered inline as a "channel
    // mention" chip (Discord's own component — not a plain <a>), so right-clicking it
    // opens the "channel-mention-context" menu instead of our "message" menu. Patching
    // it here scopes capture to that specific link when a message contains several.
    _patchChannelMentionMenu(retVal, props) {
        const channel   = props.channel;
        const channelId = channel?.id ?? props.channelId;
        const guildId   = channel?.guild_id ?? props.guildId ?? "@me";
        const messageId = props.messageId ?? props.message?.id ?? null;

        if (!channelId) {
            console.warn("[ReportCopier] channel-mention-context: couldn't find a channel id in props", props);
            return;
        }

        const link = messageId
            ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
            : `https://discord.com/channels/${guildId}/${channelId}`;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label  : "📤 Définir comme Source (ReportCopier)",
                action : () => this._captureLink("source", link),
            }),
            BdApi.ContextMenu.buildItem({
                label  : "📥 Définir comme Destination (ReportCopier)",
                action : () => this._captureLink("dest", link),
            }),
        ]);
    }

    _captureLink(kind, link) {
        if (kind === "source") {
            this._sourceLink = link;
            BdApi.UI.showToast("📤 Source enregistrée.", { type: "success", timeout: 1500 });
        } else {
            this._destLink = link;
            BdApi.UI.showToast("📥 Destination enregistrée.", { type: "success", timeout: 1500 });
        }
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
            console.error("[ReportCopier] _pushToMenu failed:", e);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  UI — floating button + link-entry modal
    // ─────────────────────────────────────────────────────────────

    _createToggleButton() {
        const btn = document.createElement("button");
        btn.id        = "rpc-toggle-btn";
        btn.innerHTML = "📤";
        btn.title     = "ReportCopier — copier un rapport en doublon";
        btn.onclick   = () => this._openModal();
        document.body.appendChild(btn);
        this._toggleBtn = btn;
    }

    _openModal() {
        let sourceLink   = this._sourceLink;
        let destLink     = this._destLink;
        let deleteSource = false;

        const Form = () => {
            const [src, setSrc] = BdApi.React.useState(this._sourceLink);
            const [dst, setDst] = BdApi.React.useState(this._destLink);
            const [del, setDel] = BdApi.React.useState(false);

            const inputStyle = {
                padding: "8px 10px", borderRadius: 4, fontSize: 14,
                background: "var(--input-background)", color: "var(--text-normal)",
                border: "1px solid var(--background-modifier-accent)", outline: "none",
            };

            return BdApi.React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
                BdApi.React.createElement("div", null,
                    BdApi.React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 } }, "Lien du post en double (source)"),
                    BdApi.React.createElement("input", {
                        type: "text", autoFocus: true, style: { ...inputStyle, width: "100%" },
                        placeholder: "https://discord.com/channels/…", value: src,
                        onChange: e => { setSrc(e.target.value); sourceLink = e.target.value; this._sourceLink = e.target.value; },
                    })
                ),
                BdApi.React.createElement("div", null,
                    BdApi.React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 } }, "Lien du post à conserver (destination)"),
                    BdApi.React.createElement("input", {
                        type: "text", style: { ...inputStyle, width: "100%" },
                        placeholder: "https://discord.com/channels/…", value: dst,
                        onChange: e => { setDst(e.target.value); destLink = e.target.value; this._destLink = e.target.value; },
                    })
                ),
                BdApi.React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-normal)", cursor: "pointer" } },
                    BdApi.React.createElement("input", {
                        type: "checkbox", checked: del,
                        onChange: e => { setDel(e.target.checked); deleteSource = e.target.checked; },
                    }),
                    "Supprimer le post source (doublon) après la copie"
                ),
                BdApi.React.createElement("div", { style: { fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 } },
                    "Le texte, les liens et le @mention du rapporteur sont copiés, et chaque image est re-téléchargée puis renvoyée en pièce jointe réelle (jamais un simple lien)."
                )
            );
        };

        BdApi.UI.showConfirmationModal(
            "📤 Copier un rapport en doublon",
            BdApi.React.createElement(Form),
            {
                confirmText: "Copier",
                cancelText: "Annuler",
                onConfirm: () => {
                    if (!sourceLink.trim() || !destLink.trim()) {
                        BdApi.UI.showToast("❌ Renseigne les deux liens avant de confirmer.", { type: "error", timeout: 2500 });
                        return;
                    }
                    this._sourceLink = "";
                    this._destLink   = "";
                    this._runCopy(sourceLink, destLink, deleteSource);
                },
            }
        );
    }

    // ─────────────────────────────────────────────────────────────
    //  CSS
    // ─────────────────────────────────────────────────────────────

    _injectCSS() {
        BdApi.DOM.addStyle("ReportCopier", `
            #rpc-toggle-btn {
                position       : fixed;
                bottom         : 80px;
                right          : 24px;
                width          : 46px;
                height         : 46px;
                border-radius  : 50%;
                background     : #5865f2;
                border         : none;
                font-size      : 20px;
                cursor         : pointer;
                z-index        : 9999;
                box-shadow     : 0 4px 14px rgba(0,0,0,.45);
                display        : flex;
                align-items    : center;
                justify-content: center;
                transition     : background .15s, transform .1s;
            }
            #rpc-toggle-btn:hover  { background: #4752c4; transform: scale(1.08); }
            #rpc-toggle-btn:active { transform: scale(.95); }
        `);
    }
};
