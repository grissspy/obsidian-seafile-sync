// Shared interfaces. The sync engine only depends on these, so it can be
// tested in Node with in-memory fakes (see test/).

export interface LocalEntry {
	path: string; // vault-relative, "/"-separated, no leading slash
	size: number;
	mtime: number; // ms
}

export interface RemoteEntry {
	path: string; // relative to the remote base folder, no leading slash
	size: number;
	mtime: number; // ms
	id: string; // Seafile object id; changes whenever content changes
}

export interface LocalFS {
	/** All files and folders (already including/excluding config dir as configured). */
	list(): Promise<{ files: LocalEntry[]; dirs: string[] }>;
	stat(path: string): Promise<LocalEntry | null>;
	read(path: string): Promise<ArrayBuffer>;
	/** Create or overwrite; parent folders are created as needed. */
	write(path: string, data: ArrayBuffer): Promise<void>;
	/** Remove a file (to trash where possible). */
	delete(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Remove an empty folder; must not remove a non-empty one. */
	rmdirIfEmpty(path: string): Promise<boolean>;
}

export interface RemoteFS {
	/** Cheap "has anything changed in the library" token, if supported. */
	changeToken(): Promise<string | null>;
	list(): Promise<{ files: RemoteEntry[]; dirs: string[] }>;
	download(path: string): Promise<ArrayBuffer>;
	/** Upload/overwrite; returns the new object id. Parent folders are created. */
	upload(path: string, data: ArrayBuffer): Promise<string>;
	deleteFile(path: string): Promise<void>;
	deleteDir(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/** Content-addressed storage of "last synced" versions of text files (for 3-way merge). */
export interface BaseStore {
	get(hash: string): Promise<string | null>;
	put(hash: string, text: string): Promise<void>;
	/** Remove everything not in `keep`. */
	gc(keep: Set<string>): Promise<void>;
}

export interface FileState {
	lh: string; // local content hash at last sync
	lm: number; // local mtime at last sync
	ls: number; // local size at last sync
	rid: string; // remote object id at last sync
}

export interface SyncState {
	version: 1;
	target: string; // server|repo|base this state belongs to
	changeToken: string | null;
	files: Record<string, FileState>;
	dirs: string[];
	lastSync: number;
}

export type ConflictStrategy = "merge" | "keep-both" | "local" | "remote" | "newer";

export interface SyncOptions {
	conflict: ConflictStrategy;
	deviceName: string;
	mergeExtensions: string[]; // e.g. ["md","txt"]
	maxFileSize: number; // bytes, 0 = unlimited
	concurrency: number;
	syncEmptyDirs: boolean;
	/** Ask before doing more than this many deletions in one run (0 = never ask). */
	deleteThreshold: number;
	isIgnored(path: string): boolean;
	confirmDeletes(local: string[], remote: string[]): Promise<"delete" | "restore" | "skip">;
	onProgress?(done: number, total: number, label: string): void;
	log(msg: string): void;
	saveState(state: SyncState): Promise<void>;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	merged: number;
	conflicts: number;
	errors: string[];
	skipped: boolean; // nothing to do / short-circuited
	aborted?: string;
}
