import AiTagger from "./main";
import { App, PluginSettingTab, Setting, TextAreaComponent, ToggleComponent, DropdownComponent, TextComponent } from 'obsidian';
import { MODEL_CONFIGS, COMPANIES } from './model-config';

export class AiTaggerSettingTab extends PluginSettingTab {
    plugin: AiTagger;

    constructor(app: App, plugin: AiTagger) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private addApiKeySetting(containerEl: HTMLElement, companyKey: keyof typeof COMPANIES) {
        console.log('Company Key passed in:', companyKey);
        const providerConfig = MODEL_CONFIGS.find(config => config.company === companyKey);
        console.log('Found config:', providerConfig);
        if (!providerConfig) return;

        new Setting(containerEl)
            .setName(`${COMPANIES[companyKey]} API Key`)
            .setDesc(`Your API key for ${COMPANIES[companyKey]}`)
            .addText(text =>
                text
                    .setPlaceholder('Enter API key')
                    .setValue(this.plugin.settings[`${providerConfig.provider}ApiKey`])
                    .onChange(async (value) => {
                        this.plugin.settings[`${providerConfig.provider}ApiKey`] = value;
                        await this.plugin.saveSettings();
                    })
            );
    }

    // display() is where you build the content for the settings tab.
    display(): void {
        const { containerEl: containerElement } = this;
        containerElement.empty();

        // Add API key settings dynamically
        (Object.keys(COMPANIES) as (keyof typeof COMPANIES)[]).forEach(companyKey => {
            this.addApiKeySetting(containerElement, companyKey);
        });

        const modelOptions = Object.fromEntries(
            MODEL_CONFIGS.map(model => [
                model.modelId,
                `${COMPANIES[model.company]} ${model.modelName}`
            ])
        );

        // Add allowed tags setting
        new Setting(containerElement)
            .setName('Allowed Tags')
            .setDesc('Enter tags that are allowed to be used (one per line, include # prefix)')
            .addTextArea((text: TextAreaComponent) => {
                text.inputEl.style.height = '150px';
                text.setValue(this.plugin.settings.allowedTags?.join('\n') || '')
                    .onChange(async (value: string) => {
                        const tags = value.split('\n')
                            .map((tag: string) => tag.trim())
                            .filter((tag: string) => tag.length > 0);
                        this.plugin.settings.allowedTags = tags;
                        await this.plugin.saveSettings();
                    });
            });

        // Add custom system prompt toggle
        new Setting(containerElement)
            .setName('Use Custom System Prompt')
            .setDesc('Enable to use a custom system prompt instead of the default one')
            .addToggle((toggle: ToggleComponent) => {
                toggle.setValue(this.plugin.settings.useCustomSystemPrompt || false)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.useCustomSystemPrompt = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Add custom system prompt textarea
        new Setting(containerElement)
            .setName('Custom System Prompt')
            .setDesc('Enter your custom system prompt for the AI model')
            .addTextArea((text: TextAreaComponent) => {
                text.inputEl.style.height = '200px';
                text.setValue(this.plugin.settings.customSystemPrompt || '')
                    .onChange(async (value: string) => {
                        this.plugin.settings.customSystemPrompt = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerElement)
            .setName('Model')
            .setDesc('Pick the model you would like to use')
            .addDropdown(dropDown => {
                dropDown.addOptions(modelOptions);
                dropDown.setValue(this.plugin.settings.model); // Set the value here
                dropDown.onChange(async (value) => {
                    this.plugin.settings.model = value;
                    await this.plugin.saveSettings();
                });
            });

        // Override the default base URL for the model's API, leave blank if not using a proxy or service emulator.
        // Base URL path for API requests, leave blank if not using a proxy or service emulator.
        new Setting(containerElement)
            .setName('Custom Base URL')
            .setDesc('Override the default base URL for the model\'s API.')
            .addToggle(toggle => 
                toggle
                    .setValue(this.plugin.settings.useCustomBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.useCustomBaseUrl = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addText(text =>
                text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(this.plugin.settings.customBaseUrl)
                    // Update the settings object whenever the value of the text field changes, and then save it to disk:
                    .onChange(async (value) => {
                        this.plugin.settings.customBaseUrl = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerElement)
            .setName('Lowercase Mode')
            .setDesc('If enabled all tags will be generated with lowercase characters.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.lowerCaseMode)
                    .onChange(async (value) => {
                        this.plugin.settings.lowerCaseMode = value;
                        await this.plugin.saveSettings();
                    }),
            );
    }
}