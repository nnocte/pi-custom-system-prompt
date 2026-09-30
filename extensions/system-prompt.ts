/**
 * Custom System Prompt Extension for Pi
 *
 * Loads a custom system prompt from ~/.pi/agent/system-prompts/ and injects
 * it into every agent turn. Works with any model or agent — nothing is
 * hardcoded.
 *
 * Multiple .md files can coexist in the prompt directory. Use
 * /system-prompt-select to pick which one is active.
 *
 * Commands
 * --------
 *   /system-prompt-info     Show loaded path, size, mode, enabled state
 *   /system-prompt-toggle   Enable or disable the custom prompt
 *   /system-prompt-reload   Re-read the selected prompt file from disk
 *   /system-prompt-mode     Toggle between "replace" and "append" mode
 *   /system-prompt-show     Print the first ~800 chars of the loaded prompt
 *   /system-prompt-select   Pick a different prompt file from the directory
 *   Ctrl+Shift+E            Edit the selected prompt in Pi's built-in editor
 *
 * How changes take effect
 * -----------------------
 *   The custom prompt is injected via the before_agent_start event, which
 *   fires on every user message. This means all changes (toggle, reload,
 *   mode, select) take effect on the very next message you send — no /new
 *   or session restart required.
 *
 * Modes
 * -----
 *   append  (default) — Keep Pi's default system prompt as the base and add
 *                        the custom prompt as an extra section. Safest for
 *                        most models since Pi's tool descriptions stay
 *                        authoritative.
 *   replace           — Use the custom prompt as the base system prompt.
 *                        Pi's tool descriptions, date, cwd, and user
 *                        customizations are appended after it.
 *
 * State persistence
 * -----------------
 *   enabled, mode, and selectedFile are persisted to:
 *     ~/.pi/agent/state/system-prompt.json
 *   and survive Pi restarts.
 *
 * Footer indicator
 * ----------------
 *   system-prompt: disabled              (when disabled)
 *   system-prompt: claude-code.md        (when enabled, showing filename)
 *
 * Environment variables
 * ---------------------
 *   PI_SYSTEM_PROMPT_DIR   Override the default prompt directory
 *                          (default: ~/.pi/agent/system-prompts)
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const DEFAULT_PROMPT_DIR = path.join(
	os.homedir(),
	".pi",
	"agent",
	"system-prompts",
);

const STATE_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"state",
	"system-prompt.json",
);

type Mode = "replace" | "append";

interface PersistedState {
	enabled: boolean;
	mode: Mode;
	selectedFile: string;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// Mirror pi's formatSkillsForPrompt exactly so the <available_skills> block the
// model sees is identical to what pi's own default prompt would emit. Inlined
// (rather than imported) so the extension takes no runtime dependency on the
// host package and stays resolvable regardless of node_modules topology.
function formatSkillsBlock(skills: Skill[]): string {
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export default function systemPromptExtension(pi: ExtensionAPI) {
	const promptDir: string =
		process.env.PI_SYSTEM_PROMPT_DIR?.trim() || DEFAULT_PROMPT_DIR;

	let enabled: boolean;
	let mode: Mode;
	let selectedFile: string;
	let promptContent: string | null = null;
	let loadError: string | null = null;
	let lastLoaded: number | null = null;

	// --- State persistence ---------------------------------------------------

	function loadState(): PersistedState {
		try {
			if (!fs.existsSync(STATE_PATH)) {
				return { enabled: true, mode: "append", selectedFile: "" };
			}
			const raw = fs.readFileSync(STATE_PATH, "utf-8");
			const parsed = JSON.parse(raw) as Partial<PersistedState>;
			return {
				enabled: parsed.enabled === false ? false : true,
				mode: parsed.mode === "replace" ? "replace" : "append",
				selectedFile:
					typeof parsed.selectedFile === "string"
						? parsed.selectedFile
						: "",
			};
		} catch {
			return { enabled: true, mode: "append", selectedFile: "" };
		}
	}

	function saveState(): void {
		try {
			fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
			fs.writeFileSync(
				STATE_PATH,
				JSON.stringify(
					{ enabled, mode, selectedFile } satisfies PersistedState,
					null,
					2,
				),
			);
		} catch {
			// best-effort — state persistence failure should not break anything
		}
	}

	// Initialize from persisted state
	const initial = loadState();
	enabled = initial.enabled;
	mode = initial.mode;
	selectedFile = initial.selectedFile;

	// --- Prompt file management ----------------------------------------------

	function listPromptFiles(): string[] {
		try {
			if (!fs.existsSync(promptDir)) return [];
			return fs
				.readdirSync(promptDir, { withFileTypes: true })
				.filter((d) => d.isFile() && d.name.endsWith(".md"))
				.map((d) => d.name)
				.sort();
		} catch {
			return [];
		}
	}

	function ensureSelectedFile(): void {
		const files = listPromptFiles();
		if (files.length === 0) {
			selectedFile = "";
			return;
		}
		if (!selectedFile || !files.includes(selectedFile)) {
			selectedFile = files[0];
			saveState();
		}
	}

	function loadPrompt(): void {
		ensureSelectedFile();

		if (!selectedFile) {
			promptContent = null;
			loadError = fs.existsSync(promptDir)
				? `no .md files in ${shortPath(promptDir)}`
				: `directory not found: ${shortPath(promptDir)}`;
			return;
		}

		const filePath = path.join(promptDir, selectedFile);
		try {
			if (!fs.existsSync(filePath)) {
				promptContent = null;
				loadError = `file not found: ${shortPath(filePath)}`;
				return;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			if (!content.trim()) {
				promptContent = null;
				loadError = `file is empty: ${shortPath(filePath)}`;
				return;
			}
			promptContent = content;
			loadError = null;
			lastLoaded = Date.now();
		} catch (err) {
			promptContent = null;
			loadError = `read failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	function shortPath(p: string): string {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	}

	// --- Footer status -------------------------------------------------------

	function updateStatus(ctx: {
		hasUI: boolean;
		ui: { setStatus: (id: string, value: string | undefined) => void };
	}): void {
		if (!ctx.hasUI) return;
		if (enabled && selectedFile) {
			ctx.ui.setStatus("system-prompt", `system-prompt: ${selectedFile}`);
		} else if (enabled) {
			ctx.ui.setStatus("system-prompt", "system-prompt: enabled");
		} else {
			ctx.ui.setStatus("system-prompt", "system-prompt: disabled");
		}
	}

	// --- Initial load --------------------------------------------------------
	loadPrompt();

	// --- Command handlers ----------------------------------------------------

	pi.registerCommand("system-prompt-info", {
		description: "Show custom system prompt info (path, size, mode, state)",
		handler: async (_args, ctx) => {
			const files = listPromptFiles();
			const lines = [
				`Directory: ${shortPath(promptDir)}`,
				`File:      ${selectedFile || "(none)"}`,
				`Mode:      ${mode}`,
				`Enabled:   ${enabled}`,
				`Status:    ${loadError ?? "loaded"}`,
				`Size:      ${promptContent?.length ?? 0} chars`,
				`Loaded:    ${lastLoaded ? new Date(lastLoaded).toLocaleTimeString() : "never"}`,
				`Available: ${files.length > 0 ? files.join(", ") : "(none)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("system-prompt-toggle", {
		description: "Enable or disable the custom system prompt",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			saveState();
			updateStatus(ctx);
			const state = enabled ? "enabled" : "disabled";
			ctx.ui.notify(
				`System prompt ${state}. Takes effect on next message.`,
				"info",
			);
		},
	});

	pi.registerCommand("system-prompt-reload", {
		description: "Reload the custom system prompt from disk",
		handler: async (_args, ctx) => {
			loadPrompt();
			updateStatus(ctx);
			if (loadError) {
				ctx.ui.notify(`Reload failed: ${loadError}`, "error");
			} else {
				ctx.ui.notify(
					`Reloaded ${selectedFile} (${promptContent!.length} chars). Takes effect on next message.`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("system-prompt-select", {
		description: "Select which .md file to use as the system prompt",
		handler: async (_args, ctx) => {
			const files = listPromptFiles();
			if (files.length === 0) {
				ctx.ui.notify(
					`No .md files found in ${shortPath(promptDir)}\nCreate prompt files there to use this extension.`,
					"error",
				);
				return;
			}
			if (files.length === 1) {
				if (files[0] === selectedFile) {
					ctx.ui.notify(`Only one prompt available: ${files[0]} (already selected)`, "info");
					return;
				}
				selectedFile = files[0];
				saveState();
				loadPrompt();
				updateStatus(ctx);
				ctx.ui.notify(
					`Selected: ${selectedFile} (${promptContent?.length ?? 0} chars). Takes effect on next message.`,
					"info",
				);
				return;
			}

			const choice = await ctx.ui.select(
				"Select system prompt",
				files.map((f) => (f === selectedFile ? `${f}  ✓` : f)),
			);
			if (!choice) return;

			// Strip the checkmark suffix if present
			const file = choice.replace(/\s+✓$/, "");
			if (file === selectedFile) return;

			selectedFile = file;
			saveState();
			loadPrompt();
			updateStatus(ctx);
			ctx.ui.notify(
				`Selected: ${selectedFile} (${promptContent?.length ?? 0} chars). Takes effect on next message.`,
				"info",
			);
		},
	});

	pi.registerCommand("system-prompt-mode", {
		description: "Toggle mode (replace: use selected file | append: add along with Pi's prompt)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "replace" || arg === "append") {
				mode = arg;
			} else if (arg === "" || arg === "toggle") {
				mode = mode === "replace" ? "append" : "replace";
			} else {
				ctx.ui.notify(`Usage: /system-prompt-mode [replace|append]`, "error");
				return;
			}
			saveState();
			ctx.ui.notify(
				`Mode: ${mode}. Takes effect on next message.`,
				"info",
			);
		},
	});

	pi.registerCommand("system-prompt-show", {
		description: "Show first ~800 chars of the loaded custom system prompt",
		handler: async (_args, ctx) => {
			if (!promptContent) {
				ctx.ui.notify(`Not loaded: ${loadError ?? "unknown error"}`, "error");
				return;
			}
			const preview = promptContent.slice(0, 800);
			const tail = promptContent.length > 800 ? "\n\n[... truncated]" : "";
			ctx.ui.notify(`${preview}${tail}`, "info");
		},
	});

	pi.registerShortcut("ctrl+shift+e", {
		description: "Edit the selected system prompt",
		handler: async (ctx) => {
			if (!selectedFile) {
				ctx.ui.notify(`Prompt not loaded: ${loadError ?? "no file selected"}`, "error");
				return;
			}

			const edited = await ctx.ui.editor(
				`Edit system prompt: ${selectedFile}`,
				promptContent ?? "",
			);
			if (edited === undefined) return;
			if (!edited.trim()) {
				ctx.ui.notify("System prompt was left unchanged: empty prompts are not saved.", "warning");
				return;
			}

			const filePath = path.join(promptDir, selectedFile);
			const tempPath = `${filePath}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(tempPath, edited, { encoding: "utf-8", flag: "wx" });
				fs.renameSync(tempPath, filePath);
				loadPrompt();
				updateStatus(ctx);
				ctx.ui.notify(
					`Saved ${selectedFile}.${enabled ? " Takes effect on your next message." : " Custom prompt is disabled."}`,
					"info",
				);
			} catch (err) {
				try {
					fs.unlinkSync(tempPath);
				} catch {}
				ctx.ui.notify(
					`Could not save ${selectedFile}: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// --- Lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Re-read on every start so a hand-edited file gets picked up.
		loadPrompt();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("system-prompt", undefined);
	});

	// --- Inject the prompt ---------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		// Graceful no-op when disabled or when the prompt file is missing/unreadable.
		if (!enabled || !promptContent) return;

		const opts = event.systemPromptOptions;
		const appendSystemPrompt: string = opts?.appendSystemPrompt ?? "";
		const customPrompt: string = opts?.customPrompt ?? "";

		// Build tool listing preserving tool names
		const snippets = opts?.toolSnippets ?? {};
		const toolLines = Object.entries(snippets)
			.map(([name, desc]) => `- ${name}: ${desc}`)
			.join("\n");
		const toolsSection = toolLines
			? "\n\n## Available tools\n\n" +
				"The following tools are available in this environment. " +
				"Use them as described below instead of the tools mentioned in the system prompt above.\n\n" +
				toolLines
			: "";

		if (mode === "replace") {
			// Custom prompt is the base. Stack Pi's tools + user customizations after.
			// Mirror pi's own assembly order (system-prompt.js): append → context →
			// skills → date → cwd, so we don't silently drop project context files
			// or the <available_skills> block that tells the model which SKILL.md
			// files it can read.
			const now = new Date();
			const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
			const cwd = opts?.cwd ?? "unknown";
			const customSection = customPrompt ? `\n\n${customPrompt}` : "";
			const appendSection = appendSystemPrompt
				? `\n\n${appendSystemPrompt}`
				: "";
			const contextFiles = opts?.contextFiles ?? [];
			const contextSection =
				contextFiles.length > 0
					? "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
						contextFiles
							.map(
								(f) =>
									`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>\n\n`,
							)
							.join("") +
						"</project_context>\n"
					: "";
			// Emit the <available_skills> block so the model knows which SKILL.md
			// files it can read. Skills with disableModelInvocation=true are hidden.
			const skills: Skill[] = opts?.skills ?? [];
			const skillsSection = skills.length > 0 ? formatSkillsBlock(skills) : "";
			return {
				systemPrompt:
					promptContent +
					toolsSection +
					customSection +
					appendSection +
					contextSection +
					skillsSection +
					`\nCurrent date: ${dateStr}` +
					`\nCurrent working directory: ${cwd}`,
			};
		}

		// Append mode: keep Pi's prompt, add custom prompt as an extra section.
		// event.systemPrompt already includes appendSystemPrompt, so no need
		// to re-add it.
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n---\n\n## Custom system prompt\n\n" +
				promptContent,
		};
	});
}
