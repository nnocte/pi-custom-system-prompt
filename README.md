# pi-custom-system-prompt

A [pi](https://pi.dev) extension that loads a custom system prompt from a markdown file and injects it into every agent turn. Works with any model or provider — nothing is hardcoded.

Multiple `.md` files can live in the prompt directory; pick which one is active with `/system-prompt-select`. All changes take effect on the very next message you send — no `/new` or session restart required.

## Commands

| Command | What it does |
|---|---|
| `/system-prompt-info` | Show loaded path, size, mode, enabled state, available files |
| `/system-prompt-toggle` | Enable or disable the custom prompt |
| `/system-prompt-reload` | Re-read the selected prompt file from disk |
| `/system-prompt-mode [replace\|append]` | Toggle or set the merge mode |
| `/system-prompt-show` | Print the first ~800 chars of the loaded prompt |
| `/system-prompt-select` | Pick a different prompt file from the directory |

Press **Ctrl+Shift+E** to edit the selected prompt in Pi's built-in editor. Saving updates the Markdown file immediately; the new content is used on your next message. Cancelling leaves the file unchanged, and an empty prompt is not saved.

## Modes

**`append`** (default) — keep Pi's default system prompt as the base, and add the custom prompt as an extra section. Safest for most models, since Pi's tool descriptions stay authoritative.

**`replace`** — use the custom prompt as the base system prompt. Pi appends the following after it, so nothing Pi would normally load is lost: the available-tools listing (with a note to use those tools instead of any fictional ones mentioned in the custom prompt), any `--append-system-prompt` text, project context files (e.g. `AGENTS.md`, `.pi/rules`) wrapped in `<project_context>`, the `<available_skills>` block listing loadable `SKILL.md` files, the current date, and the working directory.

The project-context and skills blocks are mirrored from Pi's own prompt assembly, so in `replace` mode the model sees the same project instructions and skill list it would in `append` mode — the custom prompt just becomes the base instead of an add-on.

## Setup

### 1. Install the extension

```bash
pi install npm:pi-custom-system-prompt
```

Or try it without installing:

```bash
pi -e npm:pi-custom-system-prompt
```

### 2. Create the prompt directory

```bash
mkdir -p ~/.pi/agent/system-prompts
```

The extension reads from this directory by default. To use a different location, set the `PI_SYSTEM_PROMPT_DIR` environment variable.

### 3. Add a markdown file

```bash
# Example: a focused prompt for a specific model
cat > ~/.pi/agent/system-prompts/claude-code.md <<'EOF'
You are a careful, terse coding assistant.
- Read files before editing them.
- Prefer minimal diffs.
- Explain non-obvious choices in one sentence.
EOF

# Another example: a personality-style prompt
cat > ~/.pi/agent/system-prompts/pirate.md <<'EOF'
You are a pirate captain. Speak in pirate vernacular but stay accurate
about technical content. Never break character.
EOF
```

The first file (alphabetical) is auto-selected on first run. Use `/system-prompt-select` to switch between them.

### 4. Verify and toggle

```bash
# inside pi:
/system-prompt-info        # confirm the file loaded
/system-prompt-toggle off  # disable without deleting the file
/system-prompt-toggle on   # re-enable
```

The footer shows the active state:

```
system-prompt: claude-code.md    # enabled, showing the file
system-prompt: enabled           # enabled, no file selected
system-prompt: disabled          # disabled
```

## How it works

- The extension subscribes to `before_agent_start`, which fires on every user message. It reads the selected `.md` file from the prompt directory, then either appends it to or replaces Pi's resolved system prompt before sending to the model.
- Ctrl+Shift+E opens the selected file's contents in Pi's built-in editor and saves edits back to that file.
- In `replace` mode, the extension reconstructs the prompt as `customPrompt + tools + appendSystemPrompt + <project_context> + <available_skills> + date + cwd`, matching Pi's own assembly order so project context files and skills survive the swap. The available-skills block is emitted by a small inlined helper that mirrors Pi's `formatSkillsForPrompt` exactly (same XML escaping, same `disableModelInvocation` filtering); it is inlined rather than imported so the extension takes no runtime dependency on the host package and stays resolvable regardless of `node_modules` topology.
- State (`enabled`, `mode`, `selectedFile`) persists to `~/.pi/agent/state/system-prompt.json` and is reloaded on the next start.
- All commands are non-destructive: they mutate in-memory state, save to the state file, and take effect on the next message.
- If the prompt directory is missing, has no `.md` files, or the selected file is empty/unreadable, the extension logs the reason to `/system-prompt-info` and falls back to Pi's default prompt with no error.

## Removing the extension

```bash
pi remove npm:pi-custom-system-prompt
```

This unloads the extension but does not delete your prompt files in `~/.pi/agent/system-prompts/` or your saved state in `~/.pi/agent/state/system-prompt.json`. Delete those manually if you want a clean uninstall:

```bash
rm -rf ~/.pi/agent/system-prompts
rm -f  ~/.pi/agent/state/system-prompt.json
```

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_SYSTEM_PROMPT_DIR` | `~/.pi/agent/system-prompts` | Override the directory the extension scans for `.md` prompt files |

## Development

The extension lives in [`extensions/system-prompt.ts`](extensions/system-prompt.ts). To load it from a local checkout during development:

```bash
pi -e /absolute/path/to/pi-custom-system-prompt/extensions/system-prompt.ts
```

For a hot-reload loop, symlink it into the global extensions directory:

```bash
ln -s "$(pwd)/extensions/system-prompt.ts" ~/.pi/agent/extensions/system-prompt.ts
```

Then `/reload` inside pi after each edit.

### Layout

```
pi-custom-system-prompt/
├── extensions/
│   └── system-prompt.ts
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

The `extensions/` directory is a pi convention: any `.ts` file inside it is auto-discovered. The `pi-package` keyword in `package.json` makes the package appear in the [pi package gallery](https://pi.dev/packages).

## License

[MIT](LICENSE)
