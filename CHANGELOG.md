# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ctrl+Shift+E opens the selected custom system prompt in Pi's built-in editor and saves non-empty edits to the prompt file.

## [0.1.1] - 2026-06-27

### Fixed

- **Replace mode no longer drops project context files.** Previously, switching to `replace` mode reconstructed the system prompt from the custom file but omitted the `<project_context>` block Pi builds from `AGENTS.md`, `.pi/rules`, and other configured context files. The model never saw project-specific instructions in `replace` mode. The replace branch now reads `systemPromptOptions.contextFiles` and emits the same `<project_context>` block Pi's own prompt builder produces, in the same assembly order.
- **Replace mode no longer drops skills.** The `<available_skills>` block that tells the model which `SKILL.md` files it can read (frontend-design, librarian, context7-docs, pi-subagents, and any custom skills) was also missing in `replace` mode, so the model would not invoke skills even when a task matched one. The replace branch now reads `systemPromptOptions.skills` and emits the block.
- The available-skills block is produced by an inlined helper (`formatSkillsBlock`) that mirrors Pi's `formatSkillsForPrompt` exactly — same XML escaping, same `disableModelInvocation` filtering — so the extension takes no runtime dependency on the host package and stays resolvable regardless of `node_modules` topology.

### Changed

- Documented the full `replace`-mode assembly order in the README (tools → append → project context → skills → date → cwd).

## [0.1.0] - 2026-06-21

### Added

- Initial release.
- Load a custom system prompt from `~/.pi/agent/system-prompts/<file>.md` and inject it on every agent turn via the `before_agent_start` event.
- Commands: `/system-prompt-info`, `/system-prompt-toggle`, `/system-prompt-reload`, `/system-prompt-mode`, `/system-prompt-show`, `/system-prompt-select`.
- Two modes: `append` (default; keep Pi's prompt as the base and add the custom prompt as an extra section) and `replace` (use the custom prompt as the base, with Pi's tools and user customizations appended after it).
- Multiple `.md` files can coexist in the prompt directory; use `/system-prompt-select` to switch between them.
- Persistent state (`enabled`, `mode`, `selectedFile`) saved to `~/.pi/agent/state/system-prompt.json` and reloaded on next start.
- Footer status widget: `system-prompt: <file>` when enabled, `system-prompt: disabled` when not.
- `PI_SYSTEM_PROMPT_DIR` environment variable to override the default prompt directory.
