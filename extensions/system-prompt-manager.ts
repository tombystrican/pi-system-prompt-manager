import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * System Prompt Manager
 * ---------------------
 * Keep a library of named system prompts, then enable/disable and switch between
 * them at runtime with `/sysprompt`.
 *
 * Files (both live under ~/.pi/agent and are plain JSON you can edit by hand):
 *   - system-prompts.json   the library of named prompts
 *   - system-prompt-state.json   { enabled, active } — which one is active
 *
 * Library entry shape:
 *   "<name>": {
 *     "description": "short label shown in menus",
 *     "text": "the prompt text",
 *     "mode": "append" | "prepend" | "replace",   // default "append"
 *       append  = after pi's system prompt
 *       prepend = before pi's system prompt
 *       replace = replace pi's whole system prompt
 *     "models": ["<provider>/<id>"]  // optional scope; omit = all models
 *   }
 */

const AGENT_DIR = join(homedir(), ".pi", "agent");
const LIBRARY_FILE = join(AGENT_DIR, "system-prompts.json");
const STATE_FILE = join(AGENT_DIR, "system-prompt-state.json");

type PromptEntry = {
	description?: string;
	text: string;
	mode?: "append" | "prepend" | "replace";
	models?: string[];
};
type Library = Record<string, PromptEntry>;
type State = { enabled: boolean; active: string | null };

const DEFAULT_LIBRARY: Library = {
	surgical: {
		description: "Minimal, surgical diffs",
		text: "Prefer minimal, surgical diffs. Explain non-obvious changes briefly. Do not add files or dependencies unless asked.",
		mode: "append",
	},
	concise: {
		description: "Terse, code-first answers",
		text: "Be extremely concise. Prefer code over prose. Skip preamble and summaries unless asked.",
		mode: "append",
	},
	"plan-first": {
		description: "Plan before coding",
		text: "Before writing code, outline a short plan. If the task is ambiguous, ask one clarifying question before proceeding.",
		mode: "append",
	},
};

function readJson<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function loadLibrary(): Library {
	if (!existsSync(LIBRARY_FILE)) {
		try {
			writeFileSync(LIBRARY_FILE, `${JSON.stringify(DEFAULT_LIBRARY, null, 2)}\n`, "utf8");
		} catch {
			/* ignore */
		}
		return DEFAULT_LIBRARY;
	}
	return readJson<Library>(LIBRARY_FILE, DEFAULT_LIBRARY);
}

function saveLibrary(library: Library): void {
	try {
		writeFileSync(LIBRARY_FILE, `${JSON.stringify(library, null, 2)}\n`, "utf8");
	} catch {
		/* ignore */
	}
}

// State is scoped per session (keyed by session id), falling back to a global
// `default` for sessions that haven't set anything yet.
type StateFile = { default: State; sessions: Record<string, State> };

function sessionKey(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "default";
	} catch {
		return "default";
	}
}

function loadStateFile(): StateFile {
	const raw = readJson<Record<string, unknown> | null>(STATE_FILE, null);
	if (!raw || typeof raw !== "object") {
		return { default: { enabled: false, active: null }, sessions: {} };
	}
	// Migrate legacy flat shape: { enabled, active }.
	if ("enabled" in raw && !("sessions" in raw)) {
		return {
			default: { enabled: !!raw.enabled, active: (raw.active as string | null) ?? null },
			sessions: {},
		};
	}
	return {
		default: (raw.default as State) ?? { enabled: false, active: null },
		sessions: (raw.sessions as Record<string, State>) ?? {},
	};
}

function saveStateFile(file: StateFile): void {
	try {
		writeFileSync(STATE_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	} catch {
		/* ignore */
	}
}

function loadState(ctx: ExtensionContext): State {
	const file = loadStateFile();
	return file.sessions[sessionKey(ctx)] ?? file.default ?? { enabled: false, active: null };
}

function saveState(ctx: ExtensionContext, state: State): void {
	const file = loadStateFile();
	file.sessions[sessionKey(ctx)] = state;
	saveStateFile(file);
}

function modelMatches(entry: PromptEntry, model: { provider: string; id: string } | undefined): boolean {
	if (!entry.models || entry.models.length === 0) return true;
	if (!model) return false;
	return entry.models.includes(`${model.provider}/${model.id}`) || entry.models.includes(model.id);
}

function statusText(state: State): string {
	if (!state.enabled || !state.active) return "sysprompt: off";
	return `sysprompt: ${state.active}`;
}

function updateStatus(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus("sysprompt", statusText(loadState(ctx)));
	} catch {
		/* ignore */
	}
}

export default function (pi: ExtensionAPI) {
	loadLibrary(); // seed defaults on first run

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	// Apply the active prompt to each turn.
	pi.on("before_agent_start", (event, ctx) => {
		const state = loadState(ctx);
		if (!state.enabled || !state.active) return;

		const library = loadLibrary();
		const entry = library[state.active];
		if (!entry || !entry.text) return;
		if (!modelMatches(entry, ctx.model)) return;

		let systemPrompt: string;
		if (entry.mode === "replace") {
			systemPrompt = entry.text;
		} else if (entry.mode === "prepend") {
			systemPrompt = `${entry.text}\n\n${event.systemPrompt}`;
		} else {
			systemPrompt = `${event.systemPrompt}\n\n${entry.text}`;
		}

		if (systemPrompt === event.systemPrompt) return;
		return { systemPrompt };
	});

	pi.registerCommand("sysprompt", {
		description: "Manage system prompts: choose / enable / disable",
		getArgumentCompletions: (prefix: string) => {
			const names = Object.keys(loadLibrary());
			const items = ["off", "on", "list", "add", "edit", "remove", ...names].map((v) => ({
				value: v,
				label: v,
			}));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const library = loadLibrary();
			const state = loadState(ctx);
			const arg = (args ?? "").trim();
			const [sub, ...restParts] = arg.split(/\s+/);
			const restName = restParts.join(" ").trim();

			// Interactive create flow.
			const createPrompt = async (preName?: string) => {
				const name = (preName ?? (await ctx.ui.input("New prompt name (id):", "e.g. review-mode")) ?? "").trim();
				if (!name) return;
				if (library[name]) {
					ctx.ui.notify(`"${name}" already exists. Use /sysprompt edit ${name}.`, "error");
					return;
				}
				const description = ((await ctx.ui.input("Short description (optional):", "")) ?? "").trim();
				const text = ((await ctx.ui.editor(`Prompt text for "${name}":`, "")) ?? "").trim();
				if (!text) {
					ctx.ui.notify("No text entered — cancelled.", "warning");
					return;
				}
				const modeChoice = await ctx.ui.select("Apply mode", [
					"append — add after pi's prompt",
					"prepend — add before pi's prompt",
					"replace — replace pi's whole prompt",
				]);
				const mode: "append" | "prepend" | "replace" = modeChoice?.startsWith("replace")
					? "replace"
					: modeChoice?.startsWith("prepend")
						? "prepend"
						: "append";
				library[name] = { description: description || undefined, text, mode };
				saveLibrary(library);
				saveState(ctx, { enabled: true, active: name });
				updateStatus(ctx);
				ctx.ui.notify(`Saved and activated system prompt: ${name}`, "info");
			};

			// `/sysprompt add [name]` or `/sysprompt new [name]`
			if (sub === "add" || sub === "new") {
				await createPrompt(restName || undefined);
				return;
			}

			// `/sysprompt edit <name>`
			if (sub === "edit") {
				const name = restName;
				if (!name || !library[name]) {
					ctx.ui.notify(`Usage: /sysprompt edit <name>. Try /sysprompt list.`, "error");
					return;
				}
				const text = ((await ctx.ui.editor(`Edit "${name}":`, library[name].text)) ?? "").trim();
				if (!text) {
					ctx.ui.notify("No text entered — unchanged.", "warning");
					return;
				}
				library[name] = { ...library[name], text };
				saveLibrary(library);
				ctx.ui.notify(`Updated system prompt: ${name}`, "info");
				return;
			}

			// `/sysprompt remove|delete|rm <name>`
			if (sub === "remove" || sub === "delete" || sub === "rm") {
				const name = restName;
				if (!name || !library[name]) {
					ctx.ui.notify(`Usage: /sysprompt remove <name>. Try /sysprompt list.`, "error");
					return;
				}
				const ok = await ctx.ui.confirm("Delete prompt", `Remove "${name}" from the library?`);
				if (!ok) return;
				delete library[name];
				saveLibrary(library);
				if (state.active === name) {
					saveState(ctx, { enabled: false, active: null });
					updateStatus(ctx);
				}
				ctx.ui.notify(`Removed system prompt: ${name}`, "info");
				return;
			}

			// `/sysprompt list`
			if (arg === "list") {
				const lines = Object.entries(library).map(([name, e]) => {
					const mark = state.active === name ? (state.enabled ? "● " : "○ ") : "  ";
					const scope = e.models?.length ? ` [${e.models.join(", ")}]` : "";
					return `${mark}${name} — ${e.description ?? e.mode ?? "append"}${scope}`;
				});
				ctx.ui.notify(
					`System prompts (${state.enabled ? "enabled" : "disabled"}):\n${lines.join("\n") || "(empty)"}`,
					"info",
				);
				return;
			}

			// `/sysprompt off`
			if (arg === "off") {
				saveState(ctx, { ...state, enabled: false });
				updateStatus(ctx);
				ctx.ui.notify("System prompt disabled.", "info");
				return;
			}

			// `/sysprompt on`
			if (arg === "on") {
				if (!state.active) {
					ctx.ui.notify("No active prompt. Run /sysprompt <name> first.", "warning");
					return;
				}
				saveState(ctx, { ...state, enabled: true });
				updateStatus(ctx);
				ctx.ui.notify(`System prompt enabled: ${state.active}`, "info");
				return;
			}

			// `/sysprompt <name>`
			if (arg) {
				if (!library[arg]) {
					ctx.ui.notify(`Unknown prompt "${arg}". Try /sysprompt list.`, "error");
					return;
				}
				saveState(ctx, { enabled: true, active: arg });
				updateStatus(ctx);
				ctx.ui.notify(`Active system prompt: ${arg} (enabled)`, "info");
				return;
			}

			// No args → interactive menu.
			const names = Object.keys(library);
			const OFF = "⨯ Disable system prompt";
			const ADD = "➕ Add new prompt…";
			const options = [
				OFF,
				ADD,
				...names.map((n) => {
					const active = state.active === n && state.enabled ? " (active)" : "";
					return `${n} — ${library[n].description ?? library[n].mode ?? "append"}${active}`;
				}),
			];
			const choice = await ctx.ui.select("System prompt", options);
			if (choice === undefined) return; // cancelled

			if (choice === OFF) {
				saveState(ctx, { ...state, enabled: false });
				updateStatus(ctx);
				ctx.ui.notify("System prompt disabled.", "info");
				return;
			}

			if (choice === ADD) {
				await createPrompt();
				return;
			}

			const picked = names[options.indexOf(choice) - 2];
			saveState(ctx, { enabled: true, active: picked });
			updateStatus(ctx);
			ctx.ui.notify(`Active system prompt: ${picked} (enabled)`, "info");
		},
	});
}
