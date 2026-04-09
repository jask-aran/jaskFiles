#!/usr/bin/env bash
set -euo pipefail

# Canonical pi environment builder.
#
# This script is the source of truth for how this pi setup should be rebuilt on
# a fresh machine. It intentionally encodes the selected upstream sources,
# local overrides, and behavioral tradeoffs so the resulting pi environment is
# repeatable instead of being an ad hoc pile of copied files.
#
# Why this exists instead of relying purely on `pi install`:
# - this setup is curated from multiple upstream repos, not one package
# - some upstream examples are good bases but not the final desired behavior
# - some copied extensions need local runtime deps (for example `diff`)
# - some upstream names/behaviors conflict with other chosen extensions
# - we want a readable, auditable bootstrap that documents the environment
#
# Canonical decisions currently encoded here:
# - questionnaire.ts is the single canonical user-clarification tool.
#   Tradeoff: we deliberately do NOT keep both `question` and `questionnaire`,
#   because overlapping question tools would make the agent's tool choice less
#   predictable. We prefer one tool that can handle both single-question and
#   multi-question flows.
#
# - Mitsuhiko todos is the real persistent task system.
#   Tradeoff: we remove the simpler pi-mono example `todo.ts` because it would
#   overlap in purpose and naming, while Mitsuhiko todos gives us a file-backed,
#   cross-session task system under .pi/todos.
#
# - plan-mode is sourced from upstream, then customized locally.
#   Tradeoff: the upstream example is a good base, but not fully aligned with
#   this build. We keep the idea, but patch the behavior after install.
#
# - plan-mode progress tracking is NOT the same as the persistent todo system.
#   Tradeoff: plan-mode keeps an internal checklist of plan steps for a single
#   execution flow, but its progress command is renamed to `/plan-status` so it
#   does not conflict conceptually or operationally with the real todo system.
#
# - leaving plan-mode restores the real prior tool set dynamically.
#   Tradeoff: we do NOT want to hardcode a tiny "normal mode" tool list,
#   because this environment evolves over time. Instead, plan-mode snapshots the
#   active tools on entry and restores them on exit.
#
# - Mitsuhiko multi-edit is preferred over stock edit behavior.
#   Tradeoff: it adds dependency/setup complexity (`diff` must be installed),
#   but gives better multi-edit and patch-oriented editing behavior.
#
# - global pi settings are restored from the canonical backup in jaskFiles.
#   Tradeoff: this script should recreate both the custom extension layer and
#   the package/settings layer we actually use. That means copying the backed-up
#   ~/.pi/agent/settings.json from the repo-owned canonical copy.
#
# Backup policy:
# - backups are stored under ~/.pi/agent/backups/install-pi-setup/
# - we do NOT keep .bak files/directories inside ~/.pi/agent/extensions because
#   pi auto-discovers that directory and would try to load those backups as live
#   extensions.

BASE_DIR="${HOME}/.pi/agent"
EXT_DIR="$BASE_DIR/extensions"
INTERCEPT_DIR="$BASE_DIR/intercepted-commands"
BACKUP_ROOT="$BASE_DIR/backups/install-pi-setup"
TMPDIR="$(mktemp -d)"
REPO_DIR="$TMPDIR/pi-mono"
PI_MONO_REPO="https://github.com/badlogic/pi-mono.git"
PI_MONO_SPARSE_PATH="packages/coding-agent/examples/extensions"
PI_MONO_REF="${PI_MONO_REF:-main}"
MITSU_REF="${MITSU_REF:-main}"
PI_KIT_REF="${PI_KIT_REF:-main}"
CANONICAL_PI_DIR="${CANONICAL_PI_DIR:-$HOME/jaskFiles/pi}"
SETTINGS_BACKUP="$CANONICAL_PI_DIR/settings.json"
FORCE=0
INSTALL_MITSU_UV=1
INSTALL_PI_MONO=1
INSTALL_WORKFLOW_EXTENSIONS=1

usage() {
  cat <<'EOF'
Usage: install-pi-setup.sh [options]

Installs the canonical non-NPM pi environment into ~/.pi/agent by fetching
selected extensions and helper shims from upstream repositories, then applying
local customizations required by this build.

Options:
  --only-uv         Install only the Mitsuhiko uv extension and shims
  --only-pi-mono    Install only selected pi-mono example extensions
  --only-workflow   Install only the workflow/power-user extensions
  --force           Overwrite existing files without creating .bak backups
  -h, --help        Show this help

Environment:
  PI_MONO_REF       Git ref for badlogic/pi-mono (default: main)
  MITSU_REF         Git ref for mitsuhiko/agent-stuff (default: main)
  PI_KIT_REF        Git ref for butttons/pi-kit (default: main)
  CANONICAL_PI_DIR  Directory containing canonical pi backup files (default: ~/jaskFiles/pi)

Examples:
  ~/install-pi-setup.sh
  PI_MONO_REF=<commit> MITSU_REF=<commit> PI_KIT_REF=<commit> ~/install-pi-setup.sh --force
EOF
}

log() {
  printf '%s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

backup_or_overwrite() {
  local target="$1"
  if [[ -e "$target" && "$FORCE" -ne 1 ]]; then
    local rel
    rel="${target#$BASE_DIR/}"
    if [[ "$rel" == "$target" ]]; then
      rel="$(basename "$target")"
    fi
    local backup="$BACKUP_ROOT/$rel"
    rm -rf "$backup"
    mkdir -p "$(dirname "$backup")"
    cp -R "$target" "$backup"
    log "Backed up existing $(basename "$target") to $backup"
  fi
}

fetch_file() {
  local url="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"
  backup_or_overwrite "$dest"
  curl -fsSL "$url" -o "$dest"
}

restore_settings_backup() {
  local dest="$BASE_DIR/settings.json"
  mkdir -p "$BASE_DIR"

  if [[ -f "$SETTINGS_BACKUP" ]]; then
    backup_or_overwrite "$dest"
    cp -f "$SETTINGS_BACKUP" "$dest"
    log "Restored canonical settings backup to: $dest"
  else
    log "Skipped missing canonical settings backup: $SETTINGS_BACKUP"
  fi
}

install_mitsu_uv() {
  log "Installing Mitsuhiko uv extension into: $EXT_DIR"
  mkdir -p "$EXT_DIR" "$INTERCEPT_DIR"

  local uv_url="https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/uv.ts"
  fetch_file "$uv_url" "$EXT_DIR/mitsu-uv.ts"

  log "Fetching intercepted command shims..."
  for cmd in pip pip3 poetry python python3; do
    local shim_url="https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/intercepted-commands/${cmd}"
    fetch_file "$shim_url" "$INTERCEPT_DIR/${cmd}"
    chmod +x "$INTERCEPT_DIR/${cmd}"
  done
}

customize_plan_mode() {
  local plan_dir="$EXT_DIR/plan-mode"

  # Important: plan-mode is intentionally sourced from upstream and then patched
  # here. We do this because we want the upstream implementation as a base, but
  # with local environment-specific decisions layered on top.
  cat > "$plan_dir/index.ts" <<'EOF'
/**
 * Customized Plan Mode Extension
 *
 * Sourced from the upstream pi-mono example and adapted for this environment.
 *
 * Local decisions:
 * - questionnaire is the single canonical clarification tool
 * - entering plan mode snapshots currently active tools
 * - leaving plan mode restores the prior active tools instead of a hardcoded list
 * - plan progress uses /plan-status instead of /todos to avoid conflicting with
 *   the persistent Mitsuhiko todo system
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let previousTools: string[] | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function snapshotCurrentTools(): string[] {
		const active = pi.getActiveTools();
		return active.length > 0 ? [...active] : ["read", "bash", "edit", "write"];
	}

	function restorePreviousTools(): void {
		const toolsToRestore = previousTools && previousTools.length > 0 ? previousTools : ["read", "bash", "edit", "write"];
		pi.setActiveTools(toolsToRestore);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			previousTools = snapshotCurrentTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		} else {
			restorePreviousTools();
			ctx.ui.notify("Plan mode disabled. Previous tool set restored.");
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			previousTools,
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No active plan steps. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: ${PLAN_MODE_TOOLS.join(", ")}
- You CANNOT use file mutation tools while plan mode is active
- Bash is restricted to an allowlist of read-only commands

Use the questionnaire tool for both quick clarifications and multi-question intake.
Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) updateStatus(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				restorePreviousTools();
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) todoItems = extracted;
		}

		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{ customType: "plan-todo-list", content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`, display: true },
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			restorePreviousTools();
			updateStatus(ctx);

			const execMessage = todoItems.length > 0
				? `Execute the plan. Start with: ${todoItems[0].text}`
				: "Execute the plan you just created.";
			pi.sendMessage({ customType: "plan-mode-execute", content: execMessage, display: true }, { triggerTurn: true });
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planModeEnabled = true;

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean; previousTools?: string[] } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			previousTools = planModeEntry.data.previousTools ?? previousTools;
		}

		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			if (!previousTools || previousTools.length === 0) previousTools = snapshotCurrentTools();
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
EOF
}

install_pi_mono_examples() {
  log "Installing pi-mono example extensions into: $EXT_DIR"
  mkdir -p "$EXT_DIR"

  local questionnaire_url="https://raw.githubusercontent.com/badlogic/pi-mono/${PI_MONO_REF}/packages/coding-agent/examples/extensions/questionnaire.ts"

  log "Fetching single-file extensions..."
  fetch_file "$questionnaire_url" "$EXT_DIR/questionnaire.ts"

  log "Fetching multi-file extension: plan-mode/..."
  git clone --depth 1 --branch "$PI_MONO_REF" --filter=blob:none --sparse "$PI_MONO_REPO" "$REPO_DIR" >/dev/null 2>&1 || {
    rm -rf "$REPO_DIR"
    git clone --depth 1 --filter=blob:none --sparse "$PI_MONO_REPO" "$REPO_DIR" >/dev/null 2>&1
    (
      cd "$REPO_DIR"
      git checkout "$PI_MONO_REF" >/dev/null 2>&1
    )
  }

  (
    cd "$REPO_DIR"
    git sparse-checkout set "$PI_MONO_SPARSE_PATH/plan-mode" >/dev/null 2>&1
  )

  if [[ -e "$EXT_DIR/plan-mode" && "$FORCE" -ne 1 ]]; then
    backup_or_overwrite "$EXT_DIR/plan-mode"
  fi

  rm -rf "$EXT_DIR/plan-mode"
  cp -R "$REPO_DIR/$PI_MONO_SPARSE_PATH/plan-mode" "$EXT_DIR/plan-mode"
  customize_plan_mode
}

install_workflow_extensions() {
  log "Installing workflow/power-user extensions into: $EXT_DIR"
  mkdir -p "$EXT_DIR"

  # Local package context for extension runtime dependencies.
  # Needed because some cherry-picked extensions are copied in directly rather
  # than installed as standalone npm packages.
  if [[ ! -f "$EXT_DIR/package.json" ]]; then
    cat > "$EXT_DIR/package.json" <<'EOF'
{
  "name": "jask-pi-extensions-local",
  "private": true,
  "dependencies": {}
}
EOF
  fi

  # Mitsuhiko extensions: chosen for higher-leverage workflow improvements
  # (files, review, context, multi-edit, notify, todos, etc.).
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/answer.ts" "$EXT_DIR/mitsu-answer.ts"
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/context.ts" "$EXT_DIR/mitsu-context.ts"
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/files.ts" "$EXT_DIR/mitsu-files.ts"
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/multi-edit.ts" "$EXT_DIR/mitsu-multi-edit.ts"
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/notify.ts" "$EXT_DIR/mitsu-notify.ts"
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/review.ts" "$EXT_DIR/mitsu-review.ts"
  fetch_file "https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/todos.ts" "$EXT_DIR/mitsu-todos.ts"

  # butttons/pi-kit guardrails: safety/behavior shaping rather than new large
  # workflows. These are small, focused additions.
  fetch_file "https://raw.githubusercontent.com/butttons/pi-kit/${PI_KIT_REF}/extensions/safe-delete.ts" "$EXT_DIR/safe-delete.ts"
  fetch_file "https://raw.githubusercontent.com/butttons/pi-kit/${PI_KIT_REF}/extensions/explore-guard.ts" "$EXT_DIR/explore-guard.ts"

  # Remove old pi-mono example tools we no longer want in the canonical setup.
  # These are removed deliberately, not accidentally:
  # - question.ts: replaced by questionnaire.ts as the one canonical question tool
  # - todo.ts: replaced by Mitsuhiko todos as the real persistent task system
  for legacy in "$EXT_DIR/todo.ts" "$EXT_DIR/question.ts"; do
    if [[ -e "$legacy" ]]; then
      if [[ "$FORCE" -ne 1 ]]; then
        backup_or_overwrite "$legacy"
      fi
      rm -f "$legacy"
      log "Removed legacy example $(basename "$legacy") from canonical setup"
    fi
  done

  # multi-edit imports the npm package `diff`, so we install it into the local
  # extension package context. This is one reason this script exists as an
  # explicit canonical bootstrap instead of only copying .ts files around.
  log "Installing extension dependencies..."
  (cd "$EXT_DIR" && npm install diff --silent)
}

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only-uv)
      INSTALL_MITSU_UV=1
      INSTALL_PI_MONO=0
      INSTALL_WORKFLOW_EXTENSIONS=0
      ;;
    --only-pi-mono)
      INSTALL_MITSU_UV=0
      INSTALL_PI_MONO=1
      INSTALL_WORKFLOW_EXTENSIONS=0
      ;;
    --only-workflow)
      INSTALL_MITSU_UV=0
      INSTALL_PI_MONO=0
      INSTALL_WORKFLOW_EXTENSIONS=1
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

need_cmd curl
if [[ "$INSTALL_PI_MONO" -eq 1 ]]; then
  need_cmd git
fi

log "Installing pi setup into: $BASE_DIR"
log "Refs: pi-mono=${PI_MONO_REF}, agent-stuff=${MITSU_REF}, pi-kit=${PI_KIT_REF}"
log "Canonical pi dir: ${CANONICAL_PI_DIR}"
log

restore_settings_backup
log

if [[ "$INSTALL_MITSU_UV" -eq 1 ]]; then
  install_mitsu_uv
  log
fi

if [[ "$INSTALL_PI_MONO" -eq 1 ]]; then
  install_pi_mono_examples
  log
fi

if [[ "$INSTALL_WORKFLOW_EXTENSIONS" -eq 1 ]]; then
  install_workflow_extensions
  log
fi

log 'Installed files:'
if [[ -f "$EXT_DIR/mitsu-uv.ts" ]]; then
  printf '  %s\n' "$EXT_DIR/mitsu-uv.ts"
fi
for cmd in pip pip3 poetry python python3; do
  if [[ -f "$INTERCEPT_DIR/$cmd" ]]; then
    printf '  %s\n' "$INTERCEPT_DIR/$cmd"
  fi
done
for path in \
  "$EXT_DIR/questionnaire.ts" \
  "$EXT_DIR/plan-mode" \
  "$EXT_DIR/mitsu-answer.ts" \
  "$EXT_DIR/mitsu-context.ts" \
  "$EXT_DIR/mitsu-files.ts" \
  "$EXT_DIR/mitsu-multi-edit.ts" \
  "$EXT_DIR/mitsu-notify.ts" \
  "$EXT_DIR/mitsu-review.ts" \
  "$EXT_DIR/mitsu-todos.ts" \
  "$EXT_DIR/safe-delete.ts" \
  "$EXT_DIR/explore-guard.ts"; do
  if [[ -e "$path" ]]; then
    printf '  %s\n' "$path"
  fi
done

cat <<EOF

Done.

Next steps:
  1. Start pi
  2. Run /reload

Notes:
  - This is the canonical, repeatable builder for this non-NPM pi setup.
  - It restores the canonical global settings backup before installing extensions.
  - It installs cherry-picked extensions directly into ~/.pi/agent.
  - questionnaire.ts is the single canonical user-clarification tool in this setup.
  - Mitsuhiko todos replaces the pi-mono example todo tool in this setup.
  - plan-mode is sourced from upstream and then customized for this environment.
  - plan-mode progress is separate from the persistent todo system and uses /plan-status.
  - Mitsuhiko multi-edit replaces the built-in edit tool at runtime and requires the local \
    \'diff\' dependency.
  - Backups are stored outside the live extensions directory to avoid accidental auto-loading.
  - Canonical settings are read from: ${SETTINGS_BACKUP}
  - For fully shareable/reproducible setups, prefer pi packages + settings.json.
EOF
