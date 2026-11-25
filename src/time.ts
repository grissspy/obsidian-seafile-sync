import { moment } from "obsidian";

type Moment = (ms?: number) => { format(f: string): string };

/** Date/time in Obsidian's language. */
export function fmt(format: string, ms?: number): string {
	return (moment as unknown as Moment)(ms).format(format);
}
