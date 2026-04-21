import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext, type ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { complete, type Context, type ImageContent, type TextContent } from "@mariozechner/pi-ai";
import { Container, SettingsList, Text, type SettingItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Context Culler Extension
 *
 * Reduces context bloat via:
 * 1. Immediate masking for navigation-heavy bash outputs (rg/grep/find/ls/tree/fd)
 * 2. Context-time pruning for old bash/read results
 * 3. Smart compaction with instructions biased toward goals, decisions, files, and next steps
 *
 * State is persisted alongside the active pi session file so /reload, /resume, and restarts
 * preserve the same masking experience, including peek_masked IDs.
 */

const MASK_THRESHOLD_CHARS = 1500;
const MIN_SAVINGS_CHARS = 300;
const RECENT_TURNS = 3;
const ARCHIVE_FILE_SUFFIX = ".context-culler.json";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = dirname(EXTENSION_DIR);
const AGENT_GUIDANCE_PATH = resolve(EXTENSION_DIR, "AGENT_GUIDANCE.md");
const SUMMARIZE_PROMPT_PATH = resolve(EXTENSION_DIR, "SUMMARIZE_PROMPT.md");
const GLOBAL_CONFIG_PATH = resolve(EXTENSION_DIR, "config.json");
const GLOBAL_SETTINGS_PATH = resolve(AGENT_DIR, "settings.json");

type ContentBlock = TextContent | ImageContent | { type?: string; text?: string; [key: string]: unknown };

type ArchivedResult = {
  toolCallId: string;
  toolName: string;
  originalChars: number;
  maskedChars: number;
  reason: string;
  original: ContentBlock[];
  path?: string;
};

type PersistedState = {
  version: 1;
  readFiles: Array<[string, string]>;
  modifiedFiles: string[];
  archive: ArchivedResult[];
  llmSummaries: Array<[string, string]>;
  llmSummaryErrors: Array<[string, string]>;
};

type GlobalConfig = {
  summarizerModel?: string | null;
};

type CompressionPolicy = {
  shouldMask: boolean;
  keepFirst: number;
  keepLast: number;
  reason: string;
};

function asContentBlocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function getContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if ((block as any).type === "text" && typeof (block as any).text === "string") return (block as any).text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isMaskedText(text: string): boolean {
  return text.startsWith("[context-culler:");
}

function getArchivedText(entry: ArchivedResult | undefined): string {
  return entry ? getContentText(entry.original) : "";
}

function buildMaskedMarker(id: string, reason: string, body: string): string {
  const prefix = `[context-culler: ${reason} | peek_masked("${id}")]`;
  return body.trim() ? `${prefix}\n${body.trim()}` : prefix;
}

function compressLines(text: string, keepFirst: number, keepLast: number, reason: string, id: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= keepFirst + keepLast + 1) {
    return buildMaskedMarker(id, reason, text);
  }

  const head = lines.slice(0, keepFirst);
  const tail = keepLast > 0 ? lines.slice(-keepLast) : [];
  const omitted = lines.length - head.length - tail.length;
  const summary = [
    ...head,
    `[context-culler: ${omitted} lines omitted — ${reason} | peek_masked("${id}")]`,
    ...tail,
  ].join("\n");
  return summary;
}

function isNavigationCommand(command: string): boolean {
  return /^\s*(rg|grep|find|fd|ls|tree)\b/.test(command);
}

function getImmediatePolicy(event: ToolResultEvent, textLength: number): CompressionPolicy {
  if (textLength < MASK_THRESHOLD_CHARS) {
    return { shouldMask: false, keepFirst: 0, keepLast: 0, reason: "" };
  }

  if (event.toolName === "bash") {
    const command = String((event.input as any)?.command ?? "");
    if (isNavigationCommand(command)) {
      return { shouldMask: true, keepFirst: 20, keepLast: 20, reason: `many ${command.trim().split(/\s+/)[0]} results` };
    }
  }

  return { shouldMask: false, keepFirst: 0, keepLast: 0, reason: "" };
}

function getBashContextPolicy(textLength: number, isError: boolean): CompressionPolicy {
  if (textLength < MASK_THRESHOLD_CHARS) {
    return { shouldMask: false, keepFirst: 0, keepLast: 0, reason: "" };
  }
  return {
    shouldMask: true,
    keepFirst: isError ? 60 : 35,
    keepLast: isError ? 60 : 35,
    reason: isError ? "old bash output (preserving head/tail around failure)" : "old bash output",
  };
}

function getReadContextPolicy(textLength: number): CompressionPolicy {
  if (textLength < MASK_THRESHOLD_CHARS) {
    return { shouldMask: false, keepFirst: 0, keepLast: 0, reason: "" };
  }
  return { shouldMask: true, keepFirst: 80, keepLast: 30, reason: "old read result" };
}

function getRecentTurnStartIndex(messages: any[]): number {
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      userTurnsSeen += 1;
      if (userTurnsSeen === RECENT_TURNS) return i;
    }
  }
  return -1;
}

function sanitizePath(rawPath: string): string {
  return rawPath.replace(/^@+/, "").trim();
}

async function normalizeToolPath(rawPath: string, cwd: string): Promise<string | undefined> {
  const cleaned = sanitizePath(rawPath);
  if (!cleaned) return undefined;
  const absolute = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  try {
    return await fs.realpath(absolute);
  } catch {
    return absolute;
  }
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function safeParseState(text: string): PersistedState | null {
  try {
    const parsed = JSON.parse(text) as PersistedState & { summarizerModel?: string | null };
    if (parsed && parsed.version === 1) {
      const { version, readFiles, modifiedFiles, archive, llmSummaries, llmSummaryErrors } = parsed;
      return {
        version,
        readFiles: readFiles ?? [],
        modifiedFiles: modifiedFiles ?? [],
        archive: archive ?? [],
        llmSummaries: llmSummaries ?? [],
        llmSummaryErrors: llmSummaryErrors ?? [],
      };
    }
  } catch {
    // ignore malformed state
  }
  return null;
}

function safeParseJsonObject<T extends object>(text: string): T | null {
  try {
    const parsed = JSON.parse(text) as T;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore malformed json
  }
  return null;
}

function stripThinkingSuffix(modelRef: string): string {
  return modelRef.replace(/:(minimal|low|medium|high|xhigh)$/i, "");
}

function parseEnabledModelsSettings(text: string | null): string[] | undefined {
  if (!text) return undefined;
  const parsed = safeParseJsonObject<{ enabledModels?: unknown }>(text);
  if (!parsed || parsed.enabledModels === undefined) return undefined;
  if (!Array.isArray(parsed.enabledModels)) return undefined;
  return parsed.enabledModels.filter((value): value is string => typeof value === "string");
}

function validateSummary(summary: string, originalText: string): string | null {
  const trimmed = summary.trim();
  if (!trimmed) return "Summarizer returned no text.";
  if (isMaskedText(trimmed)) return "Summarizer returned a masked marker instead of a summary.";

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (originalText.length >= MASK_THRESHOLD_CHARS) {
    if (trimmed.length < 80) return `Summarizer response too short (${trimmed.length} chars).`;
    if (lines.length < 2) return `Summarizer response too short (${lines.length} non-empty line).`;
  }

  const lastChar = trimmed.at(-1) ?? "";
  if (["`", "(", "[", "{", ":"].includes(lastChar)) {
    return `Summarizer response appears truncated (ends with ${JSON.stringify(lastChar)}).`;
  }
  return null;
}

export default function contextCuller(pi: ExtensionAPI): void {
  let archive = new Map<string, ArchivedResult>();
  let readFiles = new Map<string, string>();
  let modifiedFiles = new Set<string>();
  const pendingSummaries = new Map<string, Promise<void>>();
  let llmSummaries = new Map<string, string>();
  let llmSummaryErrors = new Map<string, string>();

  let summarizerModel: string | null = null;
  let guidanceText: string | null = null;
  let summarizerPromptText: string | null = null;
  let statePath: string | undefined;
  let persistChain: Promise<void> = Promise.resolve();
  let globalConfigPath = GLOBAL_CONFIG_PATH;

  function resetState() {
    archive = new Map();
    readFiles = new Map();
    modifiedFiles = new Set();
    llmSummaries = new Map();
    llmSummaryErrors = new Map();
    pendingSummaries.clear();
  }

  function getCharsSaved(): number {
    let total = 0;
    for (const entry of archive.values()) {
      total += Math.max(0, entry.originalChars - entry.maskedChars);
    }
    return total;
  }

  function toPersistedState(): PersistedState {
    return {
      version: 1,
      readFiles: [...readFiles.entries()],
      modifiedFiles: [...modifiedFiles.values()],
      archive: [...archive.values()],
      llmSummaries: [...llmSummaries.entries()],
      llmSummaryErrors: [...llmSummaryErrors.entries()],
    };
  }

  async function loadGlobalConfig(): Promise<void> {
    const text = await readFileIfExists(globalConfigPath);
    if (!text) {
      summarizerModel = null;
      return;
    }

    const parsed = safeParseJsonObject<GlobalConfig>(text);
    summarizerModel = typeof parsed?.summarizerModel === "string" ? parsed.summarizerModel : null;
  }

  async function persistGlobalConfig(): Promise<void> {
    const payload = JSON.stringify({ summarizerModel } satisfies GlobalConfig, null, 2);
    await fs.mkdir(dirname(globalConfigPath), { recursive: true });
    const tmpPath = `${globalConfigPath}.tmp`;
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, globalConfigPath);
  }

  async function setSummarizerModel(model: string | null): Promise<void> {
    summarizerModel = model;
    await persistGlobalConfig();
  }

  function queuePersist(): void {
    if (!statePath) return;
    const payload = JSON.stringify(toPersistedState(), null, 2);
    persistChain = persistChain
      .catch(() => undefined)
      .then(async () => {
        if (!statePath) return;
        await fs.mkdir(dirname(statePath), { recursive: true });
        const tmpPath = `${statePath}.tmp`;
        await fs.writeFile(tmpPath, payload, "utf8");
        await fs.rename(tmpPath, statePath);
      })
      .catch(() => undefined);
  }

  async function loadPersistedState(sessionFile: string | undefined): Promise<void> {
    resetState();
    statePath = sessionFile ? `${sessionFile}${ARCHIVE_FILE_SUFFIX}` : undefined;
    if (!statePath) return;

    const text = await readFileIfExists(statePath);
    if (!text) return;

    const state = safeParseState(text);
    if (!state) return;

    readFiles = new Map(state.readFiles ?? []);
    modifiedFiles = new Set(state.modifiedFiles ?? []);
    archive = new Map((state.archive ?? []).map((entry) => [entry.toolCallId, entry]));
    llmSummaries = new Map(state.llmSummaries ?? []);
    llmSummaryErrors = new Map(state.llmSummaryErrors ?? []);
  }

  async function getScopedSummarizerModels(ctx: ExtensionContext): Promise<string[]> {
    const [globalSettingsText, projectSettingsText] = await Promise.all([
      readFileIfExists(GLOBAL_SETTINGS_PATH),
      readFileIfExists(resolve(ctx.cwd, ".pi", "settings.json")),
    ]);

    const enabledModels = parseEnabledModelsSettings(projectSettingsText) ?? parseEnabledModelsSettings(globalSettingsText);
    const availableByRef = new Map(
      ctx.modelRegistry
        .getAvailable()
        .filter((model) => model.input.includes("text"))
        .map((model) => [`${model.provider}/${model.id}`, model] as const),
    );

    if (!enabledModels || enabledModels.length === 0) {
      return [...availableByRef.keys()].sort();
    }

    const scoped = enabledModels
      .map(stripThinkingSuffix)
      .filter((ref): ref is string => Boolean(ref) && availableByRef.has(ref));

    return [...new Set(scoped)].sort();
  }

  async function openSummarizerPicker(ctx: ExtensionContext, available: string[]): Promise<void> {
    const items: SettingItem[] = [
      {
        id: "__heuristic__",
        label: "Heuristic only",
        description: "Use head/tail masking only. No LLM summarization.",
        currentValue: summarizerModel === null ? "selected" : "",
        values: ["", "selected"],
      },
      ...available.map((model) => ({
        id: model,
        label: model,
        description: `Use ${model} to summarize large archived tool outputs.`,
        currentValue: summarizerModel === model ? "selected" : "",
        values: ["", "selected"],
      })),
    ];

    await ctx.ui.custom(
      (tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Context Culler summarizer")), 0, 0));
        container.addChild(new Text(theme.fg("muted", `Config: ${globalConfigPath}`), 0, 0));
        container.addChild(new Text("", 0, 0));

        const syncSelection = (selectedId: string | null) => {
          for (const item of items) {
            const isSelected = item.id === (selectedId ?? "__heuristic__");
            settingsList.updateValue(item.id, isSelected ? "selected" : "");
          }
        };

        const settingsList = new SettingsList(
          items,
          12,
          getSettingsListTheme(),
          async (id, _newValue) => {
            const nextModel = id === "__heuristic__" ? null : id;
            try {
              await setSummarizerModel(nextModel);
              syncSelection(nextModel);
              ctx.ui.notify(
                nextModel ? `Summarization model set to: ${nextModel}` : "Summarization: heuristic only",
                "info",
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Failed to save context-culler config: ${message}`, "error");
              syncSelection(summarizerModel);
            }
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );

        container.addChild(settingsList);

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true },
    );
  }

  function setStatus(ctx: ExtensionContext): void {
    if (archive.size === 0) return;
    const kb = Math.round(getCharsSaved() / 1024);
    const label = kb > 0 ? `🗜 ${archive.size}×${kb}k` : `🗜 ${archive.size}×`;
    ctx.ui.setStatus("ctx-culler", label);
  }

  function getSummaryState(toolCallId: string): "llm" | "pending" | "failed" | "heuristic" {
    if (getStoredSummary(toolCallId)) return "llm";
    if (pendingSummaries.has(toolCallId)) return "pending";
    if (llmSummaryErrors.has(toolCallId)) return "failed";
    return "heuristic";
  }

  function getStoredSummary(toolCallId: string): string | undefined {
    const summary = llmSummaries.get(toolCallId);
    if (!summary) return undefined;
    const error = validateSummary(summary, getArchivedText(archive.get(toolCallId)));
    if (!error) return summary;
    llmSummaries.delete(toolCallId);
    llmSummaryErrors.set(toolCallId, error);
    queuePersist();
    return undefined;
  }

  function revalidateStoredSummaries(): number {
    let invalidated = 0;
    for (const toolCallId of [...llmSummaries.keys()]) {
      if (!getStoredSummary(toolCallId)) invalidated += 1;
    }
    return invalidated;
  }

  async function ensureArchiveEntry(params: {
    toolCallId: string;
    toolName: string;
    text: string;
    reason: string;
    maskedChars: number;
    content: unknown;
    path?: string;
  }): Promise<ArchivedResult | null> {
    const { toolCallId, toolName, text, reason, maskedChars, content, path } = params;
    const saved = text.length - maskedChars;
    if (!archive.has(toolCallId) && saved < MIN_SAVINGS_CHARS) return null;

    const existing = archive.get(toolCallId);
    if (existing) {
      existing.maskedChars = Math.min(existing.maskedChars, maskedChars);
      if (!existing.path && path) existing.path = path;
      queuePersist();
      return existing;
    }

    const entry: ArchivedResult = {
      toolCallId,
      toolName,
      originalChars: text.length,
      maskedChars,
      reason,
      original: asContentBlocks(content),
      path,
    };
    archive.set(toolCallId, entry);
    queuePersist();
    return entry;
  }

  async function callSummarizer(
    text: string,
    toolName: string,
    modelString: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const slash = modelString.indexOf("/");
    if (slash <= 0) throw new Error(`Invalid summarizer model reference: ${modelString}`);
    const provider = modelString.slice(0, slash);
    const modelId = modelString.slice(slash + 1);
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Summarizer model not found: ${modelString}`);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Summarizer auth unavailable for ${modelString}`);

    const prompt =
      summarizerPromptText ?? (await readFileIfExists(SUMMARIZE_PROMPT_PATH)) ?? "Summarize the tool output tersely.";
    summarizerPromptText = prompt;

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text: `${prompt}\n\n<tool-name>${toolName}</tool-name>\n<tool-output>\n${text}\n</tool-output>`,
              },
            ],
          },
        ],
      } as Context,
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 500,
        signal,
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `Summarizer request failed with stopReason=${response.stopReason}`);
    }
    if (response.stopReason === "length") {
      throw new Error("Summarizer response hit maxTokens and may be truncated.");
    }

    const summary = getContentText(response.content).trim();
    const validationError = validateSummary(summary, text);
    if (validationError) {
      throw new Error(validationError);
    }
    return summary;
  }

  function startSummaryIfNeeded(
    toolCallId: string,
    toolName: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): void {
    if (!summarizerModel) return;
    if (pendingSummaries.has(toolCallId) || getStoredSummary(toolCallId)) return;
    const entry = archive.get(toolCallId);
    const text = getArchivedText(entry);
    if (!text || isMaskedText(text)) {
      llmSummaryErrors.set(toolCallId, "Archived original content missing or already masked.");
      queuePersist();
      return;
    }
    llmSummaryErrors.delete(toolCallId);

    const pending = callSummarizer(text, toolName, summarizerModel, ctx, signal)
      .then((summary) => {
        llmSummaries.set(toolCallId, summary);
        llmSummaryErrors.delete(toolCallId);
        const existing = archive.get(toolCallId);
        if (existing) {
          existing.maskedChars = summary.length;
        }
        queuePersist();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        llmSummaryErrors.set(toolCallId, message || "Unknown summarizer error.");
        queuePersist();
      })
      .finally(() => {
        pendingSummaries.delete(toolCallId);
      });

    pendingSummaries.set(toolCallId, pending);
  }

  async function buildMaskedText(params: {
    toolCallId: string;
    toolName: string;
    text: string;
    reason: string;
    keepFirst: number;
    keepLast: number;
    content: unknown;
    path?: string;
    ctx: ExtensionContext;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const { toolCallId, toolName, text, reason, keepFirst, keepLast, content, path, ctx, signal } = params;
    const heuristic = compressLines(text, keepFirst, keepLast, reason, toolCallId);
    const entry = await ensureArchiveEntry({
      toolCallId,
      toolName,
      text,
      reason,
      maskedChars: heuristic.length,
      content,
      path,
    });
    if (!entry) return null;

    startSummaryIfNeeded(toolCallId, toolName, ctx, signal);
    const llmSummary = getStoredSummary(toolCallId);
    return llmSummary ? buildMaskedMarker(toolCallId, reason, llmSummary) : heuristic;
  }

  async function buildModifiedReadPlaceholder(
    toolCallId: string,
    toolName: string,
    text: string,
    content: unknown,
    path: string | undefined,
  ): Promise<string | null> {
    const reason = path
      ? `file was read then modified (${path}) — omitted`
      : "file was read then modified — omitted";
    const placeholder = buildMaskedMarker(toolCallId, reason, "");
    const entry = await ensureArchiveEntry({
      toolCallId,
      toolName,
      text,
      reason,
      maskedChars: placeholder.length,
      content,
      path,
    });
    return entry ? placeholder : null;
  }

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const rawPath = String((event.input as any)?.file_path ?? (event.input as any)?.path ?? "");
      const normalizedPath = rawPath ? await normalizeToolPath(rawPath, ctx.cwd) : undefined;
      if (normalizedPath) {
        modifiedFiles.add(normalizedPath);
        queuePersist();
      }
      return;
    }

    if (event.toolName === "read") {
      const rawPath = String((event.input as any)?.path ?? (event.input as any)?.file_path ?? "");
      const normalizedPath = rawPath ? await normalizeToolPath(rawPath, ctx.cwd) : undefined;
      if (normalizedPath) {
        readFiles.set(event.toolCallId, normalizedPath);
        queuePersist();
      }
      return;
    }

    const text = getContentText(event.content);
    const policy = getImmediatePolicy(event, text.length);
    if (!policy.shouldMask) return;

    const masked = await buildMaskedText({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      text,
      reason: policy.reason,
      keepFirst: policy.keepFirst,
      keepLast: policy.keepLast,
      content: event.content,
      ctx,
      signal: ctx.signal,
    });
    if (!masked) return;

    return {
      content: [{ type: "text", text: masked }],
    };
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as any[];
    const recentTurnStart = getRecentTurnStartIndex(messages);
    if (recentTurnStart < 0) return;

    let changed = false;
    const nextMessages = await Promise.all(
      messages.map(async (message, index) => {
        if (index >= recentTurnStart) return message;
        if (message?.role !== "toolResult") return message;

        const toolName = String(message.toolName ?? "");
        const toolCallId = String(message.toolCallId ?? "");
        if (!toolName || !toolCallId) return message;

        const archived = archive.get(toolCallId);
        const text = getArchivedText(archived) || getContentText(message.content);
        if (!text) return message;
        if (isMaskedText(text) && !archived) return message;

        if (toolName === "bash") {
          const policy = getBashContextPolicy(text.length, Boolean(message.isError));
          if (!policy.shouldMask) return message;
          const masked = await buildMaskedText({
            toolCallId,
            toolName,
            text,
            reason: policy.reason,
            keepFirst: policy.keepFirst,
            keepLast: policy.keepLast,
            content: archived?.original ?? message.content,
            ctx,
            signal: ctx.signal,
          });
          if (!masked) return message;
          changed = true;
          return { ...message, content: [{ type: "text", text: masked }] };
        }

        if (toolName === "read") {
          const normalizedPath = readFiles.get(toolCallId);
          if (normalizedPath && modifiedFiles.has(normalizedPath)) {
            const masked = await buildModifiedReadPlaceholder(
              toolCallId,
              toolName,
              text,
              archived?.original ?? message.content,
              normalizedPath,
            );
            if (!masked) return message;
            changed = true;
            return { ...message, content: [{ type: "text", text: masked }] };
          }

          const policy = getReadContextPolicy(text.length);
          if (!policy.shouldMask) return message;
          const masked = await buildMaskedText({
            toolCallId,
            toolName,
            text,
            reason: policy.reason,
            keepFirst: policy.keepFirst,
            keepLast: policy.keepLast,
            content: archived?.original ?? message.content,
            path: normalizedPath,
            ctx,
            signal: ctx.signal,
          });
          if (!masked) return message;
          changed = true;
          return { ...message, content: [{ type: "text", text: masked }] };
        }

        if (!archived) return message;
        const llmSummary = getStoredSummary(toolCallId);
        if (!llmSummary) return message;
        changed = true;
        return {
          ...message,
          content: [{ type: "text", text: buildMaskedMarker(toolCallId, archived.reason, llmSummary) }],
        };
      }),
    );

    if (!changed) return;
    setStatus(ctx);
    return { messages: nextMessages };
  });

  pi.registerTool({
    name: "peek_masked",
    label: "Peek Masked",
    description: "Retrieve the full original content for a previously masked result.",
    parameters: Type.Object({
      id: Type.String({ description: "The full archive id from a context-culler marker or /prune-stats." }),
    }),
    async execute(_toolCallId, params) {
      const entry = archive.get(params.id);
      if (!entry) {
        return {
          content: [{ type: "text", text: `No archived result found for ${params.id}.` }],
          details: { found: false },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `[context-culler: restored ${entry.toolName} output for ${entry.toolCallId}]`,
              getContentText(entry.original),
            ].join("\n"),
          },
        ],
        details: {
          found: true,
          toolName: entry.toolName,
          originalChars: entry.originalChars,
          path: entry.path,
        },
      };
    },
  });

  pi.on("before_agent_start", async (event: any) => {
    if (guidanceText === null) {
      guidanceText = (await readFileIfExists(AGENT_GUIDANCE_PATH)) ?? "";
    }
    if (!guidanceText) return;
    const current = String(event.systemPrompt ?? "");
    return { systemPrompt: current ? `${current}\n\n${guidanceText}` : guidanceText };
  });

  pi.on("session_start", async (_event, ctx) => {
    await loadGlobalConfig();
    await loadPersistedState(ctx.sessionManager.getSessionFile());
    const invalidated = revalidateStoredSummaries();
    if (invalidated > 0) {
      ctx.ui.notify(`Context Culler invalidated ${invalidated} bad persisted LLM summar${invalidated === 1 ? "y" : "ies"}.`, "warning");
    }
    setStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    queuePersist();
    await persistChain;
  });

  pi.registerCommand("prune-config", {
    description: "Configure context culler summarization model.",
    getArgumentCompletions: async (argumentPrefix) => {
      const globalSettingsText = await readFileIfExists(GLOBAL_SETTINGS_PATH);
      const projectSettingsText = await readFileIfExists(resolve(process.cwd(), ".pi", "settings.json"));
      const enabledModels = parseEnabledModelsSettings(projectSettingsText) ?? parseEnabledModelsSettings(globalSettingsText) ?? [];
      const choices = ["heuristic", ...enabledModels.map(stripThinkingSuffix)];
      const prefix = argumentPrefix.trim().toLowerCase();
      return [...new Set(choices)]
        .filter((value) => !prefix || value.toLowerCase().includes(prefix))
        .sort()
        .map((value) => ({
          value,
          label: value,
          description: value === "heuristic" ? "Use head/tail masking only" : "Use as summarizer model",
        }));
    },
    handler: async (args, ctx) => {
      const available = await getScopedSummarizerModels(ctx);
      const requested = args.trim();

      if (requested) {
        const nextModel = requested === "heuristic" ? null : requested;
        if (nextModel !== null && !available.includes(nextModel)) {
          ctx.ui.notify(`Model not in current enabled scope: ${nextModel}`, "error");
          return;
        }
        try {
          await setSummarizerModel(nextModel);
          ctx.ui.notify(nextModel ? `Summarization model set to: ${nextModel}` : "Summarization: heuristic only", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to save context-culler config: ${message}`, "error");
        }
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /prune-config <model|heuristic>", "error");
        return;
      }

      await openSummarizerPicker(ctx, available);
    },
  });

  pi.registerCommand("compact-smart", {
    description: "Compact with context-culler instructions that preserve goals/decisions/files and discard dead ends.",
    handler: async (args, ctx) => {
      const extra = args.trim();
      const customInstructions = [
        "Create a structured continuation summary focused on user goals, constraints, key decisions, files read/modified, current blockers, and next steps.",
        "Aggressively discard dead-end exploration, superseded hypotheses, repeated searches/listings, and tool chatter whose conclusions are already captured.",
        "Retain exact file paths, identifiers, symbols, error messages, and counts when they matter for correctness.",
        extra,
      ]
        .filter(Boolean)
        .join("\n\n");
      ctx.compact({
        customInstructions: customInstructions || undefined,
        onComplete: () => ctx.ui.notify("Smart compaction completed", "info"),
        onError: (error) => ctx.ui.notify(`Smart compaction failed: ${error.message}`, "error"),
      });
    },
  });

  pi.registerCommand("prune-stats", {
    description: "Show context-culler archive stats and full peek_masked IDs.",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      let llmCount = 0;
      let pendingCount = 0;
      let failedCount = 0;
      let heuristicCount = 0;
      const archiveLines = [...archive.values()]
        .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId))
        .map((entry) => {
          const saved = Math.max(0, entry.originalChars - entry.maskedChars);
          const pathInfo = entry.path ? ` path=${entry.path}` : "";
          const summaryState = getSummaryState(entry.toolCallId);
          if (summaryState === "llm") llmCount += 1;
          else if (summaryState === "pending") pendingCount += 1;
          else if (summaryState === "failed") failedCount += 1;
          else heuristicCount += 1;
          const errorInfo = summaryState === "failed" ? ` error=${JSON.stringify(llmSummaryErrors.get(entry.toolCallId) ?? "unknown")}` : "";
          return `  - ${entry.toolCallId}  (${entry.toolName}, saved ${saved} chars, reason: ${entry.reason}, summary=${summaryState}${pathInfo}${errorInfo})`;
        });

      const lines = [
        "Context Culler",
        `  Session archive file:  ${statePath ?? "(ephemeral / none)"}`,
        `  Global config file:    ${globalConfigPath}`,
        `  Archived results:      ${archive.size}`,
        `  Characters saved:      ${getCharsSaved().toLocaleString()}`,
        `  Read files tracked:    ${readFiles.size}`,
        `  Modified files:        ${modifiedFiles.size}`,
        `  Summarizer model:      ${summarizerModel ?? "heuristic only"}`,
        `  LLM summaries:         ${llmCount}`,
        `  Pending summaries:     ${pendingCount}`,
        `  Failed summaries:      ${failedCount}`,
        `  Heuristic-only:        ${heuristicCount}`,
        archiveLines.length > 0 ? "  Archive IDs:\n" + archiveLines.join("\n") : "",
      ].filter(Boolean) as string[];

      if (usage?.percent != null) {
        lines.push(
          `  Context usage:         ${usage.percent.toFixed(1)}% (${(usage.tokens ?? 0).toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens)`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("turn_end", async (_event, ctx) => {
    setStatus(ctx);
  });
}
