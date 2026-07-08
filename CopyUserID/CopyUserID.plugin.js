/**
 * @name CopyUserID
 * @author klem___s
 * @authorId 321332083731726338
 * @description Cmd+Click (Mac) or Ctrl+Click (Windows) on a message to copy the sender's ID.
 * @version 1.1.0
 * @website https://github.com/klem-s
 * @source https://github.com
 */

module.exports = class CopyUserID {
    constructor() {
        this.handleClick = this.handleClick.bind(this);
    }

    start() {
        document.addEventListener("click", this.handleClick);
        BdApi.UI.showToast("CopyUserID enabled ✅", { type: "info", timeout: 2500 });
    }

    stop() {
        document.removeEventListener("click", this.handleClick);
    }

    handleClick(e) {
        if (!e.metaKey && !e.ctrlKey) return;

        const target = e.target;

        // Walk up to the message container (which carries data-author-id)
        const message = target.closest("[data-author-id]");

        let userId = message?.dataset?.authorId;

        // Fallback: React fibers
        if (!userId) {
            let el = target;
            for (let i = 0; i < 15 && el; i++) {
                userId = this.getUserIdFromReact(el);
                if (userId) break;
                el = el.parentElement;
            }
        }

        if (!userId || !/^\d{17,19}$/.test(userId)) return;

        e.preventDefault();
        e.stopPropagation();

        DiscordNative.clipboard.copy(userId);
        BdApi.UI.showToast(`ID copied: ${userId} 📋`, { type: "success", timeout: 2500 });
    }

    getUserIdFromReact(element) {
        if (!element) return null;

        const reactKey = Object.keys(element).find(
            k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
        );
        if (!reactKey) return null;

        let fiber = element[reactKey];
        for (let depth = 0; fiber && depth < 30; depth++) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props) {
                const userId =
                    props.userId ||
                    props.user?.id ||
                    props.author?.id ||
                    props.message?.author?.id ||
                    props.member?.userId;

                if (userId && /^\d{17,19}$/.test(String(userId))) {
                    return String(userId);
                }
            }
            fiber = fiber.return;
        }

        return null;
    }
};
