import type { ProviderDefinition } from "../types.ts";
import type { ChatGPTWebAuth } from "./auth.ts";
import { loginChatGPTWeb } from "./auth.ts";
import { ChatGPTWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "chatgpt-web",
	name: "ChatGPT Web",
	models: [
		{ id: "gpt-5.6", name: "GPT-5.6 Sol" },
	],
	factory: (credentials) => new ChatGPTWebClient(credentials as ChatGPTWebAuth),
	loginFn: loginChatGPTWeb,
};
