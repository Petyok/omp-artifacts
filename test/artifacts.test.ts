import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Dynamic import on purpose: the library file and the render cache are fixed when the module
// loads, so the sandbox must be in the environment before that.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-artifacts-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
const A = await import("../src/artifacts.ts");

const files = path.join(root, "files");
const put = (name: string, data: string | Uint8Array) => fs.writeFileSync(path.join(files, name), data);

beforeAll(() => {
	fs.mkdirSync(files, { recursive: true });
	put("page.html", "<!doctype html><title>x</title>");
	put("notes.md", "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
	put("Makefile", "all:\n\techo <b>hi</b> <script>alert(1)</script>\n");
	put("shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
	put("doc.pdf", "%PDF-1.4");
	put("blob.bin", new Uint8Array([1, 0, 2, 3]));
});
afterAll(() => {
	setSystemTime();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveTarget", () => {
	test("detects the kind from the extension, else by content", () => {
		const kinds = ["page.html", "notes.md", "Makefile", "shot.png", "doc.pdf"].map(f => {
			const t = A.resolveTarget(f, files);
			return typeof t === "string" ? t : t.kind;
		});
		expect(kinds).toEqual(["html", "markdown", "text", "image", "pdf"]);
	});

	test("refuses binary files and missing paths with a reason", () => {
		expect(A.resolveTarget("blob.bin", files)).toContain("cannot show binary file");
		expect(A.resolveTarget("nope.md", files)).toContain("not a file");
	});

	test("accepts URLs, file:// URLs and absolute paths; title overrides the label", () => {
		const url = A.resolveTarget("https://example.com/x", files, "Example");
		expect(url).toMatchObject({ kind: "url", source: "https://example.com/x", label: "Example" });
		const viaFileUrl = A.resolveTarget(`file://${path.join(files, "notes.md")}`, "/");
		expect(viaFileUrl).toMatchObject({ kind: "markdown", label: "notes.md" });
	});
});

describe("pageUrl", () => {
	test("text is escaped, never executed", async () => {
		const t = A.resolveTarget("Makefile", files);
		if (typeof t === "string") throw new Error(t);
		const html = fs.readFileSync(fileURLToPath(await A.pageUrl(t)), "utf8");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)");
	});

	test("markdown becomes HTML with GFM tables", async () => {
		const t = A.resolveTarget("notes.md", files);
		if (typeof t === "string") throw new Error(t);
		const html = fs.readFileSync(fileURLToPath(await A.pageUrl(t)), "utf8");
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<table>");
	});
});

describe("library", () => {
	const target = (f: string) => {
		const t = A.resolveTarget(f, files);
		if (typeof t === "string") throw new Error(t);
		return t;
	};

	test("newest first; re-showing moves to the top and keeps the first-shown time", () => {
		setSystemTime(new Date(1_000));
		A.recordInLibrary(target("page.html"), files);
		setSystemTime(new Date(2_000));
		A.recordInLibrary(target("notes.md"), files);
		setSystemTime(new Date(3_000));
		// Queue items carry UI state; only the artifact fields may be stored.
		A.recordInLibrary({ ...target("page.html"), thumb: { imageId: 1 } } as never, files);
		const lib = A.loadLibrary();
		expect(lib.map(e => e.label)).toEqual(["page.html", "notes.md"]);
		expect(lib[0]).toMatchObject({ firstShownAt: 1_000, lastShownAt: 3_000 });
		expect(JSON.stringify(lib[0])).not.toContain("thumb");
	});

	test("forget removes only that entry", () => {
		A.forgetInLibrary(target("page.html").source);
		expect(A.loadLibrary().map(e => e.label)).toEqual(["notes.md"]);
	});

	test("a corrupted library file reads as empty instead of throwing", () => {
		fs.writeFileSync(path.join(root, "agent", "artifact-library.json"), "{not json");
		expect(A.loadLibrary()).toEqual([]);
		fs.writeFileSync(path.join(root, "agent", "artifact-library.json"), JSON.stringify([{ source: 1 }, null]));
		expect(A.loadLibrary()).toEqual([]);
	});
});
