/**
 * @name MicBridge
 * @author klem___s
 * @authorId 321332083731726338
 * @description Bridges Discord's real self-mute/self-deafen state with an
 *   external controller (e.g. a Stream Deck server) over a local WebSocket.
 *   Pushes live state changes out, and accepts mute/deafen commands in.
 * @version 1.1.0
 * @website https://github.com/klem-s
 * @source https://github.com/klem-s
 */

module.exports = class MicBridge {

    constructor() {
        this._ws             = null;
        this._reconnectTimer = null;
        this._handleStoreChange = this._handleStoreChange.bind(this);
    }

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    start() {
        this.MediaEngineStore = this._getStore("MediaEngineStore", "isSelfMute");

        if (!this.MediaEngineStore) {
            console.warn("[MicBridge] MediaEngineStore not found – plugin disabled");
            BdApi.UI.showToast("MicBridge: MediaEngineStore not found ❌", { type: "error", timeout: 3000 });
            return;
        }

        this.MediaEngineStore.addChangeListener(this._handleStoreChange);
        this._connect();

        BdApi.UI.showToast("MicBridge enabled 🎙️", { type: "success", timeout: 2500 });
    }

    stop() {
        this.MediaEngineStore?.removeChangeListener(this._handleStoreChange);

        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;

        if (this._ws) {
            this._ws.onopen = this._ws.onclose = this._ws.onerror = this._ws.onmessage = null;
            this._ws.close();
            this._ws = null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Discord internals lookup
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

    // Looked up on demand (lazy chunk may not be loaded yet at start()).
    _getMediaEngineActions() {
        if (typeof this._actions?.toggleSelfMute === "function") return this._actions;

        this._actions =
            BdApi.Webpack.getModule(
                m => typeof m?.toggleSelfMute === "function" && typeof m?.toggleSelfDeaf === "function",
                { searchExports: true }
            ) ??
            BdApi.Webpack.getModule(
                m => typeof m?.toggleSelfMute === "function",
                { searchExports: true }
            );

        return this._actions;
    }

    _isMuted() {
        return !!this.MediaEngineStore?.isSelfMute?.();
    }

    _isDeafened() {
        return !!this.MediaEngineStore?.isSelfDeaf?.();
    }

    // ─────────────────────────────────────────────────────────────
    //  Commands coming from the server:
    //  {"cmd": "toggle"|"mute"|"unmute"|"toggle_deafen"|"deafen"|"undeafen"}
    // ─────────────────────────────────────────────────────────────

    _applyCommand(cmd) {
        const actions = this._getMediaEngineActions();
        if (typeof actions?.toggleSelfMute !== "function") {
            console.warn("[MicBridge] toggleSelfMute module not found");
            return;
        }

        const muted    = this._isMuted();
        const deafened = this._isDeafened();

        if (cmd === "toggle") {
            actions.toggleSelfMute();
        } else if (cmd === "mute" && !muted) {
            actions.toggleSelfMute();
        } else if (cmd === "unmute" && muted) {
            actions.toggleSelfMute();
        } else if (cmd === "toggle_deafen") {
            if (typeof actions.toggleSelfDeaf !== "function") {
                console.warn("[MicBridge] toggleSelfDeaf module not found");
                return;
            }
            actions.toggleSelfDeaf();
        } else if (cmd === "deafen" && !deafened) {
            actions.toggleSelfDeaf?.();
        } else if (cmd === "undeafen" && deafened) {
            actions.toggleSelfDeaf?.();
        }
        // Resulting state is reported back via the MediaEngineStore change listener.
    }

    // ─────────────────────────────────────────────────────────────
    //  WebSocket bridge to the local server
    //  Outgoing: {"type": "state", "muted": bool, "deafened": bool}
    // ─────────────────────────────────────────────────────────────

    _connect() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;

        try {
            this._ws = new WebSocket("ws://127.0.0.1:8765");
        } catch (e) {
            console.error("[MicBridge] WebSocket construction failed:", e);
            this._scheduleReconnect();
            return;
        }

        this._ws.onopen = () => {
            this._send({ type: "state", muted: this._isMuted(), deafened: this._isDeafened() });
        };

        this._ws.onmessage = (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (data?.cmd) this._applyCommand(data.cmd);
        };

        this._ws.onclose = () => this._scheduleReconnect();
        this._ws.onerror = () => this._ws?.close();
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => this._connect(), 3000);
    }

    _send(payload) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(payload));
        }
    }

    _handleStoreChange() {
        this._send({ type: "state", muted: this._isMuted(), deafened: this._isDeafened() });
    }
};
