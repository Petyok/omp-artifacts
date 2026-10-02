/**
 * What an artifact is and how Chromium gets to see it, plus the persistent
 * Artifact Library. Used by index.ts.
 *
 * HTML and URLs load as they are. Everything else is wrapped into a generated
 * page under ~/.cache/omp-artifacts/render/: Markdown through Bun.markdown (GFM),
 * text/code as numbered lines, images centred on a checkerboard, PDFs as page
 * images from pdftoppm (poppler). Wrappers are rebuilt on every load, so a reload
 * in the viewer picks up edits.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type Kind = "html" | "markdown" | "text" | "image" | "pdf" | "url";

export interface Target {
	/** Absolute path or URL; the identity of an artifact in the queue and the library. */
	source: string;
	label: string;
	kind: Kind;
	/** Absolute path for local files. */
	file?: string;
}

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "omp-artifacts");
/** Next to omp's own state; `PI_CODING_AGENT_DIR` is omp's override of that directory. */
const LIBRARY_FILE = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "artifact-library.json");
/** Flat JSON rewritten on each change: fine for hundreds of entries; a database would be the next step. */
const LIBRARY_MAX = 500;
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const PDF_MAX_PAGES = 60;
const PDF_DPI = 110;

const KIND_BY_EXT: Record<string, Kind> = {
	html: "html",
	htm: "html",
	xhtml: "html",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	svg: "image",
	bmp: "image",
	ico: "image",
	pdf: "pdf",
};

export const KIND_LABEL: Record<Kind, string> = {
	html: "HTML",
	markdown: "Markdown",
	text: "Text",
	image: "Image",
	pdf: "PDF",
	url: "URL",
};

const hash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

const esc = (s: string): string =>
	s.replace(/[&<>"]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

/** `~/…` for paths under the home directory. */
export function tildify(p: string): string {
	const home = os.homedir();
	return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Text unless the first 8 KB hold a NUL byte. */
function looksTextual(file: string): boolean {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(8192);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		return !buf.subarray(0, n).includes(0);
	} finally {
		fs.closeSync(fd);
	}
}

/** Resolves a path (relative to `cwd`, `~` allowed) or URL, or returns why it cannot be shown. */
export function resolveTarget(arg: string, cwd: string, title?: string): Target | string {
	if (/^https?:\/\//i.test(arg)) return { source: arg, label: title || arg, kind: "url" };
	const raw = arg.startsWith("file://") ? new URL(arg).pathname : arg;
	const file = path.resolve(cwd, raw.replace(/^~(?=$|\/)/, os.homedir()));
	if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return `not a file: ${file}`;
	const kind = KIND_BY_EXT[path.extname(file).slice(1).toLowerCase()] ?? (looksTextual(file) ? "text" : undefined);
	if (!kind) return `cannot show binary file ${path.basename(file)} (supported: HTML, Markdown, text/code, images, PDF)`;
	return { source: file, label: title || path.basename(file), kind, file };
}

export interface FileInfo {
	bytes: number;
	mtimeMs: number;
}

/** Size and modification time of a local artifact; undefined when the file is gone. */
export function fileInfo(target: Target): FileInfo | undefined {
	if (!target.file) return undefined;
	const st = fs.statSync(target.file, { throwIfNoEntry: false });
	return st ? { bytes: st.size, mtimeMs: st.mtimeMs } : undefined;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── wrapper pages ───────────────────────────────────────────────────────────

const CSS = `
:root{--bg:#fbfaf7;--ink:#1f1e1b;--mute:#6f6b63;--line:#e4e0d6;--code:#f2efe7;--acc:#2e5aac}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;gap:6px 14px;align-items:baseline;flex-wrap:wrap;padding:14px 28px;border-bottom:1px solid var(--line);background:#fff;font:13px/1.4 ui-monospace,Menlo,monospace;color:var(--mute)}
header .k{background:var(--ink);color:var(--bg);padding:2px 7px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:11px}
header b{color:var(--ink);font-weight:700}
.md main{max-width:820px;margin:0 auto;padding:32px 28px 80px}
.md h1,.md h2,.md h3,.md h4{line-height:1.25;margin:1.6em 0 .6em}
.md h1{font-size:2em;margin-top:.3em}
.md h2{font-size:1.45em;border-bottom:1px solid var(--line);padding-bottom:.3em}
.md code{font:.88em ui-monospace,Menlo,monospace;background:var(--code);padding:.1em .35em;border-radius:3px}
.md pre{background:var(--code);padding:14px 16px;overflow:auto;border-radius:4px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.md pre code{background:none;padding:0;font-size:.85em}
.md table{border-collapse:collapse;margin:1em 0}
.md th,.md td{border:1px solid var(--line);padding:6px 12px;text-align:left;vertical-align:top}
.md th{background:var(--code)}
.md blockquote{margin:1em 0;padding:.1em 1em;border-left:4px solid var(--line);color:var(--mute)}
.md img{max-width:100%}
.md a{color:var(--acc)}
.md hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.md li.task-list-item{list-style:none}
.md li.task-list-item input{margin:0 .5em 0 -1.4em}
.txt pre{margin:0;padding:14px 0 40px;font:13px/1.55 ui-monospace,Menlo,monospace;tab-size:4;white-space:pre-wrap;word-break:break-word;counter-reset:l}
.txt .l{display:block;position:relative;padding:0 24px 0 72px;min-height:1.55em}
.txt .l::before{counter-increment:l;content:counter(l);position:absolute;left:0;width:52px;text-align:right;color:#b3aea3}
.txt .cut{padding:10px 72px;color:var(--mute);font:italic 13px ui-monospace,monospace}
.img main{display:grid;place-items:center;min-height:calc(100vh - 50px);padding:24px;background:conic-gradient(#e9e6df 25%,#f6f4ef 0 50%,#e9e6df 0 75%,#f6f4ef 0) 0 0/20px 20px}
.img img{max-width:100%;height:auto;box-shadow:0 0 0 1px var(--line)}
.pdf main{background:#e8e5de;display:grid;gap:22px;justify-items:center;padding:28px 16px 60px}
.pdf figure{margin:0;width:100%;max-width:900px}
.pdf img{width:100%;display:block;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.pdf figcaption{font:12px ui-monospace,monospace;color:var(--mute);text-align:center;margin-top:6px}
@media (max-width:600px){header{padding:10px 14px}.md main{padding:20px 16px 60px}.txt .l{padding-left:50px;padding-right:12px}.txt .l::before{width:36px}}
`;

function wrapperPage(target: Target, cls: string, body: string, note = ""): string {
	const file = target.file ?? target.source;
	const info = fileInfo(target);
	const meta = info ? `${formatBytes(info.bytes)} · ${new Date(info.mtimeMs).toLocaleString()}` : "";
	return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${esc(pathToFileURL(path.dirname(file)).href)}/"><title>${esc(target.label)}</title><style>${CSS}</style>
<body class="${cls}"><header><span class="k">${KIND_LABEL[target.kind]}</span><b>${esc(path.basename(file))}</b>
<span>${esc(tildify(path.dirname(file)))}</span><span>${esc(meta)}${esc(note)}</span></header><main>${body}</main></body></html>`;
}

async function renderPdfPages(file: string, mtimeMs: number): Promise<string[]> {
	const dir = path.join(CACHE_DIR, "render", `${hash(file)}-pdf`);
	const stamp = path.join(dir, ".mtime");
	let rendered = "";
	try {
		rendered = fs.readFileSync(stamp, "utf8");
	} catch {}
	if (rendered !== String(mtimeMs)) {
		if (!Bun.which("pdftoppm")) throw new Error("PDF needs pdftoppm (poppler) on PATH");
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		const proc = Bun.spawn(["pdftoppm", "-r", String(PDF_DPI), "-png", "-l", String(PDF_MAX_PAGES), file, path.join(dir, "p")], {
			stdout: "ignore",
			stderr: "pipe",
		});
		if ((await proc.exited) !== 0) throw new Error(`pdftoppm failed: ${(await new Response(proc.stderr).text()).trim()}`);
		fs.writeFileSync(stamp, String(mtimeMs));
	}
	return fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".png"))
		.sort()
		.map(f => path.join(dir, f));
}

/** The URL Chromium should load for `target`; builds the wrapper page when the kind needs one. */
export async function pageUrl(target: Target): Promise<string> {
	if (target.kind === "url") return target.source;
	const file = target.file ?? target.source;
	if (target.kind === "html") return pathToFileURL(file).href;
	const info = fileInfo(target);
	if (!info) throw new Error(`file is gone: ${file}`);
	let html: string;
	if (target.kind === "markdown") {
		html = wrapperPage(target, "md", Bun.markdown.html(fs.readFileSync(file, "utf8")));
	} else if (target.kind === "image") {
		html = wrapperPage(target, "img", `<img src="${esc(pathToFileURL(file).href)}" alt="">`);
	} else if (target.kind === "pdf") {
		const pages = await renderPdfPages(file, info.mtimeMs);
		const figures = pages.map(
			(p, i) => `<figure><img src="${esc(pathToFileURL(p).href)}" alt=""><figcaption>${i + 1} / ${pages.length}</figcaption></figure>`,
		);
		html = wrapperPage(target, "pdf", figures.join(""), pages.length >= PDF_MAX_PAGES ? ` · first ${PDF_MAX_PAGES} pages` : "");
	} else {
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(Math.min(info.bytes, TEXT_MAX_BYTES));
		fs.readSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		const lines = buf.toString("utf8").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
		const cut = info.bytes > TEXT_MAX_BYTES ? `<div class="cut">… cut at ${formatBytes(TEXT_MAX_BYTES)}</div>` : "";
		html = wrapperPage(target, "txt", `<pre>${lines.map(l => `<span class="l">${esc(l)}</span>`).join("")}</pre>${cut}`);
	}
	const out = path.join(CACHE_DIR, "render", `${hash(file)}.html`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, html);
	return pathToFileURL(out).href;
}

/** Where a rendered thumbnail of `target` at this pixel size is cached; changes when the file does. */
export function thumbCachePath(target: Target, widthPx: number, heightPx: number): string {
	const version = fileInfo(target)?.mtimeMs ?? 0;
	return path.join(CACHE_DIR, "thumbs", `${hash(`${target.source}|${version}|${widthPx}x${heightPx}`)}.png`);
}

// ── library ─────────────────────────────────────────────────────────────────

export interface LibraryEntry extends Target {
	/** Working directory of the session that showed it. */
	cwd: string;
	firstShownAt: number;
	lastShownAt: number;
}

function isEntry(e: unknown): e is LibraryEntry {
	if (!e || typeof e !== "object") return false;
	const r = e as Record<string, unknown>;
	return (
		typeof r.source === "string" &&
		typeof r.label === "string" &&
		typeof r.kind === "string" &&
		r.kind in KIND_LABEL &&
		typeof r.lastShownAt === "number" &&
		typeof r.firstShownAt === "number" &&
		typeof r.cwd === "string"
	);
}

/** All entries, most recently shown first. Re-read on every call: several omp processes share the file. */
export function loadLibrary(): LibraryEntry[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
		return Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => b.lastShownAt - a.lastShownAt) : [];
	} catch {
		return [];
	}
}

function saveLibrary(entries: LibraryEntry[]): void {
	fs.mkdirSync(path.dirname(LIBRARY_FILE), { recursive: true });
	const tmp = `${LIBRARY_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entries.slice(0, LIBRARY_MAX), null, 1));
	fs.renameSync(tmp, LIBRARY_FILE);
}

/** Adds `target` or moves it to the top, keeping its first-shown time. */
export function recordInLibrary(target: Target, cwd: string): void {
	const entries = loadLibrary();
	const now = Date.now();
	const old = entries.find(e => e.source === target.source);
	// Pick the fields: callers pass queue items that also carry kitty image state.
	const { source, label, kind, file } = target;
	const entry: LibraryEntry = { source, label, kind, file, cwd, firstShownAt: old?.firstShownAt ?? now, lastShownAt: now };
	saveLibrary([entry, ...entries.filter(e => e.source !== target.source)]);
}

export function forgetInLibrary(source: string): void {
	saveLibrary(loadLibrary().filter(e => e.source !== source));
}
