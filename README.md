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
- The config folder (`.obsidian`: themes, plugins, hotkeys) can be synced too. The plugin never syncs its own login token or sync state.

A sync runs on startup, every N minutes, N seconds after your last edit, and when the app returns to the foreground (on mobile). You can also run one manually from the ribbon icon, the status bar, or the **Sync now** command.

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

### Network use and privacy

The plugin connects only to the Seafile server you configure. Your API token, and the library password if you set one, are stored in this plugin's `data.json` on each device.

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
