/**
 * Artifacts inside omp: a preview queue the agent fills, a persistent library, and a viewer.
 *
 *   show_artifact (tool)       the agent queues a file; a card with a thumbnail appears
 *                              above the prompt, right-aligned
 *   alt+o, or a click on the   opens the newest card's artifact; closing the viewer
 *   card's title               takes it off the queue
 *   alt+x                      dismisses the newest card unopened; it stays in the library
 *   alt+shift+o, /artifacts    the Artifact Library: everything ever shown or viewed
 *   /view                      the queue head, else the last .html/.md written this session
 *   /view <path | URL>         any file (relative to the session cwd, ~ allowed)
 *
 * Kinds: HTML, Markdown, text/code, images, PDF (pdftoppm), http(s) URLs; see artifacts.ts.
 *
 * Headless Chromium (render.ts) renders the page at a CSS viewport sized
 * to the terminal's pixel area and captures it in screen-tall strips ("chunks").
 * Each chunk is sent to kitty once and drawn through Unicode placeholders: every
 * placeholder cell names its own image row, so scrolling is just printing a
 * different slice of rows. No re-render per scroll step.
 *
 * Viewer keys: wheel / j k ↓↑ scroll · space b PgDn PgUp page · g G top/bottom ·
 * m desktop/mobile (390 px) · r reload from disk · o system browser · q Esc close.
 *
 * The card title is an OSC 8 link `omp-artifacts://open`; kitty maps a click on it to the
 * shortcut in ~/.config/kitty/open-actions.conf (`protocol omp-artifacts` /
 * `action send_key alt+o`). Only the title is a link: kitty underlines a hovered link
 * on every cell it covers, which across the whole card looked like static.
 *
 * Needs kitty (or Ghostty) graphics with Unicode placeholders. Pages render in omp's
 * own project-shared headless Chromium (render.ts); writing an .html or .md connects
 * to it in the background so the first view does not wait.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	encodeKittyDeleteImage,
	encodeKittyPlaceholderGrid,
	encodeKittyTransmit,
	encodeKittyVirtualPlacement,
	extractPrintableText,
	getCellDimensions,
	getKittyGraphics,
	ImageProtocol,
	isKeyRelease,
	KITTY_PLACEHOLDER_MAX_CELLS,
	type OverlayHandle,
	type OverlayOptions,
	parseKey,
	routeSgrMouseInput,
	TERMINAL,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import {
	type FileInfo,
	fileInfo,
	forgetInLibrary,
	formatBytes,
	KIND_LABEL,
	type LibraryEntry,
	loadLibrary,
	pageUrl,
	recordInLibrary,
	resolveTarget,
	type Target,
	sweepCache,
	thumbCachePath,
	tildify,
	touchCache,
} from "./artifacts.ts";
import { HtmlRenderer, type RendererPage, type Viewport } from "./render.ts";

/** Desktop layouts are rendered at most this wide (CSS px); wider terminals get a higher device scale. */
const DESKTOP_CSS_WIDTH = 1280;
const MOBILE_CSS_WIDTH = 390;
/** Cell height (device px) that counts as 1× density when sizing the mobile view. */
const CELL_HEIGHT_AT_1X = 17;
/**
 * Strips kept decoded in kitty: the visible ones (at most two) plus one on each
 * side. A strip is one screen tall, ~32 MB decoded on a 4K-wide HiDPI terminal.
 */
const MAX_LIVE_CHUNKS = 5;
/** Rows moved per wheel notch and per j/k. */
const WHEEL_ROWS = 3;
/** Writes of these connect to the browser early and become the bare-/view fallback. */
const PREWARM_RE = /\.(html?|md|markdown)$/i;
/** Opens the queue head; unbound in omp's default keymap. */
const SHORTCUT = "alt+o";
const LIBRARY_SHORTCUT = "alt+shift+o";
const DISMISS_SHORTCUT = "alt+x";
const CARD_WIDGET = "omp-artifacts-card";
/** Target of the card's OSC 8 link; kitty's open-actions.conf turns a click into SHORTCUT. */
const CARD_LINK = "omp-artifacts://open";
const THUMB_COLS = 14;
const THUMB_ROWS = 3;
const CARD_TEXT_COLS = 48;

const FULLSCREEN: OverlayOptions = { fullscreen: true, mouseTracking: true, width: "100%", maxHeight: "100%", row: 0, col: 0 };

const notKitty = (): boolean => TERMINAL.imageProtocol !== ImageProtocol.Kitty || !getKittyGraphics().unicodePlaceholders;

function ago(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

/** Pads an already-fitting styled string to `cols` cells. */
const pad = (styled: string, cols: number): string => styled + " ".repeat(Math.max(0, cols - visibleWidth(styled)));
const fit = (styled: string, cols: number): string => pad(truncateToWidth(styled, cols), cols);
const link = (s: string): string => `\x1b]8;;${CARD_LINK}\x1b\\${s}\x1b]8;;\x1b\\`;

function openExternally(url: string): void {
	Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}

// ── browser connection ──────────────────────────────────────────────────────

/** Session cwd: omp's shared browser is per project. */
let projectDir = process.cwd();
let connection: Promise<HtmlRenderer> | undefined;

/** One connection per omp process, reopened when the browser went away. */
async function getRenderer(): Promise<HtmlRenderer> {
	const seen = connection;
	const current = seen && (await seen.catch(() => undefined));
	if (current?.alive) return current;
	// Concurrent callers that saw the same dead connection share one reconnect.
	if (connection === seen || !connection) connection = HtmlRenderer.connect(projectDir);
	return connection;
}

// ── kitty images ────────────────────────────────────────────────────────────

/** A kitty image addressed through Unicode placeholders. */
interface Placed {
	imageId: number;
	/** One placeholder line per terminal row of the image. */
	grid: string[];
}

let imageSeq = 0;

/** Sends a PNG to kitty and returns the placeholder lines that display it at `columns`×`rows`. */
function placeImage(tui: TUI, png: string, columns: number, rows: number): Placed {
	const imageId = tui.imageBudget.acquireId(`omp-artifacts:${process.pid}:${++imageSeq}`);
	const placement = { imageId, columns, rows };
	tui.terminal.write(encodeKittyTransmit(png, imageId) + encodeKittyVirtualPlacement(placement));
	return { imageId, grid: encodeKittyPlaceholderGrid(placement) };
}

let thumbChain: Promise<unknown> = Promise.resolve();

/**
 * PNG (base64) of the top of `target`, sized to `cols`×`rows` cells, from the disk
 * cache when the file has not changed. Renders one at a time.
 */
function renderThumb(target: Target, cols: number, rows: number): Promise<string> {
	const cell = getCellDimensions();
	const widthPx = cols * cell.widthPx;
	const heightPx = rows * cell.heightPx;
	const cached = thumbCachePath(target, widthPx, heightPx);
	if (fs.existsSync(cached)) {
		touchCache(cached);
		return Promise.resolve(fs.readFileSync(cached).toString("base64"));
	}
	const job = thumbChain.then(async () => {
		const page = await (await getRenderer()).openPage();
		try {
			const scale = widthPx / DESKTOP_CSS_WIDTH;
			const cssHeight = heightPx / scale;
			const viewport = { width: DESKTOP_CSS_WIDTH, height: Math.round(cssHeight), deviceScaleFactor: 1, mobile: false };
			await page.load(await pageUrl(target), viewport);
			const png = await page.capture(0, DESKTOP_CSS_WIDTH, cssHeight, scale);
			fs.mkdirSync(path.dirname(cached), { recursive: true });
			fs.writeFileSync(cached, Buffer.from(png, "base64"));
			return png;
		} finally {
			page.close();
		}
	});
	thumbChain = job.catch(() => {});
	return job;
}

// ── viewer ──────────────────────────────────────────────────────────────────

/** The subset of omp's `Theme` the viewer, card and library use. */
interface ViewerTheme {
	fg(color: "accent" | "muted" | "dim" | "error" | "warning", text: string): string;
	bold(text: string): string;
}

type Mode = "desktop" | "mobile";

interface Geometry {
	key: string;
	viewport: Viewport;
	imageCols: number;
	imageRows: number;
	padCols: number;
	/** CSS px covered by one terminal row. */
	rowCss: number;
	chunkRows: number;
}

class HtmlViewer implements Component {
	#tui: TUI;
	#theme: ViewerTheme;
	#done: () => void;
	#target: Target;
	/** What Chromium loaded last (the wrapper page for non-HTML kinds); `o` opens it. */
	#loadedUrl?: string;

	#page?: RendererPage;
	#mode: Mode = "desktop";
	#geometry?: Geometry;
	/** Geometry key the loaded page and its chunks belong to. */
	#loadedKey?: string;
	/** Bumped on every page load; stale captures of an older load are never installed. */
	#generation = 0;
	#pageRows = 0;
	#topRow = 0;
	#chunks = new Map<number, Placed>();
	#status = "connecting to the browser…";
	#error = false;
	#running = false;
	/** A kick arrived while the worker was running; run it again once it exits. */
	#rerun = false;
	#disposed = false;

	constructor(tui: TUI, theme: ViewerTheme, done: () => void, target: Target) {
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
		this.#target = target;
		getRenderer()
			.then(renderer => renderer.openPage())
			.then(
				page => {
					if (this.#disposed) return page.close();
					this.#page = page;
					this.#kick();
				},
				err => this.#fail(err),
			);
	}

	render(width: number): readonly string[] {
		const rows = Math.max(4, this.#tui.terminal.rows);
		const g = this.#measure(width, rows);
		if (g.key !== this.#geometry?.key) {
			this.#geometry = g;
			this.#kick();
		}
		const lines: string[] = [];
		const left = " ".repeat(g.padCols);
		const current = this.#loadedKey === g.key;
		for (let r = 0; r < g.imageRows; r++) {
			const row = this.#topRow + r;
			const chunk = current && row < this.#pageRows ? this.#chunks.get(Math.floor(row / g.chunkRows)) : undefined;
			lines.push(chunk ? left + chunk.grid[row % g.chunkRows] : "");
		}
		lines.push(this.#statusLine(width, g));
		return lines;
	}

	handleInput(data: string): void {
		const isMouse = routeSgrMouseInput(data, event => {
			if (event.wheel) this.#scrollTo(this.#topRow + event.wheel * WHEEL_ROWS);
			return true;
		});
		if (isMouse || isKeyRelease(data)) return;
		const page = Math.max(1, (this.#geometry?.imageRows ?? 20) - 2);
		switch (parseKey(data) ?? data) {
			case "q":
			case "escape":
				this.#done();
				return;
			case "j":
			case "down":
				return this.#scrollTo(this.#topRow + WHEEL_ROWS);
			case "k":
			case "up":
				return this.#scrollTo(this.#topRow - WHEEL_ROWS);
			case "space":
			case "f":
			case "pageDown":
				return this.#scrollTo(this.#topRow + page);
			case "b":
			case "pageUp":
				return this.#scrollTo(this.#topRow - page);
			case "g":
			case "home":
				return this.#scrollTo(0);
			case "G":
			case "shift+g":
			case "end":
				return this.#scrollTo(Number.MAX_SAFE_INTEGER);
			case "m":
				this.#mode = this.#mode === "desktop" ? "mobile" : "desktop";
				this.#tui.requestRender();
				return;
			case "r":
				this.#loadedKey = undefined;
				this.#kick();
				return;
			case "o":
				openExternally(this.#loadedUrl ?? this.#target.source);
				this.#status = "opened in the system browser";
				this.#tui.requestRender();
				return;
		}
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#dropChunks();
		// Still connecting: the open callback closes the tab once it sees #disposed.
		this.#page?.close();
	}

	#measure(width: number, rows: number): Geometry {
		const cell = getCellDimensions();
		const imageRows = rows - 1;
		const maxCols = Math.min(width - 2, KITTY_PLACEHOLDER_MAX_CELLS);
		let imageCols: number;
		let cssWidth: number;
		if (this.#mode === "desktop") {
			imageCols = maxCols;
			cssWidth = Math.min(DESKTOP_CSS_WIDTH, imageCols * cell.widthPx);
		} else {
			const density = Math.max(1, cell.heightPx / CELL_HEIGHT_AT_1X);
			imageCols = Math.min(maxCols, Math.round((MOBILE_CSS_WIDTH * density) / cell.widthPx));
			cssWidth = MOBILE_CSS_WIDTH;
		}
		// Exact device scale, so a strip's PNG is exactly imageCols × rows cells and kitty never resamples it.
		const scale = (imageCols * cell.widthPx) / cssWidth;
		// One screen per strip: a capture costs ~0.3-0.4 s, so the first screen shows fast.
		const chunkRows = Math.min(KITTY_PLACEHOLDER_MAX_CELLS, imageRows);
		return {
			key: `${this.#mode}:${imageCols}x${imageRows}:${cell.widthPx}x${cell.heightPx}`,
			viewport: {
				width: cssWidth,
				height: Math.round((imageRows * cell.heightPx) / scale),
				deviceScaleFactor: scale,
				mobile: this.#mode === "mobile",
			},
			imageCols,
			imageRows,
			padCols: Math.max(0, Math.floor((width - imageCols) / 2)),
			rowCss: cell.heightPx / scale,
			chunkRows,
		};
	}

	#statusLine(width: number, g: Geometry): string {
		const t = this.#theme;
		const parts = [t.bold(` ${this.#target.label}`)];
		if (this.#loadedKey === g.key && this.#pageRows > 0) {
			const maxTop = Math.max(0, this.#pageRows - g.imageRows);
			const pct = maxTop === 0 ? 100 : Math.round((this.#topRow / maxTop) * 100);
			parts.push(t.fg("accent", `${this.#mode} ${g.viewport.width}px`), t.fg("muted", `${pct}%`));
		}
		const status = this.#status || (this.#visibleMissing(g) ? "rendering…" : "");
		if (status) parts.push(this.#error ? t.fg("error", status) : t.fg("warning", status));
		const left = parts.join("  ");
		const help = t.fg("dim", "wheel j/k space/b g/G · m mobile · r reload · o browser · q close ");
		const gap = width - visibleWidth(left) - visibleWidth(help);
		return gap >= 2 ? left + " ".repeat(gap) + help : truncateToWidth(left, width);
	}

	#scrollTo(row: number): void {
		const g = this.#geometry;
		if (!g || this.#pageRows === 0) return;
		const top = Math.min(Math.max(0, row), Math.max(0, this.#pageRows - g.imageRows));
		if (top === this.#topRow) return;
		this.#topRow = top;
		this.#tui.requestRender();
		this.#kick();
	}

	/** First and last strip index on screen. */
	#visibleChunks(g: Geometry): [number, number] {
		const last = Math.min(this.#pageRows, this.#topRow + g.imageRows) - 1;
		return [Math.floor(this.#topRow / g.chunkRows), Math.floor(Math.max(0, last) / g.chunkRows)];
	}

	#visibleMissing(g: Geometry): boolean {
		if (this.#loadedKey !== g.key) return true;
		const [first, last] = this.#visibleChunks(g);
		for (let c = first; c <= last; c++) if (!this.#chunks.has(c)) return true;
		return false;
	}

	/**
	 * Starts the background worker, or flags a rerun when it is already going: a
	 * worker that already decided "nothing to do" may be awaiting its exit when the
	 * first render supplies the geometry, and that kick must not be lost.
	 */
	#kick(): void {
		if (this.#disposed) return;
		if (this.#running) {
			this.#rerun = true;
			return;
		}
		this.#running = true;
		this.#rerun = false;
		void this.#work().finally(() => {
			this.#running = false;
			if (this.#rerun) this.#kick();
		});
	}

	async #work(): Promise<void> {
		while (!this.#disposed && this.#page && this.#geometry) {
			const page = this.#page;
			const g = this.#geometry;
			try {
				if (this.#loadedKey !== g.key) {
					await this.#loadPage(page, g);
					continue;
				}
				const next = this.#nextChunk(g);
				if (next === undefined) return;
				await this.#loadChunk(page, g, next);
			} catch (err) {
				this.#fail(err);
				return;
			}
		}
	}

	async #loadPage(page: RendererPage, g: Geometry): Promise<void> {
		const oldRows = this.#pageRows;
		this.#status = "rendering…";
		this.#error = false;
		this.#tui.requestRender();
		this.#loadedUrl = await pageUrl(this.#target);
		const height = await page.load(this.#loadedUrl, g.viewport);
		if (this.#disposed) return;
		this.#dropChunks();
		this.#generation++;
		// Keep the reader's relative position; read topRow only now, so a scroll
		// made while the page was loading wins over the old position.
		const fraction = oldRows > 0 ? this.#topRow / oldRows : 0;
		this.#pageRows = Math.max(1, Math.ceil(height / g.rowCss));
		this.#topRow = Math.min(Math.round(fraction * this.#pageRows), Math.max(0, this.#pageRows - g.imageRows));
		this.#loadedKey = g.key;
		this.#status = "";
		this.#tui.requestRender();
	}

	/** Visible strips first, then one ahead and one behind; undefined when none of those is missing. */
	#nextChunk(g: Geometry): number | undefined {
		const total = Math.ceil(this.#pageRows / g.chunkRows);
		const [first, last] = this.#visibleChunks(g);
		const order: number[] = [];
		for (let c = first; c <= last; c++) order.push(c);
		order.push(last + 1, first - 1);
		return order.find(c => c >= 0 && c < total && !this.#chunks.has(c));
	}

	async #loadChunk(page: RendererPage, g: Geometry, index: number): Promise<void> {
		const generation = this.#generation;
		const rows = Math.min(g.chunkRows, this.#pageRows - index * g.chunkRows);
		const png = await page.capture(index * g.chunkRows * g.rowCss, g.viewport.width, rows * g.rowCss);
		if (this.#disposed || generation !== this.#generation || this.#loadedKey !== g.key) return;
		this.#chunks.set(index, placeImage(this.#tui, png, g.imageCols, rows));
		this.#evictFarChunks(g);
		this.#tui.requestRender();
	}

	/**
	 * Keeps kitty's image memory bounded: drops the strips farthest from the screen,
	 * never one inside the prefetch window, so eviction cannot fight #nextChunk.
	 */
	#evictFarChunks(g: Geometry): void {
		const [first, last] = this.#visibleChunks(g);
		while (this.#chunks.size > MAX_LIVE_CHUNKS) {
			let far: number | undefined;
			let farDistance = 0;
			for (const index of this.#chunks.keys()) {
				const distance = index < first ? first - index : index - last;
				if (distance > 1 && distance > farDistance) {
					far = index;
					farDistance = distance;
				}
			}
			if (far === undefined) return;
			const chunk = this.#chunks.get(far);
			this.#chunks.delete(far);
			if (chunk) this.#tui.terminal.write(encodeKittyDeleteImage(chunk.imageId));
		}
	}

	#dropChunks(): void {
		let deletes = "";
		for (const chunk of this.#chunks.values()) deletes += encodeKittyDeleteImage(chunk.imageId);
		this.#chunks.clear();
		if (deletes) this.#tui.terminal.write(deletes);
	}

	#fail(err: unknown): void {
		this.#status = err instanceof Error ? err.message : String(err);
		this.#error = true;
		this.#tui.requestRender();
	}
}

/** Opens the fullscreen viewer (alternate screen, so the terminal reports the mouse wheel). */
async function openViewer(ctx: ExtensionContext, target: Target): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new HtmlViewer(tui, theme, () => done(), target), {
		overlay: true,
		overlayOptions: FULLSCREEN,
	});
}

// ── preview queue ───────────────────────────────────────────────────────────

interface Queued extends Target {
	addedAt: number;
	/** Size at queue time; the card renders every frame, so no stat per render. */
	bytes?: number;
	thumb?: Placed;
	thumbState: "none" | "loading" | "ready" | "failed";
}

/** Newest first. Module-level: subagents share it with the main session. */
const queue: Queued[] = [];
/** UI of the interactive main session; subagents (no UI) queue through it. */
let mainUi: ExtensionContext["ui"] | undefined;
/** Set while the card widget is mounted. */
let cardTui: TUI | undefined;
let cardMounted = false;

function refreshCard(): void {
	if (queue.length === 0) {
		if (cardMounted) mainUi?.setWidget(CARD_WIDGET, undefined);
		cardMounted = false;
		return;
	}
	if (!cardMounted && mainUi) {
		mainUi.setWidget(CARD_WIDGET, (tui, theme) => new QueueCard(tui, theme), { placement: "aboveEditor" });
		cardMounted = true;
	}
	cardTui?.requestRender();
}

function enqueue(target: Target): number {
	const existing = queue.findIndex(a => a.source === target.source);
	if (existing >= 0) dropCardThumb(queue.splice(existing, 1)[0]);
	queue.unshift({ ...target, addedAt: Date.now(), bytes: fileInfo(target)?.bytes, thumbState: "none" });
	refreshCard();
	return queue.length;
}

function dequeue(source: string): void {
	const index = queue.findIndex(a => a.source === source);
	if (index < 0) return;
	dropCardThumb(queue.splice(index, 1)[0]);
	refreshCard();
}

const isQueued = (source: string): boolean => queue.some(q => q.source === source);

function dropCardThumb(item: Queued): void {
	if (item.thumb) cardTui?.terminal.write(encodeKittyDeleteImage(item.thumb.imageId));
	item.thumb = undefined;
}

/** Viewing an artifact from anywhere takes it off the queue and puts it on top of the library. */
async function viewAndRecord(ctx: ExtensionContext, target: Target): Promise<void> {
	recordInLibrary(target, ctx.cwd);
	await openViewer(ctx, target);
	dequeue(target.source);
}

/**
 * Right-aligned card above the prompt for the newest queued artifact. It never
 * grows with the queue: further items only show as up to two card edges peeking
 * out above it, plus "1 of N". The library lists and tags every queued item.
 *
 *       ╭───────────────────────────────────────────────────────────╮
 *     ╭─┴───────────────────────────────────────────────────────────┴─╮
 *   ╭─┴──────────────┬────────────────────────────────────────────────┴─╮
 *   │ [thumbnail]    │ Quarterly report                          1 of 3 │
 *   │                │ HTML · 217 KB · just now                         │
 *   │                │ alt+o open · alt+x dismiss · alt+shift+o library │
 *   ╰────────────────┴──────────────────────────────────────────────────╯
 */
class QueueCard implements Component {
	#tui: TUI;
	#theme: ViewerTheme;

	constructor(tui: TUI, theme: ViewerTheme) {
		this.#tui = tui;
		this.#theme = theme;
		cardTui = tui;
	}

	render(width: number): readonly string[] {
		const head = queue[0];
		if (!head) return [];
		this.#loadThumb(head);
		const t = this.#theme;
		const queued = queue.length > 1 ? ` · ${queue.length} queued` : "";
		const position = queue.length > 1 ? t.fg("dim", `1 of ${queue.length}`) : "";
		const cardCols = THUMB_COLS + CARD_TEXT_COLS + 7;
		if (width < cardCols + 2) {
			const title = truncateToWidth(head.label, Math.max(8, width - 20));
			const line = `${t.fg("accent", "▸")} ${link(t.bold(title))} ${t.fg("dim", `${SHORTCUT}${queued}`)}`;
			return [" ".repeat(Math.max(0, width - 1 - visibleWidth(line))) + line];
		}
		const size = head.bytes !== undefined ? ` · ${formatBytes(head.bytes)}` : "";
		// Truncate before linking, so a cut never drops the link's closing sequence.
		const titleCols = CARD_TEXT_COLS - (position ? visibleWidth(position) + 2 : 0);
		const title = link(t.bold(t.fg("accent", truncateToWidth(head.label, titleCols))));
		const text = [
			pad(title, CARD_TEXT_COLS - visibleWidth(position)) + position,
			fit(t.fg("muted", `${KIND_LABEL[head.kind]}${size} · ${ago(Date.now() - head.addedAt)}`), CARD_TEXT_COLS),
			fit(
				`${t.fg("accent", SHORTCUT)} ${t.fg("muted", "open")} ${t.fg("dim", `· ${DISMISS_SHORTCUT} dismiss · ${LIBRARY_SHORTCUT} library`)}`,
				CARD_TEXT_COLS,
			),
		];
		const thumb = head.thumb?.grid ?? thumbPlaceholder(t, head.thumbState === "failed" ? "no preview" : "rendering…");
		const bar = (s: string) => t.fg("dim", s);
		const left = " ".repeat(width - cardCols - 1);
		// Cards behind the front one: one edge per extra queued item, at most two.
		const behind = Math.min(2, queue.length - 1);
		const edge = (inset: number, sidesAt?: number): string => {
			const chars = [...`${" ".repeat(inset)}╭${"─".repeat(cardCols - 2 * inset - 2)}╮${" ".repeat(inset)}`];
			if (sidesAt !== undefined) chars[sidesAt] = chars[cardCols - 1 - sidesAt] = "┴";
			return chars.join("");
		};
		const front = [...`╭${"─".repeat(THUMB_COLS + 2)}┬${"─".repeat(CARD_TEXT_COLS + 2)}╮`];
		if (behind > 0) front[2] = front[cardCols - 3] = "┴";
		const lines: string[] = [];
		if (behind === 2) lines.push(left + bar(edge(4)));
		if (behind > 0) lines.push(left + bar(edge(2, behind === 2 ? 4 : undefined)));
		lines.push(left + bar(front.join("")));
		for (let r = 0; r < THUMB_ROWS; r++) lines.push(`${left}${bar("│")} ${thumb[r]} ${bar("│")} ${text[r]} ${bar("│")}`);
		lines.push(left + bar(`╰${"─".repeat(THUMB_COLS + 2)}┴${"─".repeat(CARD_TEXT_COLS + 2)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		if (cardTui === this.#tui) cardTui = undefined;
	}

	#loadThumb(item: Queued): void {
		if (item.thumbState !== "none") return;
		item.thumbState = "loading";
		renderThumb(item, THUMB_COLS, THUMB_ROWS).then(
			png => {
				if (!queue.includes(item)) return;
				item.thumb = placeImage(this.#tui, png, THUMB_COLS, THUMB_ROWS);
				item.thumbState = "ready";
				this.#tui.requestRender();
			},
			() => {
				item.thumbState = "failed";
				this.#tui.requestRender();
			},
		);
	}
}

function thumbPlaceholder(t: ViewerTheme, label: string): string[] {
	return Array.from({ length: THUMB_ROWS }, (_, r) => fit(r === 1 ? t.fg("dim", ` ${label}`) : "", THUMB_COLS));
}

// ── library ─────────────────────────────────────────────────────────────────

const LIB_HEADER_ROWS = 2;
const LIB_FOOTER_ROWS = 2;
const ITEM_ROWS = 4;

/**
 * Fullscreen list of the artifacts shown or viewed in this project (the session's working
 * directory, as omp itself scopes projects), newest first; tab switches to all projects:
 *
 *    Artifact Library  ~/reports · 12 artifacts                    filter: net▏
 *   ─────────────────────────────────────────────────────────────────────
 *   ▌[thumbnail]   Quarterly report                              2 h ago
 *   ▌              HTML · 217 KB · ~/reports
 *   ▌              quarterly-report.html
 *
 * Type to filter; enter or a click opens the viewer on top of the list.
 */
class ArtifactLibrary implements Component {
	#tui: TUI;
	#theme: ViewerTheme;
	#done: () => void;
	#cwd: string;
	#allProjects = false;
	#handle?: OverlayHandle;
	#all: LibraryEntry[] = loadLibrary();
	#filter = "";
	#selected = 0;
	#top = 0;
	#visible = 1;
	#infos = new Map<string, FileInfo | undefined>();
	#thumbs = new Map<string, Placed | "loading" | "failed">();
	#viewing = false;
	#status = "";
	#disposed = false;

	constructor(tui: TUI, theme: ViewerTheme, done: () => void, cwd: string) {
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
		this.#cwd = cwd;
	}

	setHandle(handle: OverlayHandle): void {
		this.#handle = handle;
	}

	render(width: number): readonly string[] {
		const t = this.#theme;
		const rows = Math.max(8, this.#tui.terminal.rows);
		const items = this.#items();
		this.#visible = Math.max(1, Math.floor((rows - LIB_HEADER_ROWS - LIB_FOOTER_ROWS) / ITEM_ROWS));
		this.#selected = Math.min(Math.max(0, this.#selected), Math.max(0, items.length - 1));
		if (this.#selected < this.#top) this.#top = this.#selected;
		if (this.#selected >= this.#top + this.#visible) this.#top = this.#selected - this.#visible + 1;
		this.#top = Math.max(0, Math.min(this.#top, Math.max(0, items.length - this.#visible)));

		const pool = this.#pool();
		const queued = pool.filter(e => isQueued(e.source)).length;
		const scope = this.#allProjects ? "all projects" : tildify(this.#cwd);
		const count = this.#filter ? `${items.length} of ${pool.length}` : `${pool.length} artifacts`;
		const title = `${t.bold(" Artifact Library")}  ${t.fg("muted", `${scope} · ${count}`)}${queued ? t.fg("accent", ` · ${queued} queued`) : ""}`;
		const filter = this.#filter ? `${t.fg("muted", "filter:")} ${t.fg("accent", this.#filter)}▏ ` : t.fg("dim", "type to filter ");
		const lines = [pad(title, width - visibleWidth(filter)) + filter, t.fg("dim", "─".repeat(width))];

		const textCols = width - THUMB_COLS - 5;
		if (items.length === 0) {
			const empty =
				this.#all.length === 0
					? "Nothing yet: artifacts the agent shows, and files you /view, land here."
					: pool.length === 0
						? `Nothing from this project yet; tab shows all ${this.#all.length}.`
						: "No match.";
			lines.push("", `  ${t.fg("muted", empty)}`);
		}
		for (let i = this.#top; i < Math.min(items.length, this.#top + this.#visible); i++) {
			const e = items[i];
			const selected = i === this.#selected;
			const marker = selected ? t.fg("accent", "▌") : " ";
			const info = this.#info(e);
			const thumb = this.#thumb(e, info !== undefined || !e.file);
			const age = t.fg("dim", ago(Date.now() - e.lastShownAt));
			const name = truncateToWidth(e.label, Math.max(4, textCols - visibleWidth(age) - 2));
			const head = selected ? t.bold(t.fg("accent", name)) : t.bold(name);
			const where = e.file ? tildify(path.dirname(e.file)) : e.source;
			const meta = `${KIND_LABEL[e.kind]}${info ? ` · ${formatBytes(info.bytes)}` : ""}${e.file ? ` · ${where}` : ""}`;
			const tag = isQueued(e.source) ? t.fg("accent", "queued · ") : "";
			const third = e.file && !info ? t.fg("error", `missing · ${e.file}`) : t.fg("dim", e.file ? path.basename(e.file) : e.source);
			const text = [pad(head, textCols - visibleWidth(age)) + age, fit(tag + t.fg("muted", meta), textCols), fit(third, textCols)];
			for (let r = 0; r < THUMB_ROWS; r++) lines.push(`${marker} ${thumb[r]}  ${text[r]}`);
			lines.push("");
		}
		while (lines.length < rows - LIB_FOOTER_ROWS) lines.push("");
		lines.length = rows - LIB_FOOTER_ROWS;
		lines.push(t.fg("dim", "─".repeat(width)));
		const help = `tab ${this.#allProjects ? "this project" : "all projects"} · ↑↓ wheel move · enter click open · ctrl+d forget · ctrl+o browser · esc close`;
		const status = this.#status ? `${t.fg("warning", this.#status)}  ` : "";
		lines.push(truncateToWidth(` ${status}${t.fg("dim", help)}`, width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#viewing) return;
		const isMouse = routeSgrMouseInput(data, event => {
			if (event.wheel) this.#move(event.wheel);
			else if (event.leftClick) {
				const slot = event.row - LIB_HEADER_ROWS;
				const index = this.#top + Math.floor(slot / ITEM_ROWS);
				if (slot >= 0 && slot < this.#visible * ITEM_ROWS && index < this.#items().length) {
					this.#selected = index;
					this.#open();
				}
			}
			return true;
		});
		if (isMouse || isKeyRelease(data)) return;
		this.#status = "";
		switch (parseKey(data)) {
			case "up":
			case "ctrl+p":
				return this.#move(-1);
			case "down":
			case "ctrl+n":
				return this.#move(1);
			case "pageUp":
				return this.#move(-this.#visible);
			case "pageDown":
				return this.#move(this.#visible);
			case "home":
				return this.#move(-Number.MAX_SAFE_INTEGER);
			case "end":
				return this.#move(Number.MAX_SAFE_INTEGER);
			case "tab":
				this.#allProjects = !this.#allProjects;
				return this.#setFilter(this.#filter);
			case "enter":
			case "return":
				return this.#open();
			case "escape":
				if (!this.#filter) return this.#done();
				this.#setFilter("");
				return;
			case "backspace":
				return this.#setFilter(this.#filter.slice(0, -1));
			case "delete":
			case "ctrl+d":
				return this.#forget();
			case "ctrl+o": {
				const e = this.#items()[this.#selected];
				if (e) void pageUrl(e).then(openExternally, err => this.#say(String(err)));
				return;
			}
		}
		const text = extractPrintableText(data);
		if (text) this.#setFilter(this.#filter + text);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		let deletes = "";
		for (const thumb of this.#thumbs.values()) if (typeof thumb === "object") deletes += encodeKittyDeleteImage(thumb.imageId);
		if (deletes) this.#tui.terminal.write(deletes);
	}

	/** Entries of the current scope, before the text filter. */
	#pool(): LibraryEntry[] {
		return this.#allProjects ? this.#all : this.#all.filter(e => e.cwd === this.#cwd);
	}

	#items(): LibraryEntry[] {
		const pool = this.#pool();
		const needle = this.#filter.toLowerCase();
		if (!needle) return pool;
		return pool.filter(e =>
			`${e.label}\n${e.source}\n${e.cwd}\n${KIND_LABEL[e.kind]}${isQueued(e.source) ? "\nqueued" : ""}`
				.toLowerCase()
				.includes(needle),
		);
	}

	#info(e: LibraryEntry): FileInfo | undefined {
		if (!this.#infos.has(e.source)) this.#infos.set(e.source, fileInfo(e));
		return this.#infos.get(e.source);
	}

	/** Thumbnail rows for `e`, starting the render the first time it is on screen. */
	#thumb(e: LibraryEntry, exists: boolean): string[] {
		const t = this.#theme;
		const state = this.#thumbs.get(e.source);
		if (typeof state === "object") return state.grid;
		if (!exists) return thumbPlaceholder(t, "missing");
		if (state === "failed") return thumbPlaceholder(t, "no preview");
		if (state === undefined) {
			this.#thumbs.set(e.source, "loading");
			renderThumb(e, THUMB_COLS, THUMB_ROWS).then(
				png => {
					if (this.#disposed) return;
					this.#thumbs.set(e.source, placeImage(this.#tui, png, THUMB_COLS, THUMB_ROWS));
					this.#tui.requestRender();
				},
				() => {
					this.#thumbs.set(e.source, "failed");
					this.#tui.requestRender();
				},
			);
		}
		return thumbPlaceholder(t, "…");
	}

	#move(delta: number): void {
		this.#selected = Math.max(0, Math.min(this.#items().length - 1, this.#selected + delta));
		this.#tui.requestRender();
	}

	#setFilter(filter: string): void {
		this.#filter = filter;
		this.#selected = 0;
		this.#top = 0;
		this.#tui.requestRender();
	}

	#say(message: string): void {
		this.#status = message;
		this.#tui.requestRender();
	}

	#forget(): void {
		const e = this.#items()[this.#selected];
		if (!e) return;
		forgetInLibrary(e.source);
		this.#all = this.#all.filter(x => x.source !== e.source);
		this.#say(`forgot ${e.label} (the file stays)`);
	}

	/** Shows the viewer over the list; the list is hidden meanwhile so its thumbnails cannot bleed through. */
	#open(): void {
		const e = this.#items()[this.#selected];
		if (!e) return;
		if (e.file && !this.#info(e)) return this.#say(`file is gone: ${e.file}`);
		this.#viewing = true;
		let overlay: OverlayHandle | undefined;
		const viewer = new HtmlViewer(
			this.#tui,
			this.#theme,
			() => {
				overlay?.hide();
				viewer.dispose();
				this.#handle?.setHidden(false);
				this.#viewing = false;
				dequeue(e.source);
				this.#tui.requestRender();
			},
			e,
		);
		overlay = this.#tui.showOverlay(viewer, FULLSCREEN);
		this.#handle?.setHidden(true);
	}
}

async function openLibrary(ctx: ExtensionContext): Promise<void> {
	let library: ArtifactLibrary | undefined;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			library = new ArtifactLibrary(tui, theme, () => done(), ctx.cwd);
			return library;
		},
		{ overlay: true, overlayOptions: FULLSCREEN, onHandle: handle => library?.setHandle(handle) },
	);
}

// ── wiring ──────────────────────────────────────────────────────────────────

export default function htmlView(pi: ExtensionAPI): void {
	const z = pi.zod;
	void sweepCache().catch(() => {});
	let lastWritten: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		projectDir = ctx.cwd;
		if (!ctx.hasUI) return;
		// A new or resumed session starts without our widget; mount it again if the queue has items.
		mainUi = ctx.ui;
		cardMounted = false;
		refreshCard();
	});

	// /vibe narrows the director to read, todo and the vibe_* worker tools, and that list has no
	// room for extension tools; put show_artifact back before each turn. Leaving vibe restores the
	// toolset saved on entry, which already had it.
	pi.on("before_agent_start", async () => {
		const active = pi.getActiveTools();
		if (active.includes("vibe_spawn") && !active.includes("show_artifact")) await pi.setActiveTools([...active, "show_artifact"]);
	});

	pi.on("tool_result", (event, ctx) => {
		if ((event.toolName !== "write" && event.toolName !== "edit") || event.isError) return undefined;
		const p = event.input.path;
		if (typeof p !== "string" || !PREWARM_RE.test(p) || p.includes("://")) return undefined;
		lastWritten = path.resolve(ctx.cwd, p);
		// Connect early, so a view does not wait for omp's browser to start.
		if (ctx.hasUI) void getRenderer().catch(() => {});
		return undefined;
	});

	pi.registerTool({
		name: "show_artifact",
		label: "Show artifact",
		description:
			"Put a file the user should look at into their preview queue: an HTML report or mockup, Markdown, plain text or code, an image, a PDF, or an http(s) URL. A card with a thumbnail appears above the prompt; the user opens it inside omp with alt+o or a click, and it stays in their Artifact Library afterwards. Returns at once. Afterwards tell the user it is in their preview queue instead of describing how to open the file.",
		parameters: z.object({
			path: z.string().describe("File (relative to the working directory, or absolute) or an http(s) URL"),
			title: z.string().optional().describe("Card title; defaults to the file name"),
		}),
		approval: "read",
		loadMode: "essential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.hasUI) mainUi = ctx.ui;
			const target = resolveTarget(params.path, ctx.cwd, params.title);
			if (typeof target === "string") return { content: [{ type: "text", text: target }], isError: true };
			recordInLibrary(target, ctx.cwd);
			if (!mainUi || notKitty()) {
				return {
					content: [{ type: "text", text: `No preview queue in this session (no kitty UI); added to the Artifact Library. The file is ${target.source}.` }],
					isError: true,
				};
			}
			const queued = enqueue(target);
			return {
				content: [
					{
						type: "text",
						text: `Added ${target.label} to the user's preview queue (${queued} queued). Its card sits above the prompt; ${SHORTCUT} or a click opens it.`,
					},
				],
				details: { source: target.source, kind: target.kind, queued },
			};
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the newest artifact in the preview queue",
		handler: async ctx => {
			if (!ctx.hasUI || notKitty()) return;
			const head = queue[0];
			if (head) await viewAndRecord(ctx, head);
			else ctx.ui.notify(`the preview queue is empty (${LIBRARY_SHORTCUT} opens the library)`, "info");
		},
	});

	pi.registerShortcut(DISMISS_SHORTCUT, {
		description: "Dismiss the newest artifact in the preview queue without opening it",
		handler: () => {
			if (queue[0]) dequeue(queue[0].source);
		},
	});

	pi.registerShortcut(LIBRARY_SHORTCUT, {
		description: "Open the Artifact Library",
		handler: async ctx => {
			if (ctx.hasUI && !notKitty()) await openLibrary(ctx);
		},
	});

	pi.registerCommand("artifacts", {
		description: "Artifact Library: every artifact shown or viewed, with thumbnails",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (notKitty()) return ctx.ui.notify("the library needs kitty graphics (kitty, Ghostty)", "error");
			await openLibrary(ctx);
		},
	});

	pi.registerCommand("view", {
		description: "View a file or URL inside omp (HTML, Markdown, text, image, PDF); bare: the newest queued artifact",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (notKitty()) {
				ctx.ui.notify("/view needs kitty graphics with Unicode placeholders (kitty, Ghostty)", "error");
				return;
			}
			const arg = args.trim() || (queue[0]?.source ?? lastWritten);
			if (!arg) {
				ctx.ui.notify("usage: /view <file | URL> (queue empty, nothing written yet)", "error");
				return;
			}
			const target = queue.find(q => q.source === arg) ?? resolveTarget(arg, ctx.cwd);
			if (typeof target === "string") {
				ctx.ui.notify(target, "error");
				return;
			}
			await viewAndRecord(ctx, target);
		},
	});
}
