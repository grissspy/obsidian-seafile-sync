import { getLanguage } from "obsidian";

// Runtime messages (notices, status bar, dialogs) in English and Russian.
const en = {
	notConfigured: "⚙️ Seafile: set the server, sign in and pick a library in the plugin settings first.",
	alreadyRunning: "⏳ Seafile: a sync is already running",
	upToDate: "✨ Seafile: everything is up to date",
	synced: "✅ Seafile: synced",
	uploaded: "⬆️ {n} sent",
	downloaded: "⬇️ {n} received",
	deleted: "🗑️ {n} deleted",
	merged: "🔀 {n} merged",
	conflicts: "⚠️ Seafile: {n} conflict(s). Both versions are kept: look for files named “(conflict …)”.",
	fileErrors: "❌ Seafile: {n} file(s) failed. Run “Show sync log” for details.",
	failed: "❌ Seafile sync failed: {msg}",
	authFailed: "🔑 Seafile: your session has expired or the token was revoked. Sign in again in the plugin settings.",
	offline: "📴 Seafile: the server can't be reached. Will retry later.",
	encrypted: "🔒 Seafile: this library is encrypted. Enter its password in the plugin settings.",
	paused: "⏸️ Seafile: automatic sync paused",
	resumed: "▶️ Seafile: automatic sync resumed",
	signedIn: "🔐 Seafile: signed in as {user}",
	connectionOk: "✅ Seafile: connection OK (server {version})",
	oldServer: "⚠️ Seafile: server version {version} is older than 7.0 and isn't supported. Uploads may create duplicate files.",
	insecure: "⚠️ The server uses plain http://. Your login and notes travel unencrypted. Use https:// if you can.",
	statusIdle: "Seafile",
	statusSyncing: "Syncing…",
	statusPaused: "Paused",
	statusError: "Error",
	tooltip: "Seafile sync: click to sync now",
	tooltipLast: "Last sync: {time}, {summary}",
	delTitle: "🗑️ Seafile: many files to delete",
	delIntro: "This sync would delete {n} files. If you did not expect this (wrong library or folder, the vault was moved), choose “Restore”.",
	delLocal: "Delete on this device (they were deleted on the server)",
	delRemote: "Delete on the server (they were deleted on this device)",
	delMore: "… and {n} more",
	delNotNow: "Not now",
	delRestore: "Restore (copy back)",
	delConfirm: "Delete",
	logTitle: "📜 Seafile sync log",
	logEmpty: "(empty)",
};

const ru: typeof en = {
	notConfigured: "⚙️ Seafile: сначала укажите сервер, войдите и выберите библиотеку в настройках плагина.",
	alreadyRunning: "⏳ Seafile: синхронизация уже идёт",
	upToDate: "✨ Seafile: всё актуально",
	synced: "✅ Seafile: синхронизировано",
	uploaded: "⬆️ отправлено {n}",
	downloaded: "⬇️ получено {n}",
	deleted: "🗑️ удалено {n}",
	merged: "🔀 слито {n}",
	conflicts: "⚠️ Seafile: конфликтов: {n}. Обе версии сохранены, ищите файлы «(conflict …)».",
	fileErrors: "❌ Seafile: не удалось обработать файлов: {n}. Подробности: команда «Show sync log».",
	failed: "❌ Seafile: синхронизация не удалась: {msg}",
	authFailed: "🔑 Seafile: сессия истекла или токен отозван. Войдите снова в настройках плагина.",
	offline: "📴 Seafile: сервер недоступен. Попробую позже.",
	encrypted: "🔒 Seafile: библиотека зашифрована. Укажите её пароль в настройках плагина.",
	paused: "⏸️ Seafile: автосинхронизация на паузе",
	resumed: "▶️ Seafile: автосинхронизация включена",
	signedIn: "🔐 Seafile: вы вошли как {user}",
	connectionOk: "✅ Seafile: соединение в порядке (сервер {version})",
	oldServer: "⚠️ Seafile: версия сервера {version} старше 7.0 и не поддерживается. При загрузке могут появляться дубликаты файлов.",
	insecure: "⚠️ Сервер работает по http:// без шифрования: логин и заметки передаются в открытом виде. По возможности используйте https://.",
	statusIdle: "Seafile",
	statusSyncing: "Синхронизация…",
	statusPaused: "Пауза",
	statusError: "Ошибка",
	tooltip: "Синхронизация Seafile: нажмите, чтобы запустить",
	tooltipLast: "Последняя синхронизация: {time}, {summary}",
	delTitle: "🗑️ Seafile: удаление многих файлов",
	delIntro: "Эта синхронизация удалит файлов: {n}. Если вы этого не ожидали (не та библиотека или папка, хранилище перенесли), выберите «Восстановить».",
	delLocal: "Удалить на этом устройстве (удалены на сервере)",
	delRemote: "Удалить на сервере (удалены на этом устройстве)",
	delMore: "… и ещё {n}",
	delNotNow: "Не сейчас",
	delRestore: "Восстановить",
	delConfirm: "Удалить",
	logTitle: "📜 Журнал синхронизации Seafile",
	logEmpty: "(пусто)",
};

export type MsgKey = keyof typeof en;

function lang(): typeof en {
	try {
		return getLanguage().toLowerCase().startsWith("ru") ? ru : en;
	} catch {
		return en;
	}
}

export function t(key: MsgKey, vars: Record<string, string | number> = {}): string {
	return lang()[key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
