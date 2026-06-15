# pi-system-prompt-manager

A [pi](https://pi.dev) extension to manage a library of named **system prompts**, with
per-session enable/disable, runtime selection, and optional per-model scoping.

## Install

```bash
pi install git:github.com/tombystrican/pi-system-prompt-manager
```

Then run `/reload` (or restart pi).

## Usage

Use the `/sysprompt` command:

- `/sysprompt` — interactive menu: pick a prompt, **Disable**, or **➕ Add new prompt…**
- `/sysprompt <name>` — set active prompt and enable it
- `/sysprompt on` / `/sysprompt off` — toggle the active prompt
- `/sysprompt list` — list prompts (● active+on, ○ active+off)
- `/sysprompt add [name]` — create a new prompt (name → description → text → append/replace)
- `/sysprompt edit <name>` — edit an existing prompt's text
- `/sysprompt remove <name>` — delete a prompt

The active prompt shows in the footer status (`sysprompt: <name>` or `sysprompt: off`).

## Scope

Enable/disable and selection are **per session** (keyed by session id), falling back to a
global `default`. Changing the prompt in one session does not affect others, and the choice
persists when you resume that session.

## Per-model prompts

Add a `models` array to a prompt entry to scope it to specific models. When set, the prompt
only applies while one of those models is active:

```json
"review-mode": {
  "description": "Strict review",
  "text": "Be a strict reviewer...",
  "mode": "append",
  "models": ["<provider>/<id>"]
}
```

## Files

The extension stores data under `~/.pi/agent/`:

- `system-prompts.json` — the prompt library (editable by hand)
- `system-prompt-state.json` — per-session `{ enabled, active }` state

## Prompt entry shape

```json
"<name>": {
  "description": "short label shown in menus",
  "text": "the prompt text",
  "mode": "append",                 // "append" (default, keeps pi's prompt) or "replace"
  "models": ["<provider>/<id>"]   // optional scope; omit = all models
}
```

## License

MIT
