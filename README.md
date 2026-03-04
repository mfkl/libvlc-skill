# libvlc-skill

A Claude Code plugin that gives AI coding assistants deep knowledge of the **libvlc** API (both **3.x** and **4.x**), the multimedia framework behind VLC media player.

## What it does

When loaded into an LLM's context, this skill provides:

- **API Reference** for all libvlc domains (instance, media, playback, audio, video, events, tracks, etc.) with version-specific annotations
- **Language bindings** for C, C#/LibVLCSharp, Python, Java, Go, and C++
- **Common workflows** like basic playback, playlists, thumbnailing, recording, and track selection, with both 3.x and 4.x code examples
- **Platform integration** for Windows, macOS, Linux, Android, iOS, and embedded frameworks (WPF, WinForms, GTK, Qt, etc.)
- **Streaming & transcoding** recipes
- **Troubleshooting** for common pitfalls (deadlocks, threading, memory leaks)
- **libvlc 4.x new APIs**: GPU rendering pipeline, tracklist API, program API, watch time, A-B loop, picture/thumbnail request, concurrency primitives
- **Migration guide** (§13) with complete 3.x → 4.x mapping tables for function signatures, removed APIs, and type changes

## Installation

**As a Claude Code plugin (recommended):**

Clone the repo and add it as a plugin:
```bash
git clone https://github.com/mfkl/libvlc-skill.git
claude --plugin-dir ./libvlc-skill
```

Or add it to your project's `.claude/settings.json`:
```json
{
  "plugins": ["path/to/libvlc-skill"]
}
```

**Manual (copy skills directly):**
```bash
mkdir -p ~/.claude/skills/libvlc
curl -sL https://raw.githubusercontent.com/mfkl/libvlc-skill/main/skills/libvlc/SKILL.md -o ~/.claude/skills/libvlc/SKILL.md
curl -sL https://raw.githubusercontent.com/mfkl/libvlc-skill/main/skills/libvlc/libvlc-skill.md -o ~/.claude/skills/libvlc/libvlc-skill.md
```

**Other tools:** Add `skills/libvlc/libvlc-skill.md` to your project's context or documentation directory so your AI assistant can reference it.

## Structure

```
libvlc-skill/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── skills/
│   └── libvlc/
│       ├── SKILL.md             # Skill entrypoint with frontmatter
│       └── libvlc-skill.md     # Full reference (~3600 lines)
└── README.md
```

## Version coverage

This skill covers both **libvlc 3.x** (VLC 3.0.x) and **libvlc 4.x** (VLC 4.0+). Where APIs differ between versions, inline markers indicate which version applies:

- No marker: same in both versions
- `[3.x]`: only in libvlc 3.x (removed in 4.x)
- `[4.x]`: new in libvlc 4.x
- `[4.x change]`: exists in both but signature changed

## License

MIT
