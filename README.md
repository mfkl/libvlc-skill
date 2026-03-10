# libvlc-skill

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/mfkl/libvlc-skill/actions/workflows/verify-signatures.yml/badge.svg)](https://github.com/mfkl/libvlc-skill/actions)

A Claude Code plugin that gives AI coding assistants deep knowledge of the **libvlc** API (both **3.x** and **4.x**), the multimedia framework behind VLC media player.

## Why?

LLMs frequently hallucinate libvlc API signatures, confuse 3.x and 4.x function names, and lack awareness of platform-specific integration patterns. This skill injects a structured, version-accurate ~3600-line reference directly into the LLM context so it can generate correct code the first time.

## Base Claude vs With Skill

| Area | Base Claude | With Skill |
|------|-------------|------------|
| libvlc 3.x basic API | Good general knowledge | Precise signatures, correct parameter names |
| libvlc 4.x API | Weak/incomplete (training cutoff issues) | Comprehensive, with exact signature changes |
| 3.x vs 4.x differences | Would likely confuse versions | Clear side-by-side with markers |
| Threading/deadlock rules | Knows the general concept | Per-language solutions with correct patterns |
| Sout chain syntax | Approximate knowledge | Exact syntax with tested recipes |
| Platform embedding (Win32/GTK/Qt) | General patterns | Full working samples from official VLC examples |
| LibVLCSharp specifics | General .NET patterns | Exact API (MediaPlayerElement, VideoView, callbacks) |
| Plugin discovery / VLC_PLUGIN_PATH | Likely incomplete | Detailed coverage from source code |
| GPU rendering pipeline (4.x) | Likely unknown | Full callback setup with D3D11 example |
| Parse flag value changes | Would likely use wrong values | Correct values for both versions |

## How it works

The skill is a curated markdown reference that Claude Code loads automatically when your prompt mentions libvlc-related keywords. It covers every public API function with accurate signatures, version markers, code examples across 6 languages, and platform recipes. No external calls, no RAG, just precise context delivered when needed.

**Trigger keywords**: `libvlc`, `libVLC`, `VLC SDK`, `LibVLCSharp`, `python-vlc`, `vlcj`, `vlcpp`, or any VLC-based media playback, streaming, or transcoding prompt.

## What it provides

- **API Reference** for all libvlc domains (instance, media, playback, audio, video, events, tracks, etc.) with version-specific annotations
- **Language bindings** for C, C#/LibVLCSharp, Python, Java, Go, and C++
- **Common workflows** like basic playback, playlists, thumbnailing, recording, and track selection, with both 3.x and 4.x code examples
- **Platform integration** for Windows, macOS, Linux, Android, iOS, and embedded frameworks (WPF, WinForms, GTK, Qt, etc.)
- **Streaming & transcoding** recipes
- **Troubleshooting** for common pitfalls (deadlocks, threading, memory leaks)
- **libvlc 4.x new APIs**: GPU rendering pipeline, tracklist API, program API, watch time, A-B loop, picture/thumbnail request, concurrency primitives
- **Migration guide** with complete 3.x → 4.x mapping tables for function signatures, removed APIs, and type changes

## Usage example

Once installed, just ask naturally. The skill activates automatically:

```
> Write a C# app that plays a video file with LibVLCSharp

> How do I select an audio track in libvlc 4.x?

> Convert my python-vlc 3.x code to 4.x
```

Claude will use the full API reference to generate accurate, version-correct code with proper function signatures.

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

## Compatibility

This plugin is built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). The skill markdown files can also be used as context with any LLM tool that supports loading reference documents.

## Structure

```
libvlc-skill/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── .github/
│   └── workflows/
│       └── verify-signatures.yml # Daily CI to verify API accuracy
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

## Related projects

- [LibVLCSharp](https://github.com/videolan/LibVLCSharp) - .NET/C# bindings for libvlc
- [python-vlc](https://github.com/oaubert/python-vlc) - Python bindings for libvlc
- [vlcj](https://github.com/caprica/vlcj) - Java bindings for libvlc
- [libvlcpp](https://code.videolan.org/videolan/libvlcpp) - C++ bindings for libvlc

## Contributing

PRs welcome, especially for new language binding examples, 4.x API coverage, and platform-specific recipes. If you spot an incorrect API signature, please open an issue.

## License

MIT
