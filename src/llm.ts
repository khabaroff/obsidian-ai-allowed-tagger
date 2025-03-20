import { Notice } from 'obsidian';
import AiTagger from './main';
import { join } from 'path';
import { z } from "zod";

import { ModelConfig } from './model-config'
import { ModelService } from './model-service';
import { getTagsString } from './utils';
import { systemMessage } from './system-prompt';

import { Runnable } from '@langchain/core/runnables';
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { FewShotChatMessagePromptTemplate } from "@langchain/core/prompts";
import { initChatModel } from "langchain/chat_models/universal";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { CallbackHandler } from "langfuse-langchain";
import { RunnableSequence } from "@langchain/core/runnables";

const functionSchema = {
    name: "generate_tags",
    description: "Generate exactly 1-10 tags from the allowed list for the document",
    parameters: {
        type: "object",
        properties: {
            tags: {
                type: "array",
                items: { 
                    type: "string",
                    pattern: "^#[\\w-]+$"
                },
                minItems: 1,
                maxItems: 10,
                description: "An array of 1-10 tags from the allowed list, each starting with # prefix"
            }
        },
        required: ["tags"]
    }
};

const tagger = z.object({
    tags: z.array(z.string())
        .length(5)
        .describe("An array of exactly 5 tags from the allowed tags list in the form #<category> that best categorizes the document.")
});

type TaggerOutput = z.infer<typeof tagger>;

export class LLM {
    modelId: string;
    apiKey: string;
    plugin: AiTagger;
    baseUrl: string | null;
    modelConfig: ModelConfig;
    prompt: ChatPromptTemplate;
    model: Runnable;

    constructor(modelId: string, apiKey: string, plugin: AiTagger, baseURL: string | null = null) {
        this.modelId = modelId;
        this.apiKey = apiKey;
        this.plugin = plugin;
        this.baseUrl = baseURL;
        this.modelConfig = ModelService.getModelById(modelId);
    }

    static async initialize(modelId: string, apiKey: string, plugin: AiTagger, baseUrl: string | null = null): Promise<LLM> {
        const instance = new LLM(modelId, apiKey, plugin, baseUrl);
        instance.model = await instance.getModel();
        instance.prompt = await instance.getPrompt();
        return instance;
    }

    async getModel() {
        try {
            let model: BaseChatModel = await initChatModel(this.modelId, {
                modelProvider: this.modelConfig.provider,
                temperature: 0,
                apiKey: this.apiKey,
                baseUrl: this.baseUrl,
                timeout: 10000,
                modelName: this.modelConfig.modelId, // Ensure correct model ID is used
                clientOptions: {
                    dangerouslyAllowBrowser: true,
                },
            });

            // Add function calling for OpenAI models
            const functionSchema = {
                name: "generate_tags",
                description: "Generate tags for the document",
                parameters: {
                    type: "object",
                    properties: {
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "An array of 1-10 tags starting with #",
                            minItems: 1,
                            maxItems: 10
                        }
                    },
                    required: ["tags"]
                }
            };

            if (this.modelConfig.provider === "openai") {
                // For OpenAI models, use function calling
                const openAIModel = model as ChatOpenAI;
                const modelWithFunctions = openAIModel.bind({
                    functions: [functionSchema],
                    function_call: { name: "generate_tags" }
                });

                // Create a sequence that parses the output
                const parseResponse = (response: any): TaggerOutput => {
                    if (!response || typeof response !== 'object') {
                        throw new Error('Invalid response format');
                    }

                    // Handle OpenAI function calling response format
                    if (response.additional_kwargs?.function_call && response.additional_kwargs.function_call.arguments) {
                        try {
                            const args = JSON.parse(response.additional_kwargs.function_call.arguments);
                            return tagger.parse(args);
                        } catch (e) {
                            throw new Error(`Failed to parse function response: ${e.message}`);
                        }
                    }

                    // Try direct response format
                    try {
                        return tagger.parse(response);
                    } catch (e) {
                        throw new Error(`Invalid response format: ${e.message}`);
                    }
                };

                return RunnableSequence.from([
                    modelWithFunctions,
                    parseResponse
                ]);
            }
            
            // For other models, create a sequence that parses the output
            const parseResponse = (response: any): TaggerOutput => {
                if (!response || typeof response !== 'object') {
                    throw new Error('Invalid response format');
                }

                // Try to extract tags from various response formats
                let tagsData = response;
                
                // If response is in message format
                if (response.content) {
                    try {
                        tagsData = JSON.parse(response.content);
                    } catch (e) {
                        // If not JSON, try to extract tags from text
                        const tags = response.content
                            .split(/[\n,]/) // Split by newlines or commas
                            .map((s: string) => s.trim())
                            .filter((s: string) => s.startsWith('#'))
                            .slice(0, 5);
                        tagsData = { tags };
                    }
                }

                try {
                    return tagger.parse(tagsData);
                } catch (e) {
                    throw new Error(`Invalid response format: ${e.message}`);
                }
            };

            return RunnableSequence.from([
                model,
                parseResponse
            ]);
        } catch (error) {
            console.error(`Error while instantiating model: ${this.modelConfig.company} ${this.modelConfig.modelId}`, error.message);
            throw new Error(`Error while instantiating model: ${this.modelConfig.company} ${this.modelConfig.modelId}`);
        }
    }

    async getPrompt(): Promise<ChatPromptTemplate> {
        try {
            console.log("System message loaded:", systemMessage.substring(0, 100) + "...");
            
            // Create a simple prompt template for OpenAI function calling
            const prompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(systemMessage),
                HumanMessagePromptTemplate.fromTemplate("ALLOWED TAGS:\n```\n{inputTags}\n```\n\nDOCUMENT:\n```\n{document}\n```")
            ]);

            return prompt;
        } catch (error: any) {
            console.error("Error loading prompt:", error);
            console.error("Plugin dir:", this.plugin.manifest.dir);
            throw new Error(`Failed to load system prompt: ${error.message}`);
        }
    }

    isTextWithinLimit(prompt: string, text: string): boolean {
        // Define token limits for the models
        const tokenLimit: number = this.modelConfig.tokenLimit;

        // Calculate the number of tokens based on average token length (4 characters)
        const promptTokens = prompt.length / 4;
        const textTokens = text.length / 4;

        const totalTokens = promptTokens + textTokens;

        return totalTokens <= tokenLimit;
    }

    formatOutputTags(tags: string[], newTags: string[], existingTags: string[]): string[] {
        const tagsArray = [...tags, ...newTags]
        // remove existing tags from tagsArray
        const filteredTagsArray = tagsArray.filter(tag =>
            !existingTags.some(existingTag =>
                existingTag.toLowerCase() === tag.toLowerCase()
            )
        )

        return filteredTagsArray
    }

    async generateTags(documentText: string, existingTags: string[]): Promise<string[]> {
        const allowedTags = this.plugin.settings.allowedTags || [];

        // Validate that we have allowed tags configured
        if (!allowedTags.length) {
            throw new Error('No allowed tags configured. Please add allowed tags in plugin settings.');
        }

        try {
            // For OpenAI models, use function calling directly
            if (this.modelConfig.provider === "openai") {
                try {
                    const openAIModel = new ChatOpenAI({
                        modelName: this.modelConfig.modelId,
                        temperature: 0,
                        openAIApiKey: this.apiKey,
                        maxTokens: 500
                    });

                    // Create a structured system prompt that includes allowed tags
                    const systemPromptWithTags = `${systemMessage}\n\nALLOWED TAGS:\n${allowedTags.join('\n')}`;
                    
                    const messages = [
                        { role: "system", content: systemPromptWithTags },
                        { role: "user", content: `Document to analyze:\n\`\`\`\n${documentText}\n\`\`\`` }
                    ];

                    console.log('=== SENDING TO MODEL ===');
                    console.log('Function schema:', JSON.stringify(functionSchema, null, 2));
                    console.log('Allowed tags:', allowedTags.slice(0, 5).join(', ') + '...');

                    const response = await openAIModel.invoke(messages, {
                        functions: [functionSchema],
                        function_call: { name: "generate_tags" }
                    });

                    console.log('=== MODEL RESPONSE ===');
                    console.log('Full response type:', typeof response);
                    
                    // Extract function call from the response
                    const functionCall = response.additional_kwargs?.function_call;
                    
                    if (!functionCall || !functionCall.arguments) {
                        throw new Error('No function call in response');
                    }
                    
                    try {
                        // Parse the function call arguments
                        const args = JSON.parse(functionCall.arguments);
                        console.log('Parsed args:', JSON.stringify(args, null, 2));
                        
                        // Validate the tags with Zod schema
                        const parsedData = tagger.parse(args);
                        
                        // Check if all tags are in the allowed list
                        const validTags = parsedData.tags.filter(tag => 
                            allowedTags.some(allowedTag => 
                                allowedTag.toLowerCase() === tag.toLowerCase()
                            )
                        );
                        
                        if (validTags.length !== 5) {
                            throw new Error(`Only ${validTags.length} of 5 tags are from the allowed list`);
                        }
                        
                        // Remove any existing tags that might conflict
                        return this.formatOutputTags(validTags, [], existingTags);
                    } catch (e) {
                        if (e instanceof z.ZodError) {
                            console.error('Zod validation error:', e.errors);
                            throw new Error(`Invalid tags format: ${e.errors.map(err => err.message).join(', ')}`);
                        }
                        throw e;
                    }
                } catch (e) {
                    console.error('Error in OpenAI tag generation:', e);
                    throw e;
                }
            }

            // For other models, use standard prompt template
            const updatedPrompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(
                    `${systemMessage}\n\nIMPORTANT: You must ONLY use tags from this allowed list:\n${allowedTags.join('\n')}\n`
                ),
                HumanMessagePromptTemplate.fromTemplate("Document to analyze:\n```\n{text}\n```")
            ]);

            const response = await updatedPrompt.pipe(this.model).invoke({
                text: documentText
            });

            // Parse the response
            if (typeof response === 'string') {
                const tags = response
                    .split(/[\n,]/) // Split by newlines or commas
                    .map((tag: string): string => tag.trim())
                    .filter((tag: string): boolean => tag.startsWith('#'))
                    .slice(0, 5);
                return tags;
            }

            if (!response || !response.tags || !Array.isArray(response.tags)) {
                throw new Error('Invalid response format from model');
            }

            // Validate response has exactly 5 tags
            if (!response.tags || !Array.isArray(response.tags) || response.tags.length !== 5) {
                throw new Error('Model must return exactly 5 tags');
            }

            // Filter and normalize tags
            const validTags = response.tags
                .map((tag: string): string => tag.startsWith('#') ? tag : `#${tag}`)
                .filter((tag: string): boolean => allowedTags.some((allowedTag: string): boolean => 
                    allowedTag.toLowerCase() === tag.toLowerCase()
                ));

            // Validate all tags are from allowed list
            if (validTags.length !== 5) {
                throw new Error('All 5 tags must be from the allowed tags list');
            }

            // Remove any existing tags that might conflict
            return this.formatOutputTags(validTags, [], existingTags);
        } catch (error: any) {
            // Handle Ollama-specific errors first
            if (this.modelConfig.provider === 'ollama') {
                const baseUrl = this.baseUrl?.trim();
                if (!baseUrl) {
                    throw new Error('Error: Base URL not set. Please configure in settings');
                }
                throw new Error('Error: Check if Ollama is running and model is installed');
            }

            // Log detailed error information
            console.error('Error details:', {
                model: `${this.modelConfig.company} ${this.modelConfig.modelId}`,
                provider: this.modelConfig.provider,
                baseUrl: this.baseUrl,
                error: error.message,
                stack: error.stack,
                settings: {
                    model: this.plugin.settings.model,
                    hasApiKey: !!this.plugin.settings[`${this.modelConfig.provider}ApiKey`]
                }
            });

            // Check for common errors
            if (!this.plugin.settings[`${this.modelConfig.provider}ApiKey`]) {
                throw new Error('API Key is not configured. Please add your API key in plugin settings.');
            }

            // Check for CORS-related errors
            if (this.modelConfig.provider !== 'ollama' && this.baseUrl && (error.message?.includes('CORS') || error.message?.includes('Access-Control-Allow-Headers'))) {
                throw new Error('Error: Is "Custom Base URL" supported by this model?');
            } else if (this.modelConfig.provider !== 'ollama' && this.baseUrl) {
                throw new Error('Error: Base URL is set, remove it if not using a proxy or service emulator');
            }

            throw new Error(`Error while generating tags: ${error.message}`);
        }
    }
}