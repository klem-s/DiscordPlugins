/**
 * @name PluginShop
 * @author klem___s
 * @authorId 321332083731726338
 * @description Adds a "🛒 My Plugin Shop" button inside BetterDiscord's own
 *   Settings → Plugins tab, listing only the plugins hosted in
 *   klem-s/DiscordPlugins on GitHub. Install / update writes the file
 *   straight into your BD plugins folder; enable / disable only ever
 *   touches plugins from that repo.
 * @version 3.1.0
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s/DiscordPlugins
 */

const REPO_OWNER    = "klem-s";
const REPO_NAME     = "DiscordPlugins";
const CACHE_TTL_MS  = 10 * 60 * 1000; // 10 minutes

module.exports = class PluginShop {

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    constructor() {
        this._observer   = null;
        this._rafId      = null;
        this._open       = false;
        this._panelEl    = null;
        this._hiddenList = null;
        this._loading    = false;
        this._error      = null;
        this._entries    = [];
        this._ensureInjected = this._ensureInjected.bind(this);
    }

    start() {
        this._injectCSS();
        this._startObserver();
        BdApi.UI.showToast("PluginShop enabled 🛒", { type: "success", timeout: 2000 });
    }

    stop() {
        this._observer?.disconnect();
        this._observer = null;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }

        this._closeShopPanel();
        document.querySelectorAll(".pls-shop-btn").forEach(el => el.remove());

        BdApi.DOM.removeStyle("PluginShop");
    }

    // ─────────────────────────────────────────────────────────────
    //  Settings panel (gear icon on this plugin's own addon card) —
    //  lets you paste an optional GitHub token to raise the rate limit
    //  from 60/hour (unauthenticated) to 5000/hour.
    // ─────────────────────────────────────────────────────────────

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "pls-settings";
        const token = BdApi.Data.load("PluginShop", "githubToken") || "";

        panel.innerHTML = `
            <div class="pls-settings-label">Jeton GitHub (optionnel)</div>
            <div class="pls-settings-hint">
                Sans jeton, GitHub limite à 60 requêtes/heure — vite atteint en cas de
                rechargements répétés. Avec un
                <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">Personal Access Token</a>
                (aucune permission requise pour lire un dépôt public), la limite passe à 5000/heure.
                Le jeton n'est envoyé qu'à api.github.com / raw.githubusercontent.com et reste stocké en local.
            </div>
            <input type="password" class="pls-settings-input" placeholder="ghp_..." value="${this._esc(token)}" autocomplete="off">
            <div class="pls-settings-actions">
                <button class="pls-btn-primary" data-action="save-token">Enregistrer</button>
                <button class="pls-btn-sm pls-danger" data-action="clear-token">Effacer</button>
            </div>
        `;

        panel.querySelector('[data-action="save-token"]').onclick = () => {
            const value = panel.querySelector(".pls-settings-input").value.trim();
            BdApi.Data.save("PluginShop", "githubToken", value);
            // A saved token should get a real chance to work immediately — otherwise
            // a leftover cooldown from the unauthenticated limit keeps blocking every
            // request before it's even attempted, regardless of the new token.
            BdApi.Data.save("PluginShop", "rateLimitedUntil", 0);
            BdApi.UI.showToast(value ? "✅ Jeton GitHub enregistré." : "Jeton vide enregistré.", { type: "success", timeout: 2000 });
        };
        panel.querySelector('[data-action="clear-token"]').onclick = () => {
            BdApi.Data.save("PluginShop", "githubToken", "");
            panel.querySelector(".pls-settings-input").value = "";
            BdApi.UI.showToast("🗑️ Jeton GitHub effacé.", { type: "success", timeout: 2000 });
        };

        return panel;
    }

    // ─────────────────────────────────────────────────────────────
    //  DOM injection into BD's own Settings → Plugins panel
    //
    //  We tried adding a real sidebar row next to Plugins/Themes by patching
    //  Discord's own settings layout module — it worked visually but ended up
    //  breaking the real Plugins tab (calling its buildLayout() out of band
    //  had side effects Discord's code didn't expect). Plain DOM injection
    //  into BD's OWN rendered markup is far lower risk: worst case is the
    //  button doesn't appear, it can't take down the rest of Settings.
    // ─────────────────────────────────────────────────────────────

    _startObserver() {
        this._ensureInjected();

        this._observer = new MutationObserver(mutations => {
            let added = false;
            for (const m of mutations) {
                if (m.addedNodes.length) { added = true; break; }
            }
            if (!added) return;
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._ensureInjected();
            });
        });

        this._observer.observe(document.body, { childList: true, subtree: true });
    }

    _ensureInjected() {
        const controls = document.querySelector(".bd-controls-basic");
        if (controls && !controls.querySelector(".pls-shop-btn")) {
            const btn = document.createElement("button");
            btn.className = "pls-shop-btn";
            btn.type      = "button";
            btn.title     = "My Plugin Shop";
            btn.innerHTML = "🛒";
            btn.onclick   = () => this._toggleShopPanel();
            controls.appendChild(btn);
        }

        // Settings DOM gets torn down/rebuilt when switching tabs — reopen if needed.
        if (this._open && this._panelEl && !document.body.contains(this._panelEl)) {
            this._panelEl    = null;
            this._hiddenList = null;
            this._openShopPanel();
        }
    }

    _toggleShopPanel() {
        this._open = !this._open;
        this._open ? this._openShopPanel() : this._closeShopPanel();
    }

    _openShopPanel() {
        const list = document.querySelector(".bd-addon-list");
        if (!list) return;

        this._hiddenList = list;
        list.style.display = "none";

        const panel = document.createElement("div");
        panel.className = "pls-panel";
        panel.innerHTML = this._buildPanelHTML();
        list.parentElement.insertBefore(panel, list);

        this._panelEl = panel;
        this._bindPanelEvents();
        this._refreshShop();
    }

    _closeShopPanel() {
        this._panelEl?.remove();
        this._panelEl = null;
        if (this._hiddenList) {
            this._hiddenList.style.display = "";
            this._hiddenList = null;
        }
        this._open = false;
    }

    // ─────────────────────────────────────────────────────────────
    //  Manifest (scans klem-s/DiscordPlugins on GitHub)
    // ─────────────────────────────────────────────────────────────

    async _fetchManifest(force = false) {
        const cache = BdApi.Data.load("PluginShop", "manifestCache");
        const now   = Date.now();
        if (!force && cache && (now - cache.fetchedAt) < CACHE_TTL_MS) {
            return cache.entries;
        }

        const rateLimitMs = this._rateLimitRemainingMs();
        if (rateLimitMs > 0) {
            if (cache) {
                // Silently returning cache here made manual refresh clicks look like
                // they did nothing — always say why, especially when the user just
                // clicked 🔄 expecting a visible result.
                BdApi.UI.showToast(`⏳ GitHub rate-limited — réessaie dans ${Math.ceil(rateLimitMs / 1000)}s (affichage du cache).`, { type: "warning", timeout: 3000 });
                return cache.entries;
            }
            throw new Error(`GitHub rate-limited — réessaie dans ${Math.ceil(rateLimitMs / 1000)}s.`);
        }

        try {
            const entries = await this._scanRepo();
            BdApi.Data.save("PluginShop", "manifestCache", { fetchedAt: now, entries });
            return entries;
        } catch (err) {
            console.error("[PluginShop] manifest fetch failed:", err);
            if (cache) {
                BdApi.UI.showToast("⚠️ Rafraîchissement impossible, affichage du cache.", { type: "warning", timeout: 3000 });
                return cache.entries;
            }
            throw err;
        }
    }

    async _scanRepo() {
        const rootUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/`;
        const rootItems = await this._ghJson(rootUrl);

        const candidates = [];
        for (const item of rootItems) {
            if (this._rateLimitRemainingMs() > 0) break; // stop fanning out once we're limited

            if (item.type === "file" && item.name.endsWith(".plugin.js")) {
                candidates.push(item);
            } else if (item.type === "dir") {
                try {
                    const dirItems = await this._ghJson(item.url);
                    const pluginFile = dirItems.find(f => f.type === "file" && f.name.endsWith(".plugin.js"));
                    if (pluginFile) candidates.push(pluginFile);
                } catch (e) {
                    console.warn("[PluginShop] failed to list dir", item.path, e);
                    if (this._rateLimitRemainingMs() > 0) break;
                }
            }
        }

        const entries = [];
        for (const file of candidates) {
            if (this._rateLimitRemainingMs() > 0) break; // same here — don't burn through every remaining file

            try {
                // Read content via the api.github.com Contents API (base64 body) instead
                // of raw.githubusercontent.com — keeps everything on the one domain that
                // actually accepts our auth token, avoiding that CDN's separate,
                // unauthenticated-only rate limit entirely once a token is set.
                const text = await this._readFileText(file);
                if (text == null) continue;
                const meta = this._parseMeta(text);
                if (!meta.name) continue;
                entries.push({
                    name        : meta.name,
                    version     : meta.version ?? "0.0.0",
                    description : meta.description ?? "",
                    author      : meta.author ?? "",
                    filename    : file.name,
                    apiUrl      : file.url,          // https://api.github.com/.../contents/<path> — used for install/update
                    downloadUrl : file.download_url, // raw.githubusercontent.com — fallback only
                    sha         : file.sha,          // git blob hash — used for update detection
                });
            } catch (e) {
                console.warn("[PluginShop] failed to read", file.name, e);
            }
        }

        return entries.filter(e => e.name !== "PluginShop");
    }

    // Fetches a file's content as text via the Contents API (base64-encoded body),
    // falling back to the raw CDN URL if GitHub omits inline content (files > 1MB).
    async _readFileText(file) {
        const bytes = await this._readFileBytes(file);
        return bytes == null ? null : new TextDecoder("utf-8").decode(bytes);
    }

    // Same, but returns raw bytes — used for installing so the write is byte-exact
    // (no decode/re-encode round trip through a JS string).
    async _readFileBytes(file) {
        try {
            const json = await this._ghJson(file.url);
            if (json?.encoding === "base64" && typeof json.content === "string") {
                return this._decodeBase64ToBytes(json.content);
            }
        } catch (e) {
            console.warn("[PluginShop] Contents API read failed, falling back to raw URL:", file.name, e);
        }
        // Fallback: file too large for inline content, or the API call failed.
        const res = await this._fetchWithRateLimitCheck(file.download_url);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
    }

    _decodeBase64ToBytes(base64) {
        const binary = atob(base64.replace(/\n/g, ""));
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    async _ghJson(url) {
        const res = await this._fetchWithRateLimitCheck(url, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
        return res.json();
    }

    // Plain fetch, but without forcing cache-bypass (repeated no-store requests
    // to the same GitHub URL is what was tripping their abuse detection), and
    // with a clear error if we do get rate-limited instead of a generic failure.
    // Also records a cooldown so callers can stop firing MORE requests instead
    // of finding out one at a time (see _rateLimitRemainingMs).
    //
    // GitHub signals two different things with two different codes: 429 is the
    // secondary (burst/abuse) limit, while the standard hourly quota being
    // exhausted comes back as 403 with X-RateLimit-Remaining: 0 — NOT 429. Both
    // need to trip the same breaker, or the un-handled one just keeps retrying.
    async _fetchWithRateLimitCheck(url, options = {}) {
        const headers = { ...(options.headers || {}) };

        // Only api.github.com needs (or benefits from) the token — it's where the
        // 60/hour limit lives. raw.githubusercontent.com is a CDN with its own,
        // much looser limit and doesn't need auth for public files; adding an
        // Authorization header there forces a CORS preflight that it fails,
        // breaking every content download outright.
        const token = BdApi.Data.load("PluginShop", "githubToken");
        if (token && url.startsWith("https://api.github.com/")) {
            headers.Authorization = `Bearer ${token}`;
        }

        const res = await fetch(url, { ...options, headers });
        const isPrimaryLimit = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
        if (res.status === 429 || isPrimaryLimit) {
            const retryAfter = res.headers.get("retry-after");
            const resetHeader = res.headers.get("x-ratelimit-reset");
            let waitMs = 60 * 1000; // conservative default when no header is present
            if (retryAfter) waitMs = Number(retryAfter) * 1000;
            else if (resetHeader) {
                const resetMs = Number(resetHeader) * 1000 - Date.now();
                if (resetMs > 0) waitMs = resetMs;
            }
            BdApi.Data.save("PluginShop", "rateLimitedUntil", Date.now() + waitMs);
            throw new Error(`GitHub a limité les requêtes (${res.status}) — réessaie dans ${Math.ceil(waitMs / 1000)}s.`);
        }
        return res;
    }

    // Remaining cooldown in ms, or 0 if clear. Checked BEFORE making a request
    // (not just after one fails) so a single 429/403 stops an in-progress scan
    // immediately instead of still firing off a request per remaining file.
    _rateLimitRemainingMs() {
        const until = BdApi.Data.load("PluginShop", "rateLimitedUntil");
        if (!until) return 0;
        const remaining = until - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    _parseMeta(source) {
        const block = source.match(/\/\*\*([\s\S]*?)\*\//);
        const meta  = {};
        if (!block) return meta;
        for (const line of block[1].split("\n")) {
            const m = line.match(/^\s*\*?\s*@(\w+)\s+(.+)$/);
            if (m) meta[m[1]] = m[2].trim();
        }
        return meta;
    }

    // ─────────────────────────────────────────────────────────────
    //  Local install state (read straight off disk — no dependency
    //  on BD's internal addon-object shape)
    // ─────────────────────────────────────────────────────────────

    _getLocalMeta(filename) {
        try {
            const fs   = require("fs");
            const path = require("path");
            const filePath = path.join(BdApi.Plugins.folder, filename);
            if (!fs.existsSync(filePath)) return null;
            return this._parseMeta(fs.readFileSync(filePath, "utf8"));
        } catch (e) {
            return null;
        }
    }

    // Reproduces git's blob hash (sha1("blob " + byteLength + "\0" + content)) so we
    // can compare the installed file directly against the "sha" GitHub's Contents API
    // reports for that file — catches ANY content change, not just a bumped @version.
    // Uses TextEncoder/Uint8Array instead of the global Buffer (BD logs a deprecation
    // warning on every Buffer.from/Buffer.concat call and may drop it later).
    _getLocalHash(filename) {
        try {
            const fs     = require("fs");
            const path   = require("path");
            const crypto = require("crypto");
            const filePath = path.join(BdApi.Plugins.folder, filename);
            // require("fs") inside a BD plugin is BD's own shim (M.filesystem), not real
            // Node fs — readFileSync returns a decoded STRING, not a Buffer. Re-encoding
            // it ourselves gets the real UTF-8 byte length git actually hashed; using
            // content.length directly would count JS string units (UTF-16 code units),
            // which is wrong for any file with multi-byte characters (accents, emoji).
            const text         = fs.readFileSync(filePath, "utf8");
            const contentBytes = new TextEncoder().encode(text);
            const headerBytes  = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
            const combined     = new Uint8Array(headerBytes.length + contentBytes.length);
            combined.set(headerBytes, 0);
            combined.set(contentBytes, headerBytes.length);
            return crypto.createHash("sha1").update(combined).digest("hex");
        } catch (e) {
            return null;
        }
    }

    _getStatus(entry) {
        const localMeta = this._getLocalMeta(entry.filename);
        if (!localMeta) return { installed: false, enabled: false, localVersion: null, updateAvailable: false };

        let enabled = false;
        try { enabled = BdApi.Plugins.isEnabled(entry.filename); } catch (e) { /* ignore */ }

        const localHash = this._getLocalHash(entry.filename);
        const updateAvailable = !!entry.sha && localHash !== entry.sha;
        console.log(`[PluginShop] hash check ${entry.filename}: local=${localHash} remote=${entry.sha} match=${!updateAvailable}`);

        return {
            installed    : true,
            enabled      : !!enabled,
            localVersion : localMeta.version ?? "0.0.0",
            updateAvailable,
        };
    }

    // ─────────────────────────────────────────────────────────────
    //  Actions: install / update / enable / disable
    // ─────────────────────────────────────────────────────────────

    async _installOrUpdate(entry) {
        const rateLimitMs = this._rateLimitRemainingMs();
        if (rateLimitMs > 0) {
            BdApi.UI.showToast(`⏳ GitHub rate-limited — réessaie dans ${Math.ceil(rateLimitMs / 1000)}s.`, { type: "warning", timeout: 3500 });
            return;
        }
        try {
            const bytes = await this._readFileBytes({ url: entry.apiUrl, download_url: entry.downloadUrl, name: entry.filename });
            if (bytes == null) throw new Error("empty response");

            const fs   = require("fs");
            const path = require("path");
            const dest = path.join(BdApi.Plugins.folder, entry.filename);
            const wasInstalled = fs.existsSync(dest);

            // BD's fs shim (require("fs") inside a plugin isn't real Node fs — see
            // _getLocalHash) reads/writes strings, not raw bytes. Decode back to text
            // and write with an explicit "utf8" encoding to match what it expects.
            const text = new TextDecoder("utf-8").decode(bytes);
            fs.writeFileSync(dest, text, "utf8");

            const newLocalHash = this._getLocalHash(entry.filename);
            console.log(`[PluginShop] post-write hash check for ${entry.filename}: local=${newLocalHash} remote=${entry.sha} match=${newLocalHash === entry.sha}`);

            await this._wait(400); // let BD's file watcher pick up the change

            if (wasInstalled) {
                try { BdApi.Plugins.reload(entry.filename); } catch (e) { /* watcher probably already handled it */ }
                BdApi.UI.showToast(`🔄 ${entry.name} mis à jour → v${entry.version}`, { type: "success", timeout: 2500 });
            } else {
                try { BdApi.Plugins.enable(entry.filename); } catch (e) { /* user can enable manually */ }
                BdApi.UI.showToast(`⬇️ ${entry.name} installé (v${entry.version})`, { type: "success", timeout: 2500 });
            }
        } catch (err) {
            console.error("[PluginShop] install failed:", err);
            const detail = /rate-limit/i.test(err.message) ? err.message : `Échec de l'installation de ${entry.name}`;
            BdApi.UI.showToast(`❌ ${detail}`, { type: "error", timeout: 4000 });
        } finally {
            await this._refreshShop(true);
        }
    }

    _toggleEnabled(entry, status) {
        try {
            if (status.enabled) BdApi.Plugins.disable(entry.filename);
            else BdApi.Plugins.enable(entry.filename);
        } catch (err) {
            console.error("[PluginShop] toggle failed:", err);
            BdApi.UI.showToast("❌ Échec de l'activation/désactivation.", { type: "error", timeout: 2500 });
        }
        this._refreshShop();
    }

    _wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // ─────────────────────────────────────────────────────────────
    //  Panel – render + events
    // ─────────────────────────────────────────────────────────────

    async _refreshShop(force = false) {
        if (!this._panelEl) return;
        this._loading = true;
        this._error   = null;
        this._renderPanelBody();

        try {
            this._entries = await this._fetchManifest(force);
        } catch (err) {
            this._error   = err.message || "Erreur réseau";
            this._entries = [];
        }

        this._loading = false;
        this._renderPanelBody();
    }

    _renderPanelBody() {
        if (!this._panelEl) return;
        const body = this._panelEl.querySelector(".pls-body");
        if (body) body.innerHTML = this._loading ? this._buildLoadingHTML() : this._buildListHTML();
    }

    _buildPanelHTML() {
        return `
        <div class="pls-header">
            <span class="pls-title">🛒 My Plugin Shop</span>
            <span class="pls-header-spacer"></span>
            <button class="pls-icon-btn" data-action="refresh" title="Rafraîchir">🔄</button>
            <button class="pls-icon-btn" data-action="close" title="Fermer">✕</button>
        </div>
        <div class="pls-body">${this._buildLoadingHTML()}</div>`;
    }

    _buildLoadingHTML() {
        return `<div class="pls-empty">Chargement…</div>`;
    }

    _buildListHTML() {
        if (this._error && !this._entries.length) {
            return `<div class="pls-empty">❌ ${this._esc(this._error)}</div>`;
        }
        if (!this._entries.length) {
            return `<div class="pls-empty">Aucun plugin trouvé dans ${this._esc(REPO_OWNER)}/${this._esc(REPO_NAME)}.</div>`;
        }
        return `<div class="pls-list">${this._entries.map(e => this._buildEntryHTML(e)).join("")}</div>`;
    }

    _buildEntryHTML(entry) {
        const status = this._getStatus(entry);

        let badge, actionBtn;
        if (!status.installed) {
            badge     = `<span class="pls-badge pls-badge--new">Non installé</span>`;
            actionBtn = `<button class="pls-btn-primary" data-action="install" data-name="${this._esc(entry.name)}">⬇️ Installer</button>`;
        } else if (status.updateAvailable) {
            badge     = `<span class="pls-badge pls-badge--update">v${this._esc(status.localVersion)} → v${this._esc(entry.version)}</span>`;
            actionBtn = `<button class="pls-btn-primary" data-action="update" data-name="${this._esc(entry.name)}">🔄 Mettre à jour</button>`;
        } else {
            badge     = `<span class="pls-badge pls-badge--ok">v${this._esc(status.localVersion)}</span>`;
            actionBtn = "";
        }

        const toggleBtn = status.installed
            ? `<button class="pls-btn-sm ${status.enabled ? "pls-danger" : ""}" data-action="toggle" data-name="${this._esc(entry.name)}">${status.enabled ? "Désactiver" : "Activer"}</button>`
            : "";

        return `
        <div class="pls-card">
            <div class="pls-card-main">
                <div class="pls-card-title">${this._esc(entry.name)} ${badge}</div>
                <div class="pls-card-desc">${this._esc(entry.description)}</div>
            </div>
            <div class="pls-card-actions">
                ${actionBtn}
                ${toggleBtn}
            </div>
        </div>`;
    }

    _bindPanelEvents() {
        if (!this._panelEl) return;
        this._panelEl.addEventListener("click", e => {
            const el = e.target.closest("[data-action]");
            if (!el) return;
            const { action, name } = el.dataset;

            switch (action) {
                case "close":
                    this._toggleShopPanel();
                    break;
                case "refresh":
                    this._refreshShop(true);
                    break;
                case "install":
                case "update": {
                    const entry = this._entries.find(x => x.name === name);
                    if (entry) this._installOrUpdate(entry);
                    break;
                }
                case "toggle": {
                    const entry = this._entries.find(x => x.name === name);
                    if (entry) this._toggleEnabled(entry, this._getStatus(entry));
                    break;
                }
            }
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────

    _esc(str) {
        return String(str ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ─────────────────────────────────────────────────────────────
    //  CSS — uses Discord's own theme variables so it matches
    //  light/dark mode inside the real Settings window.
    // ─────────────────────────────────────────────────────────────

    _injectCSS() {
        BdApi.DOM.addStyle("PluginShop", `

        .pls-shop-btn {
            display        : inline-flex;
            align-items    : center;
            justify-content: center;
            width          : 32px;
            height         : 32px;
            margin-left    : 8px;
            border-radius  : 4px;
            border         : none;
            background     : var(--background-modifier-accent);
            font-size      : 16px;
            cursor         : pointer;
            transition     : background .12s;
        }
        .pls-shop-btn:hover { background: var(--background-modifier-hover); }

        .pls-panel {
            display        : flex;
            flex-direction : column;
            border         : 1px solid var(--background-modifier-accent);
            border-radius  : 8px;
            background     : var(--background-secondary);
            margin-bottom  : 16px;
            overflow       : hidden;
        }

        .pls-header {
            display        : flex;
            align-items    : center;
            gap            : 8px;
            padding        : 10px 12px;
            background     : var(--background-secondary-alt);
            border-bottom  : 1px solid var(--background-modifier-accent);
        }
        .pls-title { font-weight: 600; color: var(--header-primary); }
        .pls-header-spacer { flex: 1; }

        .pls-icon-btn {
            background    : none;
            border        : none;
            cursor        : pointer;
            font-size     : 14px;
            padding       : 4px 6px;
            border-radius : 4px;
            color         : var(--text-muted);
            transition    : background .12s, color .12s;
        }
        .pls-icon-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }

        .pls-body { max-height: 360px; overflow-y: auto; padding: 10px; }

        .pls-list { display: flex; flex-direction: column; gap: 8px; }

        .pls-card {
            display        : flex;
            align-items    : center;
            justify-content: space-between;
            gap            : 12px;
            padding        : 10px 12px;
            border         : 1px solid var(--background-modifier-accent);
            border-radius  : 6px;
            background     : var(--background-primary);
        }
        .pls-card-main { min-width: 0; }
        .pls-card-title {
            font-weight : 600;
            color       : var(--header-primary);
            display     : flex;
            align-items : center;
            gap         : 8px;
            flex-wrap   : wrap;
        }
        .pls-card-desc {
            margin-top  : 3px;
            color       : var(--text-muted);
            font-size   : 12px;
            line-height : 1.5;
        }

        .pls-card-actions {
            display        : flex;
            flex-direction : column;
            gap            : 6px;
            flex-shrink    : 0;
        }

        .pls-badge {
            font-size     : 10px;
            font-weight   : 600;
            padding       : 2px 6px;
            border-radius : 4px;
        }
        .pls-badge--new    { background: var(--background-modifier-accent); color: var(--text-muted); }
        .pls-badge--update { background: rgba(250, 166, 26, .18); color: var(--text-warning, #faa61a); }
        .pls-badge--ok     { background: rgba(59, 165, 93, .18);  color: var(--text-positive); }

        .pls-btn-primary {
            background    : var(--brand-experiment);
            color         : #fff;
            border        : none;
            padding       : 6px 10px;
            border-radius : 4px;
            cursor        : pointer;
            font-size     : 12px;
            font-weight   : 600;
            white-space   : nowrap;
        }
        .pls-btn-primary:hover { filter: brightness(1.1); }

        .pls-btn-sm {
            background    : var(--background-modifier-accent);
            color         : var(--text-normal);
            border        : none;
            padding       : 5px 10px;
            border-radius : 4px;
            cursor        : pointer;
            font-size     : 11px;
        }
        .pls-btn-sm:hover { background: var(--background-modifier-hover); }
        .pls-danger { color: var(--text-danger) !important; }

        .pls-empty {
            text-align  : center;
            color       : var(--text-muted);
            padding     : 32px 12px;
        }

        .pls-settings { padding: 4px 2px; }
        .pls-settings-label {
            font-weight : 600;
            color       : var(--header-primary);
            margin-bottom: 6px;
        }
        .pls-settings-hint {
            font-size   : 12px;
            color       : var(--text-muted);
            line-height : 1.6;
            margin-bottom: 10px;
        }
        .pls-settings-hint a { color: var(--text-link); }
        .pls-settings-input {
            width         : 100%;
            box-sizing    : border-box;
            background    : var(--background-primary);
            color         : var(--text-normal);
            border        : 1px solid var(--background-modifier-accent);
            border-radius : 4px;
            padding       : 8px 10px;
            font-size     : 13px;
            font-family   : monospace;
            margin-bottom : 10px;
        }
        .pls-settings-actions { display: flex; gap: 8px; }

        `);
    }
};
