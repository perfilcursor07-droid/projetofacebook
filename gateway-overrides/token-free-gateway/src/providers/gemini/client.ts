import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { StreamResult } from "../types.ts";
import type { GeminiWebAuth } from "./auth.ts";
import { parseGeminiStream } from "./stream.ts";

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function modelPattern(model?: string): RegExp | null {
	if (model === "gemini-flash-lite") return /Flash[-\s]?Lite/i;
	if (model === "gemini-flash") return /^(?!.*Lite).*Flash/i;
	if (model === "gemini-pro") return /\bPro\b/i;
	return null;
}

async function selectGeminiModel(page: Page, model?: string): Promise<void> {
	const wanted = modelPattern(model);
	if (!wanted) return;

	const directSelectors = [
		'button[aria-label*="model" i]',
		'[role="button"][aria-label*="model" i]',
		'button[class*="model-selector"]',
		'[data-test-id*="model-selector"]',
	];
	let picker = null;
	for (const selector of directSelectors) {
		const candidate = page.locator(`${selector}:visible`).last();
		if (await candidate.count()) {
			picker = candidate;
			break;
		}
	}
	if (!picker) {
		const buttons = page.locator('button:visible, [role="button"]:visible');
		for (let index = (await buttons.count()) - 1; index >= 0; index--) {
			const candidate = buttons.nth(index);
			const text = String(await candidate.innerText().catch(() => "")).trim();
			if (text.length <= 60 && /(Flash|Pro)/i.test(text)) {
				picker = candidate;
				break;
			}
		}
	}
	if (!picker) throw new Error("Gemini: seletor de modelo não foi encontrado na página.");

	const current = String(await picker.innerText().catch(() => "")).trim();
	if (wanted.test(current)) return;
	await picker.click();
	await delay(400);
	const options = page
		.locator('[role="menuitem"]:visible, [role="option"]:visible, [role="radio"]:visible, mat-option:visible')
		.filter({ hasText: wanted });
	if (!(await options.count())) {
		throw new Error(`Gemini: o modelo ${model} não está disponível para esta conta.`);
	}
	await options.last().click();
	await delay(500);
}

export class GeminiWebClient extends BaseDomClient<GeminiWebAuth> {
	readonly providerId = "gemini-web";

	protected readonly config: DomClientConfig = {
		hostKey: "gemini.google.com",
		startUrl: "https://gemini.google.com/app",
		cookieDomain: ".google.com",
		models: [
			{ id: "gemini-flash-lite", name: "Gemini Flash-Lite (Web)" },
			{ id: "gemini-flash", name: "Gemini Flash (Web)" },
			{ id: "gemini-pro", name: "Gemini Pro (Web)" },
		],
		pollIntervalMs: 2000,
		maxWaitMs: 120_000,
		stabilityThreshold: 2,
	};

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		await selectGeminiModel(page, params.model);
		const inputSelectors = [
			'textarea[placeholder*="Gemini"]',
			'textarea[placeholder*="问问"]',
			'textarea[aria-label*="prompt"]',
			"textarea",
			'div[role="textbox"]',
			'[contenteditable="true"]',
		];
		let inputHandle = null;
		for (const sel of inputSelectors) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle) throw new Error("Gemini: could not find chat input");

		await inputHandle.click();
		await delay(300);
		await pasteText(page, params.message, inputHandle);
		await delay(300);
		await page.keyboard.press("Enter");

		return this.pollForStableText(async () => {
			const result = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const getText = (el: Element): string => clean((el as HTMLElement).innerText ?? "");

				const sidebarRoot = document.querySelector('[aria-label*="对话"], [class*="sidebar"], nav');
				const inputEl = document.querySelector(
					'[contenteditable="true"], textarea, [placeholder*="Gemini"], [placeholder*="问问"]',
				);
				const inputRoot =
					inputEl?.closest("form") ??
					inputEl?.closest("[class*='input']") ??
					inputEl?.parentElement?.parentElement;
				const isExcluded = (el: Element) => sidebarRoot?.contains(el) || inputRoot?.contains(el);

				const noisePatterns = [
					"Ask Gemini",
					"问问 Gemini",
					"Enter a prompt",
					"输入提示",
					"需要我为你做些什么",
					"发起新对话",
					"我的内容",
					"设置和帮助",
					"制作图片",
					"创作音乐",
					"帮我学习",
					"随便写点什么",
					"给我的一天注入活力",
					"升级到 Google AI Plus",
					"正在加载",
					"复制",
					"分享",
					"修改",
					"朗读",
				];
				const isNoise = (t: string) =>
					t.length < 20 ||
					noisePatterns.some((p) => t.includes(p)) ||
					/^(你好|需要我|sage)/i.test(t);
				const stripTrailingUI = (t: string) =>
					t
						.replace(
							/\n?\s*(复制|分享|修改|朗读|Copy|Share|Edit|Read aloud|thumb_up|thumb_down|more_vert)[\s\n]*/gi,
							"",
						)
						.replace(/\s+$/, "");

				const main =
					document.querySelector("main") ??
					document.querySelector('[role="main"]') ??
					document.querySelector('[class*="chat"]') ??
					document.body;
				const scoped = main === document.body ? document : main;
				let text = "";

				const modelSelectors = [
					"model-response message-content",
					'[data-message-author="model"] .message-content',
					'[data-message-author="model"]',
					'[data-sender="model"]',
					'[class*="model-response"] [class*="markdown"]',
					'[class*="model-response"]',
					'[class*="response-content"] [class*="markdown"]',
					'[class*="response-content"]',
				];
				for (const sel of modelSelectors) {
					const els = scoped.querySelectorAll(sel);
					for (let i = els.length - 1; i >= 0; i--) {
						const el = els[i]!;
						if (isExcluded(el)) continue;
						const t = getText(el);
						if (t.length >= 30 && !isNoise(t)) {
							text = stripTrailingUI(t);
							break;
						}
					}
					if (text) break;
				}
				if (!text) {
					for (const sel of ['[class*="markdown"]', "article"]) {
						const els = scoped.querySelectorAll(sel);
						for (let i = els.length - 1; i >= 0; i--) {
							const el = els[i]!;
							if (isExcluded(el)) continue;
							const t = getText(el);
							if (t.length >= 30 && !isNoise(t)) {
								text = stripTrailingUI(t);
								break;
							}
						}
						if (text) break;
					}
				}
				return text;
			});
			return result;
		}, params.signal);
	}

	protected override formatSsePayload(text: string): string {
		return `data: ${JSON.stringify({ text })}\n`;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseGeminiStream(body, onDelta);
	}
}
