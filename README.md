# libvlc-skill

An LLM skill document that gives AI coding assistants deep knowledge of the **libvlc 3.x** API, the multimedia framework behind VLC media player.

Works with any tool that supports loading context documents, including Claude Code, Codex, Cursor, Windsurf, and others.

## What it does

When loaded into an LLM's context, this skill provides:

- **API Reference** for all libvlc 3.x domains (instance, media, playback, audio, video, events, etc.)
- **Language bindings** for C, C#/LibVLCSharp, Python, Java, Go, and C++
- **Common workflows** like basic playback, playlists, thumbnailing, and recording
- **Platform integration** for Windows, macOS, Linux, Android, iOS, and embedded frameworks (WPF, WinForms, GTK, Qt, etc.)
- **Streaming & transcoding** recipes
- **Troubleshooting** for common pitfalls (deadlocks, threading, memory leaks)

## Usage

**Claude Code:**
```
claude skill install mfkl/libvlc-skill
```

**Other tools:** Add `libvlc-skill.md` to your project's context or documentation directory so your AI assistant can reference it.

## Scope

This skill targets **libvlc 3.x** only (VLC 3.0.x series). LibVLC 4.x introduces breaking API changes that are not covered.
