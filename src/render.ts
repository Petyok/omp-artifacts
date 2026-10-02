/**
 * Renders pages in omp's own headless Chromium over CDP: load a page at a given
 * CSS viewport, capture arbitrary vertical slices of it as PNG. Used by index.ts.
 *
 * The browser is the project-shared one that omp's `browser` tool uses: omp's
 * daemon broker starts it, finds the executable, and owns its lifetime, so this
 * plugin never spawns or kills a Chromium. Like that tool, there is no private
 * fallback when the broker is unavailable.
 *
 * Our tabs live in a browser context of their own, created with
 * `disposeOnDetach`: when this connection drops, including when omp crashes,
 * Chromium closes every tab in it.
 */
import { ensureSharedBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";

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
	#ws: WebSocket;
	#contextId = "";
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#listeners = new Set<(method: string, sessionId?: string) => void>();
	#closed = false;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
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

	/** False once the connection to Chromium is gone (browser restarted, broker stopped it). */
	get alive(): boolean {
		return !this.#closed;
	}

	/** Attaches to omp's shared browser for `projectDir`, starting it through omp when needed. */
	static async connect(projectDir: string): Promise<HtmlRenderer> {
		const shared = await ensureSharedBrowser({ projectDir, headless: true });
		if (!shared) {
			throw new Error("omp's shared browser is unavailable (no Chromium found, or its daemon failed to start; details in ~/.omp/logs)");
		}
		const ws = new WebSocket(shared.wsEndpoint);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error(`cannot connect to ${shared.wsEndpoint}`));
		await opened.promise;
		const renderer = new HtmlRenderer(ws);
		renderer.#contextId = field(
			await renderer.#call("Target.createBrowserContext", { disposeOnDetach: true }),
			"browserContextId",
		);
		return renderer;
	}

	/** Opens a fresh tab; tabs are independent, so a viewer and a thumbnail job can run at once. */
	async openPage(): Promise<RendererPage> {
		const target = await this.#call("Target.createTarget", { url: "about:blank", browserContextId: this.#contextId });
		const targetId = field(target, "targetId");
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

	#call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResult> {
		if (this.#closed) return Promise.reject(new Error("browser connection closed"));
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
