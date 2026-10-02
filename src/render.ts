/**
 * Headless Chromium driven over CDP: load a page at a given CSS viewport and
 * capture arbitrary vertical slices of it as PNG. Used by index.ts to show
 * HTML files as terminal images.
 *
 * One browser per omp process; `openPage()` hands out independent tabs.
 *
 * Chromium must never outlive omp. An exit hook is not enough: omp can die by a
 * signal, or exit while Chromium is still starting (test runs that exited within
 * half a second left their browsers behind). So it is started through
 * util-linux `setpriv --pdeathsig TERM`, and each launch removes profile
 * directories whose browser is gone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";

const BROWSER_CANDIDATES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave"];
const PROFILE_PREFIX = "omp-artifacts-";
/** A profile younger than this may belong to a browser that has not created its lock yet. */
const PROFILE_GRACE_MS = 60_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 20_000;

export interface Viewport {
	/** CSS px. */
	width: number;
	/** CSS px; only affects `vh` units and media queries, captures can go beyond it. */
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
}

/** A CDP result object; fields are read with {@link field}. */
type CdpResult = Record<string, unknown>;

interface CdpMessage {
	id?: number;
	method?: string;
	params?: unknown;
	sessionId?: string;
	result?: CdpResult;
	error?: { message: string; code: number };
}

interface Pending {
	resolve: (result: CdpResult) => void;
	reject: (err: Error) => void;
	timer: Timer;
}

type BrowserProcess = Subprocess<"ignore", "ignore", "pipe">;

export function findBrowser(): string | undefined {
	const forced = process.env.OMP_ARTIFACTS_BROWSER;
	if (forced) return forced;
	for (const name of BROWSER_CANDIDATES) {
		const found = Bun.which(name);
		if (found) return found;
	}
	return undefined;
}

/** Reads a string field CDP is documented to return; a missing one means the protocol changed. */
function field(result: CdpResult, key: string): string {
	const value = result[key];
	if (typeof value !== "string") throw new Error(`CDP reply lacks string "${key}"`);
	return value;
}

/** One browser tab: load a page at a viewport, capture slices of it. */
export interface RendererPage {
	/** Navigates (or reloads) `url` at `viewport`; resolves with the page height in CSS px. */
	load(url: string, viewport: Viewport): Promise<number>;
	/**
	 * PNG (base64) of the CSS-px rectangle starting at `y`, at the viewport's device
	 * scale times `scale` (below 1 for thumbnails).
	 */
	capture(y: number, width: number, height: number, scale?: number): Promise<string>;
	close(): void;
}

export class HtmlRenderer {
	#proc: BrowserProcess;
	#ws: WebSocket;
	#profileDir: string;
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#listeners = new Set<(method: string, sessionId?: string) => void>();
	#closed = false;

	private constructor(proc: BrowserProcess, ws: WebSocket, profileDir: string) {
		this.#proc = proc;
		this.#ws = ws;
		this.#profileDir = profileDir;
		ws.onmessage = ev => {
			const msg = JSON.parse(String(ev.data)) as CdpMessage;
			if (msg.id !== undefined) {
				const p = this.#pending.get(msg.id);
				if (!p) return;
				this.#pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
				else p.resolve(msg.result ?? {});
			} else if (msg.method) {
				for (const listener of this.#listeners) listener(msg.method, msg.sessionId);
			}
		};
		ws.onclose = () => {
			this.#closed = true;
			this.#failAll(new Error("browser connection closed"));
		};
	}

	/** False once closed or once Chromium dropped the connection (crash, external kill). */
	get alive(): boolean {
		return !this.#closed;
	}

	static async launch(browser = findBrowser()): Promise<HtmlRenderer> {
		if (!browser) throw new Error(`no Chromium found (tried ${BROWSER_CANDIDATES.join(", ")}; set OMP_ARTIFACTS_BROWSER)`);
		sweepStaleProfiles();
		const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
		const setpriv = Bun.which("setpriv");
		const proc: BrowserProcess = Bun.spawn(
			[
				...(setpriv ? [setpriv, "--pdeathsig", "TERM", "--"] : []),
				browser,
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${profileDir}`,
				"--hide-scrollbars",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				"--disable-extensions",
				"--mute-audio",
				// A fresh profile otherwise talks to the desktop keyring and Google services
				// at startup; seen as multi-second (once 20 s+) stalls before the first page.
				"--password-store=basic",
				"--use-mock-keychain",
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-sync",
				"--disable-default-apps",
				"--metrics-recording-only",
				"--disable-breakpad",
				"about:blank",
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		let endpoint: string;
		try {
			endpoint = await readDevtoolsEndpoint(proc.stderr);
		} catch (err) {
			proc.kill();
			fs.rmSync(profileDir, { recursive: true, force: true });
			throw err;
		}
		const ws = new WebSocket(endpoint);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error(`cannot connect to ${endpoint}`));
		await opened.promise;
		return new HtmlRenderer(proc, ws, profileDir);
	}

	/** Opens a fresh tab; tabs are independent, so a viewer and a thumbnail job can run at once. */
	async openPage(): Promise<RendererPage> {
		const targetId = field(await this.#call("Target.createTarget", { url: "about:blank" }), "targetId");
		const sessionId = field(await this.#call("Target.attachToTarget", { targetId, flatten: true }), "sessionId");
		const call = (method: string, params: Record<string, unknown> = {}) => this.#call(method, params, sessionId);
		await call("Page.enable");
		return {
			load: async (url, viewport) => {
				await call("Emulation.setDeviceMetricsOverride", { ...viewport });
				const loaded = this.#waitFor("Page.loadEventFired", sessionId, LOAD_TIMEOUT_MS);
				try {
					const nav = await call("Page.navigate", { url });
					if (typeof nav.errorText === "string" && nav.errorText) throw new Error(`${url}: ${nav.errorText}`);
				} catch (err) {
					loaded.cancel();
					throw err;
				}
				await loaded.promise;
				// Height after web fonts settle, so the last strip is not cut short.
				const { result } = await call("Runtime.evaluate", {
					expression:
						"document.fonts.ready.then(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))",
					awaitPromise: true,
					returnByValue: true,
				});
				const value = result && typeof result === "object" && "value" in result ? Number(result.value) : Number.NaN;
				return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
			},
			capture: async (y, width, height, scale = 1) => {
				const shot = await call("Page.captureScreenshot", {
					format: "png",
					clip: { x: 0, y, width, height, scale },
					captureBeyondViewport: true,
					// Measured on a 4.9k px report: ~35% faster per capture, PNGs ~30% larger.
					optimizeForSpeed: true,
				});
				return field(shot, "data");
			},
			close: () => {
				if (this.#closed) return;
				this.#call("Target.closeTarget", { targetId }).catch(() => {});
			},
		};
	}

	close(): void {
		if (this.#proc.killed && this.#closed) return;
		this.#closed = true;
		this.#failAll(new Error("renderer closed"));
		try {
			this.#ws.close();
		} catch {}
		this.#proc.kill();
		const dir = this.#profileDir;
		const rm = () => fs.rmSync(dir, { recursive: true, force: true });
		// Best effort now (the process may be exiting), again once Chromium is gone:
		// it keeps writing to the profile for a moment after SIGTERM.
		try {
			rm();
		} catch {}
		void this.#proc.exited.finally(rm);
	}

	#call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResult> {
		if (this.#closed) return Promise.reject(new Error("renderer closed"));
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<CdpResult>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, CALL_TIMEOUT_MS);
		this.#pending.set(id, { resolve, reject, timer });
		this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
		return promise;
	}

	#waitFor(event: string, sessionId: string, timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const listener = (method: string, from?: string) => {
			if (method !== event || from !== sessionId) return;
			this.#listeners.delete(listener);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#listeners.delete(listener);
			reject(new Error(`${event} not fired within ${timeoutMs} ms`));
		}, timeoutMs);
		this.#listeners.add(listener);
		const cancel = () => {
			this.#listeners.delete(listener);
			clearTimeout(timer);
		};
		return { promise, cancel };
	}

	#failAll(err: Error): void {
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.#pending.clear();
	}
}

/**
 * Deletes profile directories left by browsers that are gone: Chromium's
 * `SingletonLock` symlink names its pid (`host-pid`); no lock, or a dead pid,
 * means nothing uses the directory any more.
 */
function sweepStaleProfiles(): void {
	const tmp = os.tmpdir();
	let names: string[];
	try {
		names = fs.readdirSync(tmp).filter(n => n.startsWith(PROFILE_PREFIX));
	} catch {
		return;
	}
	for (const name of names) {
		const dir = path.join(tmp, name);
		try {
			if (Date.now() - fs.statSync(dir).mtimeMs < PROFILE_GRACE_MS) continue;
			let alive = false;
			try {
				const pid = Number(fs.readlinkSync(path.join(dir, "SingletonLock")).split("-").pop());
				if (pid > 0) {
					process.kill(pid, 0);
					alive = true;
				}
			} catch (err) {
				// EPERM: the pid exists but belongs to someone else, so leave the directory alone.
				alive = (err as NodeJS.ErrnoException).code === "EPERM";
			}
			if (!alive) fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

async function readDevtoolsEndpoint(stderr: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
	try {
		while (Date.now() < deadline) {
			const chunk = await Promise.race([
				reader.read(),
				Bun.sleep(deadline - Date.now()).then(() => ({ done: true as const, value: undefined })),
			]);
			if (chunk.done) break;
			buf += decoder.decode(chunk.value, { stream: true });
			const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) {
				// Keep draining so Chromium never blocks on a full stderr pipe.
				void (async () => {
					try {
						while (!(await reader.read()).done) {}
					} catch {}
				})();
				return m[1];
			}
		}
	} catch {}
	reader.releaseLock();
	throw new Error(`browser did not report a DevTools endpoint: ${buf.trim().slice(-300) || "no output"}`);
}
