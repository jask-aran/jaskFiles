/**
 * Oracle Extension - Get a second opinion from another AI model
 *
 * Usage:
 *   /oracle <prompt>              - Opens model picker, then queries
 *   /oracle -m gpt-4o <prompt>    - Direct to specific model
 *   /oracle -f file.ts <prompt>   - Include file(s) in context
 *
 * Stay on your main model (e.g., Claude Opus) and get tie-breaker opinions!
 */

import { complete, type UserMessage, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	BorderedLoader,
	SettingsManager,
	convertToLlm,
	getAgentDir,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

interface AvailableModel {
	provider: string;
	modelId: string;
	name: string;
	model: Model;
}

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isAlias(id: string): boolean {
	if (id.endsWith("-latest")) return true;
	return !/-\d{8}$/.test(id);
}

function findExactModelReferenceMatch(modelReference: string, availableModels: Model[]): Model | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) return undefined;

	const normalizedReference = trimmedReference.toLowerCase();
	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference
	);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase()
			);
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchModel(modelPattern: string, availableModels: Model[]): Model | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) return exactMatch;

	const matches = availableModels.filter(
		(model) =>
			model.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			model.name?.toLowerCase().includes(modelPattern.toLowerCase())
	);
	if (matches.length === 0) return undefined;

	const aliases = matches.filter((model) => isAlias(model.id)).sort((a, b) => b.id.localeCompare(a.id));
	if (aliases.length > 0) return aliases[0];

	return matches.sort((a, b) => b.id.localeCompare(a.id))[0];
}

function parseModelPattern(pattern: string, availableModels: Model[]): { model?: Model; warning?: string } {
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) return { model: exactMatch };

	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) return {};

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);
	if (THINKING_LEVELS.has(suffix)) {
		return parseModelPattern(prefix, availableModels);
	}

	const result = parseModelPattern(prefix, availableModels);
	if (result.model) {
		return {
			model: result.model,
			warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
		};
	}
	return result;
}

function escapeRegex(char: string): string {
	return /[|\\{}()[\]^$+*.?]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(glob: string): RegExp {
	let regex = "^";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			regex += ".*";
			continue;
		}
		if (ch === "?") {
			regex += ".";
			continue;
		}
		if (ch === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end !== -1) {
				regex += glob.slice(i, end + 1);
				i = end;
				continue;
			}
		}
		regex += escapeRegex(ch);
	}
	regex += "$";
	return new RegExp(regex, "i");
}

function matchesGlob(value: string, pattern: string): boolean {
	return globToRegExp(pattern).test(value);
}

function resolveOracleModelScope(patterns: string[], availableModels: Model[]): Model[] {
	const scopedModels: Model[] = [];
	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (THINKING_LEVELS.has(suffix)) {
					globPattern = pattern.substring(0, colonIdx);
				}
			}
			const matchingModels = availableModels.filter((model) => {
				const fullId = `${model.provider}/${model.id}`;
				return matchesGlob(fullId, globPattern) || matchesGlob(model.id, globPattern);
			});
			for (const model of matchingModels) {
				if (!scopedModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
					scopedModels.push(model);
				}
			}
			continue;
		}

		const { model, warning } = parseModelPattern(pattern, availableModels);
		if (warning) console.warn(`Oracle: ${warning}`);
		if (!model) {
			console.warn(`Oracle: No models match pattern "${pattern}"`);
			continue;
		}
		if (!scopedModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
			scopedModels.push(model);
		}
	}
	return scopedModels;
}

/**
 * Oracle result display with add to context option
 */
class OracleResultComponent {
	private result: string;
	private modelName: string;
	private prompt: string;
	private selected: number = 0; // 0 = Yes, 1 = No
	private scrollOffset: number = 0;
	private onDone: (addToContext: boolean) => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;

	constructor(
		result: string,
		modelName: string,
		prompt: string,
		tui: { requestRender: () => void },
		onDone: (addToContext: boolean) => void
	) {
		this.result = result;
		this.modelName = modelName;
		this.prompt = prompt;
		this.tui = tui;
		this.onDone = onDone;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "n" || data === "N") {
			this.onDone(false);
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.onDone(this.selected === 0);
			return;
		}

		if (data === "y" || data === "Y") {
			this.onDone(true);
			return;
		}

		if (matchesKey(data, "left") || matchesKey(data, "right") || data === "h" || data === "l" || matchesKey(data, "tab")) {
			this.selected = this.selected === 0 ? 1 : 0;
			this.cachedWidth = 0;
			this.tui.requestRender();
		}

		// Scroll through result
		if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset++;
			this.cachedWidth = 0;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(80, width - 4);
		const contentWidth = boxWidth - 4;
		const maxResultLines = 15;

		const padLine = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const boxLine = (content: string): string => {
			const len = visibleWidth(content);
			const padding = Math.max(0, boxWidth - 2 - len);
			return dim("│ ") + content + " ".repeat(padding) + dim(" │");
		};

		// Wrap text to fit in box
		const wrapText = (text: string, maxWidth: number): string[] => {
			const wrapped: string[] = [];
			for (const paragraph of text.split("\n")) {
				if (paragraph.length <= maxWidth) {
					wrapped.push(paragraph);
				} else {
					let remaining = paragraph;
					while (remaining.length > maxWidth) {
						let breakPoint = remaining.lastIndexOf(" ", maxWidth);
						if (breakPoint === -1) breakPoint = maxWidth;
						wrapped.push(remaining.slice(0, breakPoint));
						remaining = remaining.slice(breakPoint + 1);
					}
					if (remaining) wrapped.push(remaining);
				}
			}
			return wrapped;
		};

		lines.push("");
		lines.push(padLine(dim("╭" + "─".repeat(boxWidth) + "╮")));
		lines.push(padLine(boxLine(bold(magenta(`🔮 Oracle Response (${this.modelName})`)))));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Show prompt
		const promptPreview = this.prompt.length > contentWidth - 10
			? this.prompt.slice(0, contentWidth - 13) + "..."
			: this.prompt;
		lines.push(padLine(boxLine(dim("Q: ") + promptPreview)));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Show result with scrolling
		const resultLines = wrapText(this.result, contentWidth);
		const visibleLines = resultLines.slice(this.scrollOffset, this.scrollOffset + maxResultLines);
		
		for (const line of visibleLines) {
			lines.push(padLine(boxLine(line)));
		}

		// Padding if result is short
		for (let i = visibleLines.length; i < Math.min(maxResultLines, 5); i++) {
			lines.push(padLine(boxLine("")));
		}

		// Scroll indicator
		if (resultLines.length > maxResultLines) {
			const scrollInfo = dim(` ↑↓ scroll (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxResultLines, resultLines.length)}/${resultLines.length})`);
			lines.push(padLine(boxLine(scrollInfo)));
		}

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Add to context prompt
		lines.push(padLine(boxLine(bold("Add to current conversation context?"))));
		lines.push(padLine(boxLine("")));

		// Buttons
		const yesBtn = this.selected === 0 
			? green(bold(" [ YES ] ")) 
			: dim("   YES   ");
		const noBtn = this.selected === 1 
			? yellow(bold(" [ NO ] ")) 
			: dim("   NO   ");
		
		const buttonLine = `       ${yesBtn}          ${noBtn}`;
		lines.push(padLine(boxLine(buttonLine)));
		lines.push(padLine(boxLine("")));

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("←→/Tab") + " switch  " + dim("Enter") + " confirm  " + dim("Y/N") + " quick")));
		lines.push(padLine(dim("╰" + "─".repeat(boxWidth) + "╯")));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

/**
 * Simple model picker component
 */
class ModelPickerComponent {
	private models: AvailableModel[];
	private selected: number = 0;
	private prompt: string;
	private files: string[];
	private onSelect: (model: AvailableModel) => void;
	private onCancel: () => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;

	constructor(
		models: AvailableModel[],
		prompt: string,
		files: string[],
		tui: { requestRender: () => void },
		onSelect: (model: AvailableModel) => void,
		onCancel: () => void
	) {
		this.models = models;
		this.prompt = prompt;
		this.files = files;
		this.tui = tui;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.onCancel();
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(this.models.length - 1, this.selected + 1);
			this.cachedWidth = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.onSelect(this.models[this.selected]);
		} else if (data >= "1" && data <= "9") {
			const idx = parseInt(data) - 1;
			if (idx < this.models.length) {
				this.onSelect(this.models[idx]);
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(60, width - 4);

		const padLine = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		const boxLine = (content: string): string => {
			const len = visibleWidth(content);
			const padding = Math.max(0, boxWidth - 2 - len);
			return dim("│ ") + content + " ".repeat(padding) + dim(" │");
		};

		lines.push("");
		lines.push(padLine(dim("╭" + "─".repeat(boxWidth) + "╮")));
		lines.push(padLine(boxLine(bold(magenta("🔮 Oracle - Second Opinion")))));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));

		// Prompt preview
		const maxPromptLen = boxWidth - 12;
		const promptPreview = this.prompt.length > maxPromptLen 
			? this.prompt.slice(0, maxPromptLen - 3) + "..." 
			: this.prompt;
		lines.push(padLine(boxLine(dim("Prompt: ") + promptPreview)));

		// Files
		if (this.files.length > 0) {
			const filesStr = this.files.map(f => cyan("@" + path.basename(f))).join(" ");
			lines.push(padLine(boxLine(dim("Files:  ") + filesStr)));
		}

		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("↑↓/jk navigate • 1-9 quick select • Enter send"))));
		lines.push(padLine(boxLine("")));

		// Model list
		for (let i = 0; i < this.models.length; i++) {
			const m = this.models[i];
			const num = i < 9 ? yellow(`${i + 1}`) : " ";
			const pointer = i === this.selected ? green("❯ ") : "  ";
			const name = i === this.selected ? green(bold(m.name)) : m.name;
			const provider = dim(` (${m.provider})`);
			lines.push(padLine(boxLine(`${pointer}${num}. ${name}${provider}`)));
		}

		lines.push(padLine(boxLine("")));
		lines.push(padLine(dim("├" + "─".repeat(boxWidth) + "┤")));
		lines.push(padLine(boxLine(dim("Esc") + " cancel")));
		lines.push(padLine(dim("╰" + "─".repeat(boxWidth) + "╯")));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("oracle", {
		description: "Get a second opinion from another AI model",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("oracle requires interactive mode", "error");
				return;
			}

			// Resolve candidate models from enabledModels when configured,
			// otherwise fall back to all available authenticated models.
			const settings = SettingsManager.create(ctx.cwd, getAgentDir());
			const enabledModels = settings.getEnabledModels() ?? [];
			const availableRegistryModels = ctx.modelRegistry.getAvailable();
			const candidateModels = enabledModels.length > 0
				? resolveOracleModelScope(enabledModels, availableRegistryModels)
				: availableRegistryModels;

			const availableModels: AvailableModel[] = [];
			const seen = new Set<string>();

			for (const model of candidateModels) {
				const key = `${model.provider}/${model.id}`;
				if (seen.has(key)) continue;
				seen.add(key);

				// Skip current model - we want a DIFFERENT opinion
				if (ctx.model && model.provider === ctx.model.provider && model.id === ctx.model.id) continue;
				if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;

				availableModels.push({
					provider: model.provider,
					modelId: model.id,
					name: model.name,
					model,
				});
			}

			if (availableModels.length === 0) {
				ctx.ui.notify("No alternative models available. Check API keys.", "error");
				return;
			}

			// Parse args
			const trimmedArgs = args?.trim() || "";
			if (!trimmedArgs) {
				ctx.ui.notify("Usage: /oracle <prompt> or /oracle -f file.ts <prompt>", "error");
				return;
			}

			let modelArg: string | undefined;
			const files: string[] = [];
			const promptParts: string[] = [];

			const tokens = trimmedArgs.split(/\s+/);
			let i = 0;
			while (i < tokens.length) {
				const token = tokens[i];
				if (token === "-m" || token === "--model") {
					i++;
					if (i < tokens.length) modelArg = tokens[i];
				} else if (token === "-f" || token === "--file") {
					i++;
					if (i < tokens.length) files.push(tokens[i]);
				} else {
					promptParts.push(...tokens.slice(i));
					break;
				}
				i++;
			}

			const prompt = promptParts.join(" ");
			if (!prompt) {
				ctx.ui.notify("No prompt provided", "error");
				return;
			}

			// If model specified directly, skip picker
			if (modelArg) {
				const found = availableModels.find(
					(m) => m.modelId === modelArg || 
					       m.modelId.includes(modelArg!) ||
					       m.name.toLowerCase().includes(modelArg!.toLowerCase())
				);
				if (!found) {
					ctx.ui.notify(`Model "${modelArg}" not available`, "error");
					return;
				}
				await executeOracle(pi, ctx, prompt, files, found);
				return;
			}

			// Show model picker
			const selectedModel = await ctx.ui.custom<AvailableModel | null>((tui, _theme, _kb, done) => {
				const picker = new ModelPickerComponent(
					availableModels,
					prompt,
					files,
					tui,
					(model) => done(model),
					() => done(null)
				);

				return {
					render: (w) => picker.render(w),
					invalidate: () => picker.invalidate(),
					handleInput: (data) => picker.handleInput(data),
				};
			});

			if (!selectedModel) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await executeOracle(pi, ctx, prompt, files, selectedModel);
		},
	});

	// Custom renderer for oracle responses
	pi.registerMessageRenderer("oracle-response", (message, options, theme) => {
		const { expanded } = options;
		const details = message.details || {};

		let text = theme.fg("accent", `🔮 Oracle (${details.modelName || "unknown"}):\n\n`);
		text += message.content;

		if (expanded && details.files?.length > 0) {
			text += "\n\n" + theme.fg("dim", `Files: ${details.files.join(", ")}`);
		}

		return new Text(text, 0, 0);
	});
}

async function executeOracle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	files: string[],
	model: AvailableModel
): Promise<void> {
	// Get conversation context from current session
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
	
	let conversationContext = "";
	if (messages.length > 0) {
		const llmMessages = convertToLlm(messages);
		conversationContext = serializeConversation(llmMessages);
	}

	// Build context from files
	let fileContext = "";
	for (const file of files) {
		try {
			const fullPath = path.resolve(ctx.cwd, file);
			const content = fs.readFileSync(fullPath, "utf-8");
			fileContext += `\n\n--- File: ${file} ---\n${content}`;
		} catch (err) {
			fileContext += `\n\n--- File: ${file} ---\n[Error reading file: ${err}]`;
		}
	}

	// Build full prompt with conversation context
	let fullPrompt = "";
	if (conversationContext) {
		fullPrompt += `## Current Conversation Context\n\n${conversationContext}\n\n`;
	}
	fullPrompt += `## Question for Second Opinion\n\n${prompt}`;
	if (fileContext) {
		fullPrompt += `\n\n## Additional Files${fileContext}`;
	}

	// Call the model
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `🔮 Asking ${model.name}...`);
		loader.onAbort = () => done(null);

		const doQuery = async () => {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: fullPrompt }],
				timestamp: Date.now(),
			};

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model.model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}

			const response = await complete(
				model.model,
				{
					systemPrompt: `You are providing a second opinion on a coding conversation. 
You have access to the full conversation context between the user and their primary AI assistant.
Your job is to:
1. Understand what they've been discussing
2. Answer the specific question they're asking you
3. Point out if you disagree with any decisions made
4. Be concise but thorough

Focus on being helpful and providing a fresh perspective.`,
					messages: [userMessage],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal }
			);

			if (response.stopReason === "aborted") {
				return null;
			}

			return response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		};

		doQuery()
			.then(done)
			.catch((err) => {
				console.error("Oracle error:", err);
				done(null);
			});

		return loader;
	});

	if (result === null) {
		ctx.ui.notify("Cancelled or failed", "warning");
		return;
	}

	// Show result and ask if user wants to add to context
	const addToContext = await ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
		const component = new OracleResultComponent(
			result,
			model.name,
			prompt,
			tui,
			(add) => done(add)
		);

		return {
			render: (w) => component.render(w),
			invalidate: () => component.invalidate(),
			handleInput: (data) => component.handleInput(data),
		};
	});

	if (addToContext) {
		// Add Oracle's response to the conversation
		pi.sendMessage({
			customType: "oracle-response",
			content: result,
			display: true,
			details: {
				model: model.modelId,
				modelName: model.name,
				files,
				prompt,
			},
		});
		ctx.ui.notify(`Oracle response added to context`, "success");
	} else {
		ctx.ui.notify(`Oracle response discarded`, "info");
	}
}
