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
        this._toggleBtn = null;
    }

    start() {
        this._injectCSS();
        this._createToggleButton();
        BdApi.UI.showToast("ReportCopier enabled 📤", { type: "success", timeout: 2000 });
    }

    stop() {
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
    //  Link parsing — accepts a message jump link or a plain channel/
    //  thread link (forum-post starter messages share their thread's ID).
    // ─────────────────────────────────────────────────────────────

    _parseLink(link) {
        const m = String(link ?? "").trim().match(
            /channels\/(@me|\d+)\/(\d+)(?:\/(\d+))?/
        );
        if (!m) return null;
        return { guildId: m[1], channelId: m[2], messageId: m[3] ?? null };
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

    // GET /channels/{id}/messages/{id} (fetch a single message) is bot-only — a user token
    // gets "50001/only bots can use this endpoint". The real client never calls it either:
    // jumping to a link fetches a 1-message window *around* that ID instead, same as here.
    async _fetchMessage(channelId, messageId, token) {
        const list = await this._api(`/channels/${channelId}/messages?around=${messageId}&limit=1`, token);
        const message = list?.find(m => m.id === messageId) ?? list?.[0];
        if (!message) throw new Error("Message source introuvable (supprimé ou inaccessible).");
        return message;
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

    async _postMessage(channelId, content, files, token) {
        const form    = new FormData();
        const payload = { content };
        if (files.length) payload.attachments = files.map((f, i) => ({ id: i, filename: f.filename }));
        form.append("payload_json", JSON.stringify(payload));
        files.forEach((f, i) => form.append(`files[${i}]`, f.blob, f.filename));

        return this._api(`/channels/${channelId}/messages`, token, { method: "POST", body: form });
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
            const message   = await this._fetchMessage(src.channelId, srcMsgId, token);

            const images = this._collectImages(message);
            const files  = await this._downloadImages(images);

            const jumpLink = `https://discord.com/channels/${src.guildId}/${src.channelId}/${srcMsgId}`;
            const authorId = message.author?.id;

            const parts = [message.content || ""];
            parts.push("");
            parts.push(`🔗 Source : ${jumpLink}`);
            if (authorId) parts.push(`👤 Reporter : <@${authorId}>`);
            let content = parts.join("\n").trim();
            if (content.length > 1990) content = content.slice(0, 1987) + "…";

            await this._postMessage(dst.channelId, content, files, token);

            BdApi.UI.showToast(
                `✅ Copié${files.length ? ` (${files.length} image${files.length > 1 ? "s" : ""})` : ""} vers la destination.`,
                { type: "success", timeout: 3000 }
            );

            if (deleteSource) {
                const isReplyOnly = src.messageId && src.messageId !== src.channelId;
                if (isReplyOnly) {
                    await this._api(`/channels/${src.channelId}/messages/${src.messageId}`, token, { method: "DELETE" });
                    BdApi.UI.showToast("🗑️ Message source supprimé.", { type: "info", timeout: 2000 });
                } else {
                    await this._api(`/channels/${src.channelId}`, token, { method: "DELETE" });
                    BdApi.UI.showToast("🗑️ Post source (doublon) supprimé.", { type: "info", timeout: 2000 });
                }
            }
        } catch (err) {
            console.error("[ReportCopier] copy failed:", err);
            BdApi.UI.showToast(`❌ Échec de la copie : ${err.message}`, { type: "error", timeout: 4500 });
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
        let sourceLink   = "";
        let destLink     = "";
        let deleteSource = false;

        const Form = () => {
            const [src, setSrc] = BdApi.React.useState("");
            const [dst, setDst] = BdApi.React.useState("");
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
                        onChange: e => { setSrc(e.target.value); sourceLink = e.target.value; },
                    })
                ),
                BdApi.React.createElement("div", null,
                    BdApi.React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 } }, "Lien du post à conserver (destination)"),
                    BdApi.React.createElement("input", {
                        type: "text", style: { ...inputStyle, width: "100%" },
                        placeholder: "https://discord.com/channels/…", value: dst,
                        onChange: e => { setDst(e.target.value); destLink = e.target.value; },
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
