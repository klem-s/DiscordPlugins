# ReportCopier

A [BetterDiscord](https://betterdiscord.app) plugin for fixing accidental duplicate forum
reports. Give it the link of the duplicate (source) post and the link of the post you want to
keep (destination) — it copies the text, the jump link back to the source, and the reporter's
`@mention` into the destination, and **re-uploads every image as a real attachment** (it never
just pastes a CDN link).

## Usage

1. Click the floating 📤 button (bottom-right).
2. Paste the **source** link — the duplicate post you want to get rid of. You can paste either
   a message link or a plain thread/channel link (forum-post starter messages share their
   thread's ID, so either works).
3. Paste the **destination** link — the post you're keeping.
4. Optionally check "Supprimer le post source (doublon) après la copie" to delete the duplicate
   thread automatically once the copy succeeds. If your source link points at a specific reply
   (not the thread's starter message), only that message is deleted instead of the whole thread.
5. Click **Copier**.

## How it works

- Uses your own Discord token (same technique as this repo's `BulkMove` plugin) to read the
  source message via the REST API and post a new message in the destination channel.
- Every image attachment or embedded image on the source message is downloaded and re-uploaded
  as a fresh multipart attachment — so it shows up as a genuine file in the destination, not an
  embedded link.
- Appends the source's jump link and the original author's `@mention` to the copied text so you
  can always trace it back.

## Installation

1. Download `ReportCopier.plugin.js`
2. Place it in your BetterDiscord plugins folder:
   - **Mac/Linux:** `~/.config/BetterDiscord/plugins/`
   - **Windows:** `%AppData%\BetterDiscord\plugins\`
3. Enable the plugin in BetterDiscord Settings → Plugins

## Note

This plugin sends messages and deletes channels via the Discord REST API using your own account
token rather than driving the UI directly, the same approach `BulkMove` in this repo uses for
moving voice members. Use it on servers you moderate — automating actions with a user token is
against Discord's Terms of Service if abused, so keep usage to your own reports workflow.
