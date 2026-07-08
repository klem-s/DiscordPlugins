/**
 * @name AdminToolkit
 * @author klem___s
 * @authorId 321332083731726338
 * @description Clipboard History + Evidence Collector for server admins.
 *   – Right-click any message or user to save to your clipboard history.
 *   – Build evidence cases from messages and export a formatted report.
 *   – Click the 🛡️ button (bottom-right) to open the panel.
 * @version 1.0.0
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s
 */

module.exports = class AdminToolkit {

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    constructor() {
        this.history        = [];
        this.cases          = [];
        this.activeCaseId   = null;
        this._unpatches     = [];
        this._panel         = null;
        this._toggleBtn     = null;
        this._panelOpen     = false;
        this._activeTab     = "history";   // "history" | "evidence"
        this._newCaseMode   = false;       // shows inline input in evidence tab
        this._handleClick   = this._handleClick.bind(this);
        this._onPaste       = this._onPaste.bind(this);
    }

    start() {
        // Restore persisted data
        this.history      = BdApi.Data.load("AdminToolkit", "history")      || [];
        this.cases        = BdApi.Data.load("AdminToolkit", "cases")        || [];
        this.activeCaseId = BdApi.Data.load("AdminToolkit", "activeCaseId") || null;

        // Try to pre-load html2canvas (graceful – no crash if CDN blocked)
        this._loadHtml2Canvas().catch(() => {});

        // Ctrl/Cmd+Click → add message to active case (replaces CopyUserID behaviour)
        document.addEventListener("click", this._handleClick);
        // Ctrl+V anywhere → paste screenshot into active case
        document.addEventListener("paste", this._onPaste);

        // Patch context menus
        this._unpatches.push(
            BdApi.ContextMenu.patch("message",      this._patchMessageMenu.bind(this))
        );
        this._unpatches.push(
            BdApi.ContextMenu.patch("user-context", this._patchUserMenu.bind(this))
        );

        this._injectCSS();
        this._createToggleButton();

        BdApi.UI.showToast("AdminToolkit enabled ✅", { type: "success", timeout: 2500 });
    }

    stop() {
        document.removeEventListener("click",  this._handleClick);
        document.removeEventListener("paste",  this._onPaste);
        this._unpatches.forEach(u => u());
        this._unpatches = [];
        this._toggleBtn?.remove();
        this._panel?.remove();
        BdApi.DOM.removeStyle("AdminToolkit");
    }

    // ─────────────────────────────────────────────────────────────
    //  Persistence
    // ─────────────────────────────────────────────────────────────

    _save() {
        BdApi.Data.save("AdminToolkit", "history",      this.history);
        BdApi.Data.save("AdminToolkit", "cases",        this.cases);
        BdApi.Data.save("AdminToolkit", "activeCaseId", this.activeCaseId);
    }

    // ─────────────────────────────────────────────────────────────
    //  Ctrl/Cmd+Click → add to active evidence case
    // ─────────────────────────────────────────────────────────────

    _handleClick(e) {
        if (!e.metaKey && !e.ctrlKey) return;

        const target = e.target;
        const msgEl  = target.closest("[data-author-id]") ||
                       target.closest("li[id*='chat-messages']");
        if (!msgEl) return;

        const data = this._getMessageFromReact(target);
        if (!data?.message) return;

        e.preventDefault();
        e.stopPropagation();

        this._addMessageToUserCase(data.message);
    }

    // Create (or reuse) a case for this user's ID, save the message jump link, open panel.
    _addMessageToUserCase(message) {
        // Add to the currently active case if one is open — otherwise create one for this user
        let c = this.cases.find(x => x.id === this.activeCaseId);
        if (!c) {
            const userId = message?.author?.id;
            if (!userId) {
                BdApi.UI.showToast("❌ Impossible de récupérer l'ID.", { type: "error", timeout: 2500 });
                return;
            }
            c = this.cases.find(x => x.userId === userId) ?? this._createCase(userId);
            this.activeCaseId = c.id;
        }

        // Save the message jump link + content for display (content never included in template)
        const guildId   = message?.guild_id ?? "@me";
        const channelId = message?.channel_id ?? "";
        const msgId     = message?.id ?? "";
        if (msgId && channelId) {
            c.items.push({
                id         : Date.now(),
                type       : "link",
                jumpLink   : `https://discord.com/channels/${guildId}/${channelId}/${msgId}`,
                content    : message?.content    ?? "",
                authorTag  : message?.author?.username ?? "",
                timestamp  : message?.timestamp  ?? null,
                addedAt    : new Date().toISOString(),
            });
        }

        this._save();
        this._refreshPanel();
        BdApi.UI.showToast(`✅ Lien ajouté au case "${c.name}"`, { type: "success", timeout: 2000 });
    }

    // Open (or create) a case for a user ID — no message added, just opens the panel.
    _openCaseForUser(userId) {
        if (!userId) {
            BdApi.UI.showToast("❌ Impossible de récupérer l'ID.", { type: "error", timeout: 2500 });
            return;
        }
        let c = this.cases.find(x => x.userId === userId);
        if (!c) c = this._createCase(userId);
        this.activeCaseId = c.id;
        this._save();
        this._activeTab = "evidence";
        this._openPanel();
        BdApi.UI.showToast(`📂 Case <@${userId}> ouvert`, { type: "info", timeout: 2000 });
    }

    // Walk React fiber tree to find the message + channel objects
    _getMessageFromReact(element) {
        let el = element;
        for (let i = 0; i < 20 && el; i++) {
            const key = Object.keys(el).find(
                k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
            );
            if (key) {
                let fiber = el[key];
                for (let d = 0; fiber && d < 40; d++) {
                    const props = fiber.memoizedProps ?? fiber.pendingProps;
                    if (props?.message?.id) {
                        return { message: props.message, channel: props.channel ?? null };
                    }
                    fiber = fiber.return;
                }
            }
            el = el.parentElement;
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────
    //  Ctrl+V → paste screenshot into active evidence case
    // ─────────────────────────────────────────────────────────────

    _onPaste(e) {
        const items = Array.from(e.clipboardData?.items ?? []);
        const imageItem = items.find(i => i.type.startsWith("image/"));
        if (!imageItem) return;   // not an image paste — let Discord handle it

        const active = this.cases.find(c => c.id === this.activeCaseId);
        if (!active) {
            // Only intercept if we have an active case, otherwise leave Discord alone
            if (this.cases.length > 0) {
                BdApi.UI.showToast("⚠️ Ouvre 🛡️ panel → sélectionne un case pour coller un screenshot.", { type: "warning", timeout: 3500 });
                e.preventDefault();
            }
            return;
        }

        e.preventDefault();  // prevent Discord from trying to upload the image

        const blob   = imageItem.getAsFile();
        const reader = new FileReader();
        reader.onload = ev => {
            active.items.push({
                id         : Date.now(),
                type       : "screenshot",
                screenshot : ev.target.result,
                note       : "Pasted screenshot",
                addedAt    : new Date().toISOString(),
            });
            this._save();
            this._refreshPanel();
            BdApi.UI.showToast(`📸 Screenshot ajouté à "${active.name}"`, { type: "success", timeout: 2000 });
        };
        reader.readAsDataURL(blob);
    }

    // ─────────────────────────────────────────────────────────────
    //  Screenshot (html2canvas via CDN – optional feature)
    // ─────────────────────────────────────────────────────────────

    _loadHtml2Canvas() {
        if (window.html2canvas) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s   = document.createElement("script");
            s.src     = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
            s.onload  = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    async _captureMessage(messageId) {
        if (!window.html2canvas) {
            try { await this._loadHtml2Canvas(); } catch { return null; }
        }
        // Discord renders each message as a <li> with id like "chat-messages-MSGID"
        const el =
            document.querySelector(`[id="chat-messages-${messageId}"]`) ||
            document.querySelector(`li[id*="${messageId}"]`)             ||
            document.querySelector(`[data-id="${messageId}"]`);
        if (!el) return null;
        try {
            const canvas = await window.html2canvas(el, {
                backgroundColor : "#313338",
                scale           : 1,
                useCORS         : true,
                allowTaint      : true,
                logging         : false,
            });
            return canvas.toDataURL("image/png");
        } catch (e) {
            console.warn("[AdminToolkit] Screenshot failed:", e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Context-menu patches
    // ─────────────────────────────────────────────────────────────

    _patchMessageMenu(retVal, props) {
        const { message, channel } = props;
        if (!message) return;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label  : "🔍 Add to Evidence Case",
                action : () => this._addMessageToUserCase(message),
            }),
            BdApi.ContextMenu.buildItem({
                label  : "📂 Open / New Case",
                action : () => this._openCaseForUser(message?.author?.id),
            }),
            BdApi.ContextMenu.buildItem({
                label  : "📋 Save to Clipboard History",
                action : () => this._saveMessageToHistory(message, channel),
            }),
        ]);
    }

    _patchUserMenu(retVal, props) {
        const { user } = props;
        if (!user) return;

        this._pushToMenu(retVal, [
            BdApi.ContextMenu.buildItem({ type: "separator" }),
            BdApi.ContextMenu.buildItem({
                label  : "📋 Save User to Clipboard History",
                action : () => this._saveUserToHistory(user),
            }),
        ]);
    }

    // Safely push items into a context-menu React element.
    // Handles: plain array, frozen array, single element, nested children.
    _pushToMenu(retVal, items) {
        if (!retVal?.props) return;
        try {
            let target   = retVal.props;
            let ch       = target.children;

            // Some Discord versions nest children one level deeper
            if (!Array.isArray(ch) && Array.isArray(ch?.props?.children)) {
                target = ch.props;
                ch     = target.children;
            }

            if (Array.isArray(ch)) {
                if (Object.isFrozen(ch)) {
                    // Can't push into a frozen array — replace it
                    target.children = [...ch, ...items];
                } else {
                    ch.push(...items);
                }
            } else {
                // children is a single element or undefined
                target.children = [...(ch != null ? [ch] : []), ...items];
            }
        } catch (e) {
            console.error("[AdminToolkit] _pushToMenu failed:", e);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Clipboard History – actions
    // ─────────────────────────────────────────────────────────────

    async _saveMessageToHistory(message, channel) {
        const guildId    = channel?.guild_id ?? message?.guild_id ?? "@me";
        const screenshot = await this._captureMessage(message.id);

        this.history.unshift({
            id         : Date.now(),
            type       : "message",
            messageId  : message.id,
            content    : message.content || "(no text)",
            authorId   : message.author?.id   ?? "",
            authorTag  : `${message.author?.username ?? "?"}#${message.author?.discriminator ?? "0"}`,
            channelId  : message.channel_id,
            timestamp  : message.timestamp,
            savedAt    : new Date().toISOString(),
            screenshot,
            jumpLink   : `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
        });

        if (this.history.length > 50) this.history.length = 50;
        this._save();
        this._refreshPanel();
        BdApi.UI.showToast("Message saved to history 📋", { type: "success", timeout: 2000 });
    }

    _saveUserToHistory(user) {
        this.history.unshift({
            id            : Date.now(),
            type          : "user",
            userId        : user.id,
            username      : user.username,
            discriminator : user.discriminator ?? "0",
            tag           : `${user.username}#${user.discriminator ?? "0"}`,
            savedAt       : new Date().toISOString(),
        });

        if (this.history.length > 50) this.history.length = 50;
        this._save();
        this._refreshPanel();
        BdApi.UI.showToast(`${user.username} saved to history 📋`, { type: "success", timeout: 2000 });
    }

    _deleteHistoryItem(id) {
        this.history = this.history.filter(i => i.id !== id);
        this._save();
        this._refreshPanel();
    }

    _clearHistory() {
        this.history = [];
        this._save();
        this._refreshPanel();
    }

    // ─────────────────────────────────────────────────────────────
    //  Evidence – actions
    // ─────────────────────────────────────────────────────────────

    _createCase(userId) {
        const c = {
            id        : String(Date.now()),
            userId    : userId,                    // raw Discord user ID
            name      : userId,                    // displayed as <@userId>
            items     : [],
            createdAt : new Date().toISOString(),
        };
        this.cases.push(c);
        this.activeCaseId = c.id;
        this._save();
        this._refreshPanel();
        return c;
    }

    async _addToEvidence(message, channel, caseId) {
        try {
            const c = this.cases.find(x => x.id === caseId);
            if (!c) {
                BdApi.UI.showToast("❌ Case introuvable.", { type: "error", timeout: 2500 });
                return;
            }

            // Be defensive — message object might be incomplete
            const msgId    = message?.id ?? message?.message_id;
            const content  = message?.content ?? "(no text)";
            const authorId = message?.author?.id ?? "";
            const authorUsername = message?.author?.username
                                ?? message?.author?.global_name
                                ?? "?";
            const authorDisc = message?.author?.discriminator ?? "0";
            const channelId  = message?.channel_id ?? channel?.id ?? "";
            const guildId    = channel?.guild_id ?? message?.guild_id ?? "@me";
            const timestamp  = message?.timestamp ?? new Date().toISOString();

            const screenshot = msgId ? await this._captureMessage(msgId) : null;

            c.items.push({
                id         : Date.now(),
                type       : "message",
                messageId  : msgId,
                content,
                authorId,
                authorTag  : `${authorUsername}#${authorDisc}`,
                timestamp,
                addedAt    : new Date().toISOString(),
                screenshot,
                jumpLink   : `https://discord.com/channels/${guildId}/${channelId}/${msgId}`,
            });

            this._save();
            this._refreshPanel();
            BdApi.UI.showToast(`✅ Ajouté à "${c.name}"`, { type: "success", timeout: 2000 });
        } catch (err) {
            console.error("[AdminToolkit] _addToEvidence error:", err);
            BdApi.UI.showToast("❌ Erreur lors de l'ajout. Voir console.", { type: "error", timeout: 3000 });
        }
    }

    _deleteEvidenceItem(caseId, itemId) {
        const c = this.cases.find(x => x.id === caseId);
        if (!c) return;
        c.items = c.items.filter(i => i.id !== itemId);
        this._save();
        this._refreshPanel();
    }

    _deleteCase(caseId) {
        this.cases = this.cases.filter(c => c.id !== caseId);
        if (this.activeCaseId === caseId) {
            this.activeCaseId = this.cases[0]?.id ?? null;
        }
        this._save();
        this._refreshPanel();
    }

    _clearAllCases() {
        this.cases        = [];
        this.activeCaseId = null;
        this._save();
        this._refreshPanel();
    }

    // ─────────────────────────────────────────────────────────────
    //  Helper – composite canvas (shared by copy + inject)
    // ─────────────────────────────────────────────────────────────

    async _buildCompositeCanvas(screenshotItems) {
        const images = await Promise.all(
            screenshotItems.map(item => new Promise(resolve => {
                const img   = new Image();
                img.onload  = () => resolve(img);
                img.onerror = () => resolve(null);
                img.src     = item.screenshot;
            }))
        ).then(imgs => imgs.filter(Boolean));

        if (!images.length) return null;

        const GAP    = 8;
        const WIDTH  = Math.max(...images.map(i => i.naturalWidth));
        const HEIGHT = images.reduce((s, i) => s + i.naturalHeight + GAP, 0);
        const canvas = document.createElement("canvas");
        canvas.width  = WIDTH;
        canvas.height = HEIGHT;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#313338";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        let y = 0;
        for (const img of images) {
            ctx.drawImage(img, 0, y);
            y += img.naturalHeight + GAP;
        }
        return canvas;
    }

    // ─────────────────────────────────────────────────────────────
    //  📤 Inject into Discord composer (text + image upload dialog)
    // ─────────────────────────────────────────────────────────────

    async _copyTemplate(caseId) {
        const c = this.cases.find(x => x.id === caseId);
        if (!c) return;

        const links = c.items
            .filter(i => i.type === "link" && i.jumpLink)
            .map(i => i.jumpLink);
        const text = [`<@${c.userId}>`, ...(links.length ? ["", ...links] : [])].join("\n");

        DiscordNative.clipboard.copy(text);
        BdApi.UI.showToast("📋 Mention + liens copiés ✅", { type: "success", timeout: 2000 });
    }

    async _copyScreenshots(caseId) {
        const c = this.cases.find(x => x.id === caseId);
        if (!c) return;

        const screenshots = c.items.filter(i => i.screenshot);
        if (!screenshots.length) {
            BdApi.UI.showToast("⚠️ Aucun screenshot dans ce case.", { type: "warning", timeout: 2000 });
            return;
        }

        const canvas = await this._buildCompositeCanvas(screenshots);
        if (!canvas) {
            BdApi.UI.showToast("❌ Impossible de charger les images.", { type: "error", timeout: 2000 });
            return;
        }

        try {
            this._copyCanvasToClipboard(canvas);
            BdApi.UI.showToast(`📸 ${screenshots.length} screenshot(s) copié(s) ✅ — colle dans Discord`, { type: "success", timeout: 2500 });
        } catch (err) {
            console.error("[AdminToolkit] _copyScreenshots:", err);
            BdApi.UI.showToast("❌ Erreur copie image. Voir console.", { type: "error", timeout: 2500 });
        }
    }

    _copyImageToClipboard(caseId, itemId) {
        const c    = this.cases.find(x => x.id === caseId);
        const item = c?.items.find(i => i.id === Number(itemId));
        if (!item?.screenshot) {
            BdApi.UI.showToast("❌ Pas de screenshot disponible.", { type: "error", timeout: 2000 });
            return;
        }
        try {
            // Rebuild a 1-item canvas so we go through the same path
            const img = new Image();
            img.onload = () => {
                const canvas  = document.createElement("canvas");
                canvas.width  = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext("2d").drawImage(img, 0, 0);
                this._copyCanvasToClipboard(canvas);
                BdApi.UI.showToast("📸 Screenshot copié ✅", { type: "success", timeout: 1500 });
            };
            img.onerror = () => BdApi.UI.showToast("❌ Image introuvable.", { type: "error", timeout: 2000 });
            img.src = item.screenshot;
        } catch (err) {
            console.error("[AdminToolkit] copy image failed:", err);
            BdApi.UI.showToast("❌ Erreur copie image. Voir console.", { type: "error", timeout: 2500 });
        }
    }

    // Copies a canvas as PNG to the system clipboard via DiscordNative (no nativeImage needed).
    _copyCanvasToClipboard(canvas) {
        const dataUrl  = canvas.toDataURL("image/png");
        const base64   = dataUrl.split(",")[1];
        const binary   = atob(base64);
        const buffer   = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
        DiscordNative.clipboard.copyImage(buffer, { width: canvas.width, height: canvas.height });
    }

    // ─────────────────────────────────────────────────────────────
    //  Panel – lifecycle
    // ─────────────────────────────────────────────────────────────

    _createToggleButton() {
        const btn    = document.createElement("button");
        btn.id       = "atk-toggle-btn";
        btn.innerHTML = "🛡️";
        btn.title    = "AdminToolkit";
        btn.onclick  = () => this._togglePanel();
        document.body.appendChild(btn);
        this._toggleBtn = btn;
    }

    _togglePanel() {
        this._panelOpen ? this._closePanel() : this._openPanel();
    }

    _openPanel() {
        if (this._panel) this._panel.remove();
        const el  = document.createElement("div");
        el.id     = "atk-panel";
        el.innerHTML = this._buildPanelHTML();
        document.body.appendChild(el);
        this._panel     = el;
        this._panelOpen = true;
        if (this._toggleBtn) this._toggleBtn.style.display = "none";
        this._bindEvents();
    }

    _closePanel() {
        this._panel?.remove();
        this._panel     = null;
        this._panelOpen = false;
        if (this._toggleBtn) this._toggleBtn.style.display = "";
    }

    _refreshPanel() {
        if (!this._panelOpen) return;
        // Recreate the whole element — avoids stacking multiple click listeners
        // each time innerHTML is patched (which caused "50 cases / X20 popups").
        this._openPanel();
    }

    // ─────────────────────────────────────────────────────────────
    //  Panel – HTML builders
    // ─────────────────────────────────────────────────────────────

    _buildPanelHTML() {
        return `
        <div class="atk-header">
            <span class="atk-title">🛡️ AdminToolkit</span>
            <button class="atk-icon-btn" data-action="close" title="Close">✕</button>
        </div>
        <div class="atk-tabs">
            <button class="atk-tab ${this._activeTab === "history"  ? "atk-tab--active" : ""}" data-action="tab" data-tab="history">📋 Clipboard</button>
            <button class="atk-tab ${this._activeTab === "evidence" ? "atk-tab--active" : ""}" data-action="tab" data-tab="evidence">🔍 Evidence</button>
        </div>
        <div class="atk-body">
            ${this._activeTab === "history" ? this._buildHistoryHTML() : this._buildEvidenceHTML()}
        </div>`;
    }

    _buildHistoryHTML() {
        if (!this.history.length) {
            return `<div class="atk-empty">No items yet.<br>Right-click a <b>message</b> or <b>user</b> to save.</div>`;
        }

        const items = this.history.map(item => {
            if (item.type === "user") {
                return `
                <div class="atk-item">
                    <div class="atk-item-lead">👤</div>
                    <div class="atk-item-body">
                        <div class="atk-item-title">${this._esc(item.tag)}</div>
                        <div class="atk-item-sub">ID: ${item.userId}</div>
                        <div class="atk-item-time">${new Date(item.savedAt).toLocaleString()}</div>
                    </div>
                    <div class="atk-item-actions">
                        <button class="atk-icon-btn" title="Copy ID"  data-action="copy" data-value="${item.userId}">🆔</button>
                        <button class="atk-icon-btn" title="Copy tag" data-action="copy" data-value="${item.tag} (${item.userId})">🏷️</button>
                        <button class="atk-icon-btn atk-danger" title="Delete" data-action="del-history" data-id="${item.id}">🗑️</button>
                    </div>
                </div>`;
            }

            return `
            <div class="atk-item">
                <div class="atk-item-lead">💬</div>
                <div class="atk-item-body">
                    <div class="atk-item-title">${this._esc(item.authorTag)}</div>
                    <div class="atk-item-sub">${this._esc(item.content.substring(0, 90))}${item.content.length > 90 ? "…" : ""}</div>
                    <div class="atk-item-time">${new Date(item.savedAt).toLocaleString()}</div>
                    ${item.screenshot ? `<img class="atk-thumb" src="${item.screenshot}" alt="screenshot">` : ""}
                </div>
                <div class="atk-item-actions">
                    <button class="atk-icon-btn" title="Copy User ID"    data-action="copy" data-value="${item.authorId}">👤</button>
                    <button class="atk-icon-btn" title="Copy Message ID" data-action="copy" data-value="${item.messageId}">🆔</button>
                    <button class="atk-icon-btn" title="Copy Jump Link"  data-action="copy" data-value="${item.jumpLink}">🔗</button>
                    <button class="atk-icon-btn atk-danger" title="Delete" data-action="del-history" data-id="${item.id}">🗑️</button>
                </div>
            </div>`;
        }).join("");

        return `
        <div class="atk-list-bar">
            <span>${this.history.length} item${this.history.length !== 1 ? "s" : ""}</span>
            <button class="atk-btn-sm atk-danger" data-action="clear-history">Clear all</button>
        </div>
        <div class="atk-list">${items}</div>`;
    }

    _buildEvidenceHTML() {
        const opts = this.cases.map(c =>
            `<option value="${c.id}" ${c.id === this.activeCaseId ? "selected" : ""}><@${this._esc(c.userId)}> (${c.items.length})</option>`
        ).join("");

        const active = this.cases.find(c => c.id === this.activeCaseId);

        const caseItems = active?.items.map((item, i) => {
            // ── Screenshot pasted via Ctrl+V ──────────────────────
            if (item.type === "screenshot") {
                return `
                <div class="atk-item">
                    <div class="atk-item-lead atk-item-num">${i + 1}</div>
                    <div class="atk-item-body">
                        <div class="atk-item-title">📸 Screenshot</div>
                        <div class="atk-item-time">${new Date(item.addedAt).toLocaleString()}</div>
                        <img class="atk-thumb" src="${item.screenshot}" alt="screenshot">
                    </div>
                    <div class="atk-item-actions">
                        <button class="atk-icon-btn" title="Copier image" data-action="copy-image" data-case="${active.id}" data-id="${item.id}">📋</button>
                        <button class="atk-icon-btn atk-danger" title="Supprimer" data-action="del-evidence" data-case="${active.id}" data-id="${item.id}">🗑️</button>
                    </div>
                </div>`;
            }
            // ── Message link (jump link only) ─────────────────────
            if (item.type === "link") {
                const preview = item.content
                    ? `<div class="atk-msg-preview">${this._esc(item.content.substring(0, 120))}${item.content.length > 120 ? "…" : ""}</div>`
                    : "";
                const meta = item.authorTag
                    ? `<div class="atk-item-time">${this._esc(item.authorTag)}${item.timestamp ? " · " + new Date(item.timestamp).toLocaleString() : ""}</div>`
                    : `<div class="atk-item-time">${new Date(item.addedAt).toLocaleString()}</div>`;
                return `
                <div class="atk-item atk-item--link">
                    <div class="atk-item-lead atk-item-num">${i + 1}</div>
                    <div class="atk-item-body">
                        <div class="atk-item-title">🔗 Message link</div>
                        ${meta}
                        ${preview}
                        <span class="atk-copy-link" data-action="copy" data-value="${item.jumpLink}">${item.jumpLink}</span>
                    </div>
                    <div class="atk-item-actions">
                        <button class="atk-icon-btn" title="Copier le lien" data-action="copy" data-value="${item.jumpLink}">📋</button>
                        <button class="atk-icon-btn atk-danger" title="Supprimer" data-action="del-evidence" data-case="${active.id}" data-id="${item.id}">🗑️</button>
                    </div>
                </div>`;
            }
            // ── Fallback (old message type) ────────────────────────
            return `
            <div class="atk-item">
                <div class="atk-item-lead atk-item-num">${i + 1}</div>
                <div class="atk-item-body">
                    <div class="atk-item-sub">${this._esc((item.content ?? "").substring(0, 100))}${(item.content ?? "").length > 100 ? "…" : ""}</div>
                    <div class="atk-item-time">${item.timestamp ? new Date(item.timestamp).toLocaleString() : ""}</div>
                    ${item.screenshot ? `<img class="atk-thumb" src="${item.screenshot}" alt="screenshot">` : ""}
                    ${item.jumpLink   ? `<span class="atk-copy-link" data-action="copy" data-value="${item.jumpLink}">🔗 Lien</span>` : ""}
                </div>
                <div class="atk-item-actions">
                    ${item.screenshot ? `<button class="atk-icon-btn" title="Copier image" data-action="copy-image" data-case="${active.id}" data-id="${item.id}">📋</button>` : ""}
                    <button class="atk-icon-btn atk-danger" title="Supprimer" data-action="del-evidence" data-case="${active.id}" data-id="${item.id}">🗑️</button>
                </div>
            </div>`;
        }).join("") ?? "";

        const emptyHint = !active || active.items.length === 0
            ? `<div class="atk-empty">
                   Ctrl+Clic sur un message pour l'ajouter.<br>
                   <b>Ctrl+V</b> pour coller un screenshot.
               </div>` : "";

        const toolbar = `
            <div class="atk-evidence-bar">
                <select class="atk-select" data-action="select-case">
                    <option value="">— Sélectionner —</option>
                    ${opts}
                </select>
                ${active ? `<button class="atk-btn-sm atk-danger" data-action="del-case" data-id="${active.id}" title="Supprimer ce case">🗑️</button>` : ""}
            </div>`;

        const hasScreenshots = active?.items.some(i => i.screenshot);
        const clearAllBtn = this.cases.length > 1
            ? `<button class="atk-btn-sm atk-danger atk-btn-clear-all" data-action="clear-all-cases">🗑️ Clear all (${this.cases.length})</button>`
            : "";

        const footer = active ? `
            <div class="atk-evidence-footer">
                <div class="atk-mention-row">
                    <code class="atk-mention-code">&lt;@${this._esc(active.userId)}&gt;</code>
                    <button class="atk-icon-btn" title="Copier l'ID" data-action="copy" data-value="${this._esc(active.userId)}">🆔</button>
                </div>
                <div class="atk-footer-btns">
                    <button class="atk-btn-primary" data-action="copy-template" data-id="${active.id}">📋 1. Copier mention + liens</button>
                    ${hasScreenshots
                        ? `<button class="atk-btn-primary" data-action="copy-screenshots" data-id="${active.id}">📸 2. Copier les images</button>`
                        : `<span class="atk-hint">Ctrl+V pour ajouter des screenshots</span>`}
                </div>
                ${clearAllBtn}
            </div>` : `${this.cases.length > 0
                ? `<div class="atk-evidence-footer">
                       ${clearAllBtn}
                   </div>` : ""}`;

        return `
        ${toolbar}
        ${active ? `<div class="atk-list">${caseItems}</div>` : ""}
        ${emptyHint}
        ${footer}`;
    }

    // ─────────────────────────────────────────────────────────────
    //  Panel – event delegation
    // ─────────────────────────────────────────────────────────────

    _bindEvents() {
        if (!this._panel) return;

        this._panel.addEventListener("click", e => {
            const el     = e.target.closest("[data-action]");
            if (!el) return;
            const { action, value, id, tab } = el.dataset;
            const caseId = el.dataset.case;

            switch (action) {
                case "close":
                    this._closePanel();
                    break;

                case "tab":
                    this._activeTab = tab;
                    this._refreshPanel();
                    break;

                case "copy":
                    DiscordNative.clipboard.copy(value);
                    BdApi.UI.showToast("Copied ✅", { type: "success", timeout: 1500 });
                    break;

                case "del-history":
                    this._deleteHistoryItem(Number(id));
                    break;

                case "clear-history":
                    BdApi.UI.showConfirmationModal(
                        "Clear History",
                        "Clear all clipboard history? This cannot be undone.",
                        {
                            confirmText : "Clear all",
                            cancelText  : "Cancel",
                            danger      : true,
                            onConfirm   : () => this._clearHistory(),
                        }
                    );
                    break;

                case "copy-mention":   // legacy
                case "copy-template":
                    this._copyTemplate(id);
                    break;

                case "copy-screenshots":
                    this._copyScreenshots(id);
                    break;

                case "copy-image":
                    this._copyImageToClipboard(caseId, id);
                    break;

                case "del-case": {
                    const caseName = this.cases.find(c => c.id === id)?.name ?? "this case";
                    BdApi.UI.showConfirmationModal(
                        "Delete Case",
                        `Delete "${caseName}" and all its evidence? This cannot be undone.`,
                        {
                            confirmText : "Delete",
                            cancelText  : "Cancel",
                            danger      : true,
                            onConfirm   : () => this._deleteCase(id),
                        }
                    );
                    break;
                }

                case "del-evidence":
                    this._deleteEvidenceItem(caseId, Number(id));
                    break;

                case "copy-report": // legacy
                    this._copyTemplate(id);
                    break;

                case "clear-all-cases":
                    BdApi.UI.showConfirmationModal(
                        "Clear All Cases",
                        `Delete all ${this.cases.length} case(s) and their evidence? This cannot be undone.`,
                        {
                            confirmText : "Clear all",
                            cancelText  : "Cancel",
                            danger      : true,
                            onConfirm   : () => this._clearAllCases(),
                        }
                    );
                    break;
            }
        });

        this._panel.addEventListener("change", e => {
            if (e.target.dataset.action === "select-case") {
                this.activeCaseId = e.target.value || null;
                this._save();
                this._refreshPanel();
            }
        });

        // Allow pressing Enter to confirm new-case input
        this._panel.addEventListener("keydown", e => {
            if (e.key === "Enter" && e.target.id === "atk-new-case-input") {
                e.preventDefault();
                const name = e.target.value.trim() || `Case #${this.cases.length + 1}`;
                this._newCaseMode = false;
                this._createCase(name);
            }
            if (e.key === "Escape" && e.target.id === "atk-new-case-input") {
                this._newCaseMode = false;
                this._refreshPanel();
            }
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────

    _esc(str) {
        return String(str ?? "")
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;");
    }

    // ─────────────────────────────────────────────────────────────
    //  CSS
    // ─────────────────────────────────────────────────────────────

    _injectCSS() {
        BdApi.DOM.addStyle("AdminToolkit", `

        /* ── Toggle button ────────────────────────────────────── */
        #atk-toggle-btn {
            position      : fixed;
            bottom        : 24px;
            right         : 24px;
            width         : 46px;
            height        : 46px;
            border-radius : 50%;
            background    : #5865f2;
            border        : none;
            font-size     : 20px;
            cursor        : pointer;
            z-index       : 9999;
            box-shadow    : 0 4px 14px rgba(0,0,0,.45);
            display       : flex;
            align-items   : center;
            justify-content: center;
            transition    : background .15s, transform .1s;
        }
        #atk-toggle-btn:hover  { background: #4752c4; transform: scale(1.08); }
        #atk-toggle-btn:active { transform: scale(.95); }

        /* ── Panel shell ──────────────────────────────────────── */
        #atk-panel {
            position      : fixed;
            top           : 0;
            right         : 0;
            width         : 380px;
            height        : 100vh;
            background    : #2b2d31;
            border-left   : 1px solid #1e1f22;
            z-index       : 9998;
            display       : flex;
            flex-direction: column;
            font-family   : -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size     : 13px;
            color         : #dcddde;
            overflow      : hidden;
            box-shadow    : -6px 0 24px rgba(0,0,0,.5);
        }

        /* ── Header ───────────────────────────────────────────── */
        .atk-header {
            display         : flex;
            align-items     : center;
            justify-content : space-between;
            padding         : 14px 14px 10px;
            background      : #1e1f22;
            border-bottom   : 1px solid #3a3c42;
            flex-shrink     : 0;
        }
        .atk-title {
            font-weight : 700;
            font-size   : 15px;
            color       : #fff;
            letter-spacing: .3px;
        }

        /* ── Tabs ─────────────────────────────────────────────── */
        .atk-tabs {
            display       : flex;
            background    : #1e1f22;
            border-bottom : 1px solid #3a3c42;
            flex-shrink   : 0;
        }
        .atk-tab {
            flex           : 1;
            padding        : 10px 6px;
            background     : none;
            border         : none;
            border-bottom  : 2px solid transparent;
            color          : #949ba4;
            cursor         : pointer;
            font-size      : 13px;
            font-weight    : 500;
            transition     : color .15s, border-color .15s;
        }
        .atk-tab:hover           { color: #dcddde; background: rgba(255,255,255,.04); }
        .atk-tab--active         { color: #5865f2; border-bottom-color: #5865f2; }

        /* ── Scrollable body ──────────────────────────────────── */
        .atk-body {
            flex           : 1;
            overflow       : hidden;
            display        : flex;
            flex-direction : column;
        }

        /* ── List bar (count + clear) ─────────────────────────── */
        .atk-list-bar {
            display         : flex;
            align-items     : center;
            justify-content : space-between;
            padding         : 7px 12px;
            font-size       : 11px;
            color           : #949ba4;
            background      : #232428;
            border-bottom   : 1px solid #3a3c42;
            flex-shrink     : 0;
        }

        /* ── Items list ───────────────────────────────────────── */
        .atk-list {
            flex           : 1;
            overflow-y     : auto;
            padding        : 8px;
            display        : flex;
            flex-direction : column;
            gap            : 6px;
        }
        .atk-list::-webkit-scrollbar       { width: 4px; }
        .atk-list::-webkit-scrollbar-thumb { background: #4e5058; border-radius: 4px; }

        /* ── Single item ──────────────────────────────────────── */
        .atk-item {
            display       : flex;
            gap           : 10px;
            background    : #313338;
            border        : 1px solid #3a3c42;
            border-radius : 8px;
            padding       : 10px;
            align-items   : flex-start;
            transition    : border-color .15s;
        }
        .atk-item:hover { border-color: #5865f2; }

        .atk-item-lead {
            font-size   : 18px;
            flex-shrink : 0;
            width       : 22px;
            text-align  : center;
            padding-top : 1px;
        }
        .atk-item-num {
            font-size   : 11px;
            font-weight : 700;
            color       : #949ba4;
            padding-top : 3px;
        }

        .atk-item-body {
            flex      : 1;
            min-width : 0;
        }
        .atk-item-title {
            font-weight    : 600;
            color          : #fff;
            white-space    : nowrap;
            overflow       : hidden;
            text-overflow  : ellipsis;
        }
        .atk-item-sub {
            color       : #b5bac1;
            margin-top  : 2px;
            word-break  : break-word;
            line-height : 1.5;
        }
        .atk-item-time {
            font-size  : 10px;
            color      : #72767d;
            margin-top : 4px;
        }

        .atk-thumb {
            max-width     : 100%;
            margin-top    : 7px;
            border-radius : 6px;
            border        : 1px solid #3a3c42;
            cursor        : pointer;
        }
        .atk-copy-link {
            display     : inline-block;
            margin-top  : 5px;
            font-size   : 11px;
            color       : #5865f2;
            cursor      : pointer;
        }
        .atk-copy-link:hover { text-decoration: underline; }

        .atk-msg-preview {
            margin-top    : 5px;
            padding       : 6px 8px;
            background    : #1e1f22;
            border-left   : 3px solid #4e5058;
            border-radius : 0 4px 4px 0;
            color         : #b5bac1;
            font-size     : 12px;
            line-height   : 1.45;
            word-break    : break-word;
        }

        .atk-item-actions {
            display        : flex;
            flex-direction : column;
            gap            : 4px;
            flex-shrink    : 0;
        }

        /* ── Buttons ──────────────────────────────────────────── */
        .atk-icon-btn {
            background    : none;
            border        : none;
            cursor        : pointer;
            font-size     : 15px;
            padding       : 4px;
            border-radius : 4px;
            line-height   : 1;
            color         : #b5bac1;
            transition    : background .12s, color .12s;
        }
        .atk-icon-btn:hover  { background: #3a3c42; color: #fff; }

        .atk-btn-sm {
            background    : #4e5058;
            color         : #dcddde;
            border        : none;
            padding       : 5px 10px;
            border-radius : 4px;
            cursor        : pointer;
            font-size     : 12px;
            font-weight   : 500;
            transition    : background .12s;
        }
        .atk-btn-sm:hover { background: #6d6f78; }

        .atk-btn-primary {
            background    : #5865f2;
            color         : #fff;
            border        : none;
            padding       : 9px 16px;
            border-radius : 6px;
            cursor        : pointer;
            font-size     : 13px;
            font-weight   : 600;
            width         : 100%;
            transition    : background .12s;
        }
        .atk-btn-primary:hover { background: #4752c4; }

        .atk-danger { color: #ed4245 !important; }
        .atk-danger:hover { background: rgba(237,66,69,.15) !important; color: #ed4245 !important; }

        /* ── Evidence toolbar ─────────────────────────────────── */
        .atk-evidence-bar {
            display       : flex;
            align-items   : center;
            gap           : 6px;
            padding       : 10px 12px;
            background    : #232428;
            border-bottom : 1px solid #3a3c42;
            flex-shrink   : 0;
        }
        .atk-select {
            flex          : 1;
            background    : #1e1f22;
            color         : #dcddde;
            border        : 1px solid #3a3c42;
            border-radius : 4px;
            padding       : 5px 8px;
            font-size     : 12px;
        }

        /* ── Evidence footer ──────────────────────────────────── */
        .atk-evidence-footer {
            padding        : 12px;
            border-top     : 1px solid #3a3c42;
            background     : #232428;
            flex-shrink    : 0;
            display        : flex;
            flex-direction : column;
            gap            : 8px;
        }
        .atk-btn-clear-all {
            width      : 100%;
            text-align : center;
        }

        /* ── Mention row ──────────────────────────────────────── */
        .atk-mention-row {
            display     : flex;
            align-items : center;
            gap         : 8px;
        }
        .atk-mention-code {
            flex          : 1;
            background    : #1e1f22;
            color         : #5865f2;
            border        : 1px solid #3a3c42;
            border-radius : 4px;
            padding       : 5px 8px;
            font-size     : 12px;
            font-family   : monospace;
            overflow      : hidden;
            text-overflow : ellipsis;
            white-space   : nowrap;
        }
        .atk-mention-row .atk-btn-primary {
            flex-shrink : 0;
            width       : auto;
            padding     : 6px 12px;
        }

        /* ── Footer buttons row ──────────────────────────────────── */
        .atk-footer-btns {
            display        : flex;
            flex-direction : column;
            gap            : 6px;
        }
        .atk-hint {
            font-size  : 11px;
            color      : #72767d;
            text-align : center;
        }

        /* ── Empty state ──────────────────────────────────────── */
        .atk-empty {
            text-align  : center;
            color       : #72767d;
            padding     : 48px 20px;
            line-height : 1.9;
        }
        .atk-empty b { color: #949ba4; }

        `);
    }

};
