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
/** Cap on waiting for network idle after `load`: long-poll, websocket and analytics pages never go idle. */
const IDLE_TIMEOUT_MS = 5_000;

/**
 * Resolves after the DOM has not changed for 300 ms (at most 2 s), then after web
 * fonts settle, with the page size in CSS px: data fetched after `load` is often
 * rendered a few tasks later, and the last strip must not be cut short.
 */
const settledSize = (quietMs: number, capMs: number): string => `new Promise(resolve => {
	let quiet;
	const done = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(); };
	const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, ${quietMs}); });
	observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	quiet = setTimeout(done, ${quietMs});
	const cap = setTimeout(done, ${capMs});
})
	.then(() => document.fonts.ready)
	.then(() => ({
		width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
		height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
	}))`;
/** After `load`: data fetched later may still be rendering. */
const SETTLED_SIZE = settledSize(300, 2000);
/** After a click: the page is already up, so only its reaction (a panel, an animation frame) is waited for. */
const SETTLED_AFTER_CLICK = settledSize(100, 800);

/** Page extent in CSS px; `width` beyond the viewport means the page scrolls sideways. */
export interface PageSize {
	width: number;
	height: number;
}

function toPageSize(result: unknown): PageSize {
	const value = result && typeof result === "object" && "value" in result ? (result.value as Partial<PageSize> | null) : null;
	const width = Number(value?.width);
	const height = Number(value?.height);
	return {
		width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : 1,
		height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : 1,
	};
}

/** True when `promise` settles first, false after `ms`. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
	const timeout = Promise.withResolvers<boolean>();
	const timer = setTimeout(timeout.resolve, ms, false);
	return Promise.race([promise.then(() => true), timeout.promise]).finally(() => clearTimeout(timer));
}

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
	/**
	 * Navigates (or reloads) `url` at `viewport` and waits for `load`, network idle (≤5 s)
	 * and a quiet DOM (≤2 s); resolves with the page size in CSS px.
	 */
	load(url: string, viewport: Viewport): Promise<PageSize>;
	/**
	 * PNG (base64) of the CSS-px rectangle starting at (`x`, `y`), at the viewport's device
	 * scale times `scale` (below 1 for thumbnails).
	 */
	capture(x: number, y: number, width: number, height: number, scale?: number): Promise<string>;
	/**
	 * Left-clicks the page at a document CSS-px point (the page is scrolled there first, so
	 * points below the first screen work), waits for the DOM to settle, and resolves with the
	 * new page size: a click can open a panel, expand a node or navigate to another document.
	 */
	click(x: number, y: number): Promise<PageSize>;
	close(): void;
}

export class HtmlRenderer {
	#ws: WebSocket;
	#contextId = "";
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#listeners = new Set<(method: string, sessionId: string | undefined, params: CdpResult) => void>();
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
				for (const listener of this.#listeners) listener(msg.method, msg.sessionId, (msg.params ?? {}) as CdpResult);
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
		await call("Page.setLifecycleEventsEnabled", { enabled: true });
		return {
			load: async (url, viewport) => {
				await call("Emulation.setDeviceMetricsOverride", { ...viewport });
				// Both listen from before the navigation; idle matches only this navigation's document.
				let nav: CdpResult = {};
				const loaded = this.#waitFor("Page.loadEventFired", sessionId);
				// Chrome's networkIdle: no requests for 500 ms (Puppeteer's networkidle0), so fetch/XHR
				// started after `load` have landed.
				const idle = this.#waitFor(
					"Page.lifecycleEvent",
					sessionId,
					p => p.name === "networkIdle" && p.frameId === nav.frameId && p.loaderId === nav.loaderId,
				);
				try {
					nav = await call("Page.navigate", { url });
					if (typeof nav.errorText === "string" && nav.errorText) throw new Error(`${url}: ${nav.errorText}`);
					if (!(await within(loaded.promise, LOAD_TIMEOUT_MS))) {
						throw new Error(`Page.loadEventFired not fired within ${LOAD_TIMEOUT_MS} ms`);
					}
					// Blink checks for network idle only when a main-thread task starts, else on a 2 s
					// watchdog (idleness_detector.cc): on a static page that put idle at load + ~950 ms.
					// A no-op tick brings it to the 500 ms window; it stops by itself.
					await call("Runtime.evaluate", {
						expression: `{ const tick = setInterval(() => {}, 100); setTimeout(clearInterval, ${IDLE_TIMEOUT_MS}, tick); }`,
					});
					await within(idle.promise, IDLE_TIMEOUT_MS);
				} finally {
					loaded.cancel();
					idle.cancel();
				}
				const { result } = await call("Runtime.evaluate", { expression: SETTLED_SIZE, awaitPromise: true, returnByValue: true });
				return toPageSize(result);
			},
			click: async (x, y) => {
				// Input events are viewport-relative: bring the point into view, click, scroll back so
				// captures (document coordinates) are unaffected.
				const evaluate = async (expression: string) =>
					((await call("Runtime.evaluate", { expression, returnByValue: true })).result as CdpResult | undefined)?.value;
				const [viewportWidth, viewportHeight] = (await evaluate("[innerWidth, innerHeight]")) as [number, number];
				// The browser clamps the scroll at the page edges, so read back where it really is.
				const [scrollX, scrollY] = (await evaluate(
					`window.scrollTo(${Math.max(0, x - viewportWidth / 2)}, ${Math.max(0, y - viewportHeight / 2)}); [scrollX, scrollY]`,
				)) as [number, number];
				const point = { x: x - scrollX, y: y - scrollY };
				await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
				await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
				await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
				await evaluate("window.scrollTo(0, 0)");
				const { result } = await call("Runtime.evaluate", { expression: SETTLED_AFTER_CLICK, awaitPromise: true, returnByValue: true });
				return toPageSize(result);
			},
			capture: async (x, y, width, height, scale = 1) => {
				const shot = await call("Page.captureScreenshot", {
					format: "png",
					clip: { x, y, width, height, scale },
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

	/** Resolves on the first `event` of `sessionId` whose params pass `match`; never times out, callers bound it. */
	#waitFor(
		event: string,
		sessionId: string,
		match: (params: CdpResult) => boolean = () => true,
	): { promise: Promise<void>; cancel: () => void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		const listener = (method: string, from: string | undefined, params: CdpResult) => {
			if (method !== event || from !== sessionId || !match(params)) return;
			this.#listeners.delete(listener);
			resolve();
		};
		this.#listeners.add(listener);
		return { promise, cancel: () => this.#listeners.delete(listener) };
	}

	#failAll(err: Error): void {
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.#pending.clear();
	}
}
