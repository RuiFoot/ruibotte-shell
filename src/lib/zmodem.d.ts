// zmodem.js 0.1.10 (Apache-2.0) — 이 앱이 쓰는 만큼만 적은 타입
declare module "zmodem.js" {
	type Octets = number[] | Uint8Array;

	export type FileDetails = {
		name: string;
		size?: number;
		/** get_details() 는 Date, send_offer() 에는 초(숫자)도 된다 */
		mtime?: Date | number | null;
		mode?: number | null;
		files_remaining?: number;
		bytes_remaining?: number;
	};

	export interface Offer {
		get_details(): FileDetails;
		get_offset(): number;
		accept(opts?: { offset?: number; on_input?: "spool_array" | ((payload: number[]) => void) }): Promise<unknown>;
		skip(): void;
	}

	export interface Transfer {
		get_details(): FileDetails;
		get_offset(): number;
		send(bytes: Octets): Promise<void>;
		end(bytes?: Octets): Promise<void>;
	}

	export interface Session {
		type: "receive" | "send";
		on(evt: "offer", fn: (o: Offer) => void): this;
		on(evt: "session_end", fn: () => void): this;
		on(evt: string, fn: (...a: unknown[]) => void): this;
		start(): void;
		abort(): void;
		close(): Promise<void>;
		has_ended(): boolean;
		aborted(): boolean;
		send_offer(params: FileDetails): Promise<Transfer | undefined>;
	}

	export interface Detection {
		confirm(): Session;
		deny(): void;
		is_valid(): boolean;
		get_session_role(): "receive" | "send";
	}

	class Sentry {
		constructor(o: { to_terminal: (octets: number[]) => void; sender: (octets: number[]) => void; on_detect: (d: Detection) => void; on_retract: () => void });
		consume(input: Octets | ArrayBuffer): void;
		get_confirmed_session(): Session | null;
	}
	const Zmodem: { Sentry: typeof Sentry };
	export default Zmodem;
	export type { Sentry };
}
