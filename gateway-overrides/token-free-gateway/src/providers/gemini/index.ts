import type { ProviderDefinition } from "../types.ts";
import { loginGeminiWeb } from "./auth.ts";
import { GeminiWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "gemini-web",
	name: "Gemini Web",
	models: [
		{ id: "gemini-flash-lite", name: "Gemini Flash-Lite (Web)" },
		{ id: "gemini-flash", name: "Gemini Flash (Web)" },
		{ id: "gemini-pro", name: "Gemini Pro (Web)" },
	],
	factory: (credentials) => new GeminiWebClient(credentials as any),
	loginFn: loginGeminiWeb,
};
