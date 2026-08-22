import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceDir = process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR;
if (!sourceDir) throw new Error("TOKEN_FREE_GATEWAY_SOURCE_DIR nao informado.");

const playwrightUrl = pathToFileURL(
	join(sourceDir, "node_modules", "playwright-core", "index.mjs"),
).href;
const { chromium } = await import(playwrightUrl);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const contexts = browser.contexts();
let removidos = 0;

for (const context of contexts) {
	const cookies = await context.cookies();
	for (const cookie of cookies) {
		if (!/(^|\.)claude\.ai$/i.test(cookie.domain)) continue;
		await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
		removidos += 1;
	}

	const pages = context.pages();
	const page = pages.find((item) => {
		try {
			return /(^|\.)claude\.ai$/i.test(new URL(item.url()).hostname);
		} catch {
			return false;
		}
	}) ?? (await context.newPage());
	await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 30_000 });
	await page.bringToFront();
}

console.log(`Sessao do Claude removida do Chrome isolado (${removidos} cookies).`);
process.exit(0);
