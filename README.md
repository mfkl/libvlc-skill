# libvlc-skill

An LLM skill document that gives AI coding assistants deep knowledge of the **libvlc** API (both **3.x** and **4.x**), the multimedia framework behind VLC media player.

Works with any tool that supports loading context documents, including Claude Code, Codex, Cursor, Windsurf, and others.

## What it does

When loaded into an LLM's context, this skill provides:

- **API Reference** for all libvlc domains (instance, media, playback, audio, video, events, tracks, etc.) with version-specific annotations
- **Language bindings** for C, C#/LibVLCSharp, Python, Java, Go, and C++
- **Common workflows** like basic playback, playlists, thumbnailing, recording, and track selection — with both 3.x and 4.x code examples
- **Platform integration** for Windows, macOS, Linux, Android, iOS, and embedded frameworks (WPF, WinForms, GTK, Qt, etc.)
- **Streaming & transcoding** recipes
- **Troubleshooting** for common pitfalls (deadlocks, threading, memory leaks)
- **libvlc 4.x new APIs**: GPU rendering pipeline, tracklist API, program API, watch time, A-B loop, picture/thumbnail request, concurrency primitives
- **Migration guide** (§13) with complete 3.x → 4.x mapping tables for function signatures, removed APIs, and type changes

## Usage

**Claude Code:**
```
claude skill install mfkl/libvlc-skill
```

**Other tools:** Add `libvlc-skill.md` to your project's context or documentation directory so your AI assistant can reference it.

## Version coverage

This skill covers both **libvlc 3.x** (VLC 3.0.x) and **libvlc 4.x** (VLC 4.0+). Where APIs differ between versions, inline markers indicate which version applies:

- No marker — same in both versions
- `[3.x]` — only in libvlc 3.x (removed in 4.x)
- `[4.x]` — new in libvlc 4.x
- `[4.x change]` — exists in both but signature changed
