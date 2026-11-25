# Seafile Vault Sync

[Русский](README.ru.md)

Two-way sync of an Obsidian vault with a [Seafile](https://www.seafile.com) library. Works on Windows, macOS, Linux, Android and iOS. It talks to the Seafile Web API directly, so you don't need the Seafile desktop client.

## How it syncs

The plugin keeps a snapshot of the last successful sync. For every file it compares three versions: the one on this device, the one on the server, and the one from the last sync.

| This device | Server | Result |
|---|---|---|
| changed | unchanged | upload |
| unchanged | changed | download |
| changed | changed | **merge** for notes (`.md`, `.txt`): edits in different places are combined. If edits overlap, both versions are kept as `Note (conflict Phone 2026-11-25 140312).md` |
| deleted | unchanged | deleted on the server (it goes to the Seafile library trash) |
| unchanged | deleted | deleted locally (moved to trash) |
| deleted | changed | the edit wins and the file is restored |

Other details:

- Changes are detected by SHA-256 of the content. A file whose timestamp changed but content didn't is not uploaded again.
- When nothing has changed, a sync costs a **single** request.
- Mass-deletion guard: if one sync would delete more than N files, the plugin asks whether to delete, restore or postpone.
- Before overwriting a file, the plugin checks that you haven't edited it while the sync was running.
- Open notes refresh in the editor.
- Empty folders are synced. A rename syncs as a delete plus a new file.
- Encrypted libraries and two-factor auth are supported. You can sync a sub-folder of a library instead of the whole library.
- Per-device choice of what to sync: images, audio, video, PDF, other files, and parts of the settings folder (core settings, appearance, hotkeys, community plugins, plugin settings). Switching something off never deletes it anywhere. The plugin never syncs its own login token or sync state.
- Automatic sync can be paused (setting or command), and on Android limited to Wi-Fi.
- Safe with simultaneous editing: before overwriting anything, the plugin re-checks the server (and your open editor) and turns a late change into a merge instead of overwriting it.

A sync runs on startup, every N minutes, when the server reports a change, N seconds after your last edit, and when the app returns to the foreground (on mobile). You can also run one manually from the ribbon icon, the status bar, or the **Sync now** command.

## Tools

- **Version history**: right-click a file → *Seafile: version history*. Compare any server version with the current one and restore it (the current version stays in the history, so this is undoable).
- **Restore deleted files** from the Seafile trash: pick files in a list and they come back on the next sync.
- **Conflict helper**: for a note with a `(conflict …)` copy, choose block by block what to keep (main file, copy, or both). The copy then goes to the trash.
- **Status in the file explorer**: an orange dot marks files not synced yet, ⚠️ marks conflict copies.
- **Share link**: right-click → *Seafile: copy share link* creates (or reuses) a view-only Seafile link.
- **Only some folders on a device**: e.g. leave big attachment folders off your phone. Nothing is deleted anywhere.
- **More libraries**: sync a vault folder with another library or folder, e.g. a shared team library.
- **Device settings**: every device has its own settings; save them to the server and copy them to a new device in one click.
- **Progress** of big syncs in the status bar, or in a notice on phones.

### Is it real-time?

Almost. The plugin asks the server "has anything changed?" every 30 seconds while Obsidian is open (one tiny request; on phones only while the app is in the foreground). An edit on one device usually appears on the others within 10–40 seconds. Seafile has no live co-editing, so you won't see someone else typing; simultaneous edits are merged instead.

## Compatibility

- **Seafile Server 7.0 or newer** (Community or Pro). Tested on **Seafile 11.0.13 CE**. The plugin checks the server version on first sync and warns if it is older than 7.0.
- **Obsidian 1.13.0 or newer** on Windows, macOS, Linux, Android and iOS. Tested on Obsidian 1.15 (macOS and Android 17).
- Plain and encrypted libraries, two-factor auth, a library or any folder inside it.

## Security and privacy

- Network: the plugin talks **only** to the Seafile server you enter. No telemetry and no third-party services.
- Credentials: your password is used once to get an API token and is never stored. The token and the library password are kept in **Obsidian's keychain** (SecretStorage) on each device, not in `data.json`, so they never end up in vault backups or in a synced settings folder.
- Use `https://`. The settings warn you if the server URL is plain `http://`.
- File access: to compare your vault with the server, the plugin lists and reads every file in the vault (and the settings folder, if you enable it). The file contents go only to your server.
- Paths from the server are validated, so a broken or hostile server cannot make the plugin write outside the vault.
- Deleted files go to the trash (Obsidian's or the system one), and files deleted on the server can be restored from the Seafile library trash. Overwritten versions stay in Seafile's file history.
- Syncing *Community plugins* through the settings folder means plugin code from the library runs on your devices. Enable it only if you trust everyone who can write to that library.

## Install

- **Community plugins** (once listed): Settings → Community plugins → Browse → "Seafile Vault Sync".
- **BRAT** (beta, auto-updates): install BRAT → *Add beta plugin* → `grissspy/obsidian-seafile-sync`.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/grissspy/obsidian-seafile-sync/releases) into `<vault>/.obsidian/plugins/seafile-vault-sync/`, then enable the plugin.

## Setup

1. Enter the **Server URL**, e.g. `https://cloud.example.com`.
2. Enter your username and password and click **Sign in**. Only the API token is stored, never the password.
3. Click **Load libraries** and pick a library. Optionally, enter a folder inside it.
4. Click the sync icon.

## Notes

- **Do not sync the same folder with this plugin and the Seafile desktop client at the same time.** Changes will go back and forth between them.
- If listing libraries works but file transfers fail, the server's `SERVICE_URL` / `FILE_SERVER_ROOT` is probably misconfigured. Enable *Use server URL for file transfers*.
- **Show sync log** shows what happened during recent syncs.

## Development

```bash
npm install
npm run dev     # rebuild on change
npm test        # sync engine tests against a mock Seafile server
npm run build
```

To release, run `npm version patch` followed by `git push --follow-tags`. GitHub Actions builds the plugin and publishes the release.

Layout: `src/sync.ts` (algorithm), `src/seafile.ts` (API client), `src/merge.ts` (three-way merge), `src/local.ts` (vault access), `src/main.ts` (plugin and UI).

License: MIT.

## Support

If the plugin saves you time, you can support development on [Boosty](https://boosty.to/grispy/donate) ☕
