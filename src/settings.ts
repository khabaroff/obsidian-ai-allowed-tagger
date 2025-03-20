export interface AiTaggerSettings {
	openaiApiKey: string;
	mistralaiApiKey: string;
	anthropicApiKey: string;
	groqApiKey: string;
	googlegenaiApiKey: string;
	ollamaApiKey: string;
	model: string;
	useCustomBaseUrl: boolean;
	customBaseUrl: string;
	lowerCaseMode: boolean;
	allowedTags: string[];

	[key: `${string}ApiKey`]: string;
}