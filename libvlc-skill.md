# LibVLC — LLM Skill Document

> **Version scope: libvlc 3.x** (VLC 3.0.x series). All API signatures, behavior descriptions, and code examples in this document target the **3.x** release line. LibVLC 4.x introduces breaking API changes (new rendering pipeline, different callback signatures, removed/renamed functions) that are **not covered here**. If a user is working with libvlc 4.x, warn them that this reference may not apply and suggest consulting the 4.x headers directly.

You are an expert assistant for developers using **libvlc 3.x** — the multimedia framework behind VLC media player. You help with API usage, code generation, debugging, and architecture decisions across all supported languages and platforms.

## How to Use This Document

- **API lookup**: Jump to §3 (API Reference) for function signatures, parameters, return types
- **Code generation**: Jump to §4 (Language Bindings) for the target language, then §5 (Workflows) for the pattern
- **Debugging**: Jump to §8 (Troubleshooting) for known pitfalls and fixes
- **Platform setup**: Jump to §6 (Platform Integration) for OS/framework-specific embedding
- **Streaming**: Jump to §7 (Streaming & Transcoding) for sout chains and Chromecast

### ⚠️ LibVLC 4.x Warning

This document covers **libvlc 3.x only**. LibVLC 4.x (used by LibVLCSharp master, Unity plugin, and upcoming VLC 4.0) has significant breaking changes including:

- **New rendering pipeline** — GPU-accelerated output callbacks replace the CPU-copy video callbacks documented here
- **Changed/removed functions** — many function signatures differ; some 3.x APIs are removed entirely
- **Different binding APIs** — LibVLCSharp 4.x, for example, introduces `MediaConfiguration` and new rendering APIs not present in 3.x

If the user mentions libvlc 4.x, VLC 4, LibVLCSharp master branch, or Unity VLC plugin, **warn them** that the API guidance in this document may not apply and recommend consulting the 4.x headers or binding documentation directly.

---

## §1. Architecture Overview

### What is LibVLC

LibVLC is a C library providing the core multimedia engine of VLC. It handles media playback, streaming, transcoding, and device discovery. Applications embed libvlc to add multimedia capabilities.

**Three-layer architecture:**
1. **`libvlc.dll`/`libvlc.so`/`libvlc.dylib`** — Public API (what bindings call). ~200 functions.
2. **`libvlccore`** — Internal API (not for public consumption). The VLC desktop app uses this directly, NOT libvlc.
3. **360+ plugins** — Organized in subdirectories: `access/`, `codec/`, `demux/`, `video_output/`, `audio_output/`, `stream_out/`, etc. Loaded dynamically at runtime.

### Processing Pipeline

**Regular playback:**
```
Input → Access → Demux → Decode → Video/Audio Output
```

**Streaming/transcoding:**
```
Input → Access → Demux → Decode → Encode (optional) → Remux → Stream Output
```

### Object Model

All libvlc types are **opaque pointers** with **reference counting** (`retain`/`release`). The core types:

```
libvlc_instance_t          — Root context. Create ONE per application.
├── libvlc_media_t         — A media resource (file, URL, stream, file descriptor)
├── libvlc_media_player_t  — Playback engine (most-used type, ~123 C functions)
├── libvlc_media_list_t    — Ordered collection of media items
├── libvlc_media_list_player_t — Plays a media list sequentially/randomly
├── libvlc_media_discoverer_t  — Discovers network services (UPnP, DLNA)
├── libvlc_renderer_discoverer_t — Discovers renderers (Chromecast)
├── libvlc_media_library_t — Media library (minimal API)
└── libvlc_event_manager_t — Per-object event subscription
```

### Critical Rule: Single Instance

**Create exactly ONE `libvlc_instance_t` per application.** Multiple instances cause undefined behavior due to global state (plugin registry, locale settings). Multiple media players sharing one instance is the correct pattern.

---

## §2. Core Concepts

### 2.1 Object Lifecycle (Reference Counting)

Every libvlc object uses manual reference counting:
- `*_new()` / `*_new_*()` — Creates object (refcount = 1)
- `*_retain()` — Increments refcount
- `*_release()` — Decrements refcount; frees at 0

**In C:** You must call `_release()` on every object you create or retain.
**In bindings:** Varies — C# uses `IDisposable`, Python uses GC integration, Java requires explicit `release()`.

```c
// C lifecycle
libvlc_instance_t *inst = libvlc_new(0, NULL);
libvlc_media_t *media = libvlc_media_new_path(inst, "/path/to/file.mp4");
libvlc_media_player_t *mp = libvlc_media_player_new_from_media(media);
libvlc_media_release(media);  // Player retains its own reference
libvlc_media_player_play(mp);
// ... later ...
libvlc_media_player_release(mp);
libvlc_release(inst);
```

### 2.2 Threading Rules

**CRITICAL — The #1 source of bugs across all bindings:**

> **NEVER call any libvlc function from within a libvlc event callback.** LibVLC is not reentrant. Calling back into libvlc from a callback thread causes **deadlock**.

**Wrong (ALL languages):**
```
on_end_reached(event):
    player.play(next_media)   // DEADLOCK — calling libvlc from callback thread
```

**Correct pattern — offload to another thread:**

| Language | Solution |
|----------|----------|
| C | `pthread_create()` or queue + worker thread |
| C# | `ThreadPool.QueueUserWorkItem(_ => player.Play(next))` |
| Python | `queue.Queue()` → process in main loop |
| Java | `mediaPlayer.submit(() -> mp.media().play(next))` |
| Go | `go func() { player.Play(next) }()` |

### 2.3 Event System

Each object has an event manager obtained via `*_event_manager()`. Events are typed — see §3.6 for the full list.

**Pattern (C):**
```c
void on_playing(const libvlc_event_t *event, void *userdata) {
    // DO NOT call libvlc functions here
    // Signal your main thread instead
}

libvlc_event_manager_t *em = libvlc_media_player_event_manager(mp);
libvlc_event_attach(em, libvlc_MediaPlayerPlaying, on_playing, my_context);
// ... later ...
libvlc_event_detach(em, libvlc_MediaPlayerPlaying, on_playing, my_context);
```

### 2.4 Error Handling

- Most functions return `0` on success, `-1` on error
- `libvlc_errmsg()` returns the last error message (thread-local)
- `libvlc_clearerr()` clears the error
- Some functions return `NULL` on failure (e.g., `libvlc_new()`)

### 2.5 Logging

```c
// Set log callback
void log_cb(void *data, int level, const libvlc_log_t *ctx,
            const char *fmt, va_list args) {
    // level: LIBVLC_DEBUG=0, LIBVLC_NOTICE=2, LIBVLC_WARNING=3, LIBVLC_ERROR=4
    vfprintf(stderr, fmt, args);
}
libvlc_log_set(inst, log_cb, NULL);

// Or log to file
libvlc_log_set_file(inst, fopen("vlc.log", "w"));

// Unset (restore default)
libvlc_log_unset(inst);
```

### 2.6 Clock & Timing

```c
int64_t libvlc_clock(void);   // Current system clock in microseconds
int64_t libvlc_delay(int64_t pts);  // pts - clock (how long until pts)
```

### 2.7 Plugin Discovery & `VLC_PLUGIN_PATH`

LibVLC discovers plugins (codecs, demuxers, video outputs, etc.) at startup during `libvlc_new()`. Understanding the plugin loading mechanism is **critical** for deployment — most "no suitable decoder" or "no audio/video output" errors trace back to plugins not being found.

**Plugin search order** (from `src/modules/bank.c`):

1. **Static modules** — compiled-in plugins (used on iOS, some embedded builds)
2. **Default plugin directory** — platform-dependent:
   - **Linux/macOS/Windows desktop**: `<libvlc-install-dir>/plugins/` (relative to `libvlc.so`/`libvlc.dll`/`libvlc.dylib`)
   - **Windows Store (UWP)**: `plugins/` relative to app package root
   - **iOS**: plugins are flattened into the app bundle's library directory (no `plugins/` subfolder)
3. **`VLC_PLUGIN_PATH` environment variable** — **additive**, checked AFTER the default directory. Supports multiple paths separated by `:` (Unix) or `;` (Windows)

**Key behaviors:**
- `VLC_PLUGIN_PATH` **does not replace** the default path — it adds additional directories to scan
- Directories are scanned recursively up to **5 levels deep**
- Plugins must match the naming pattern `lib*_plugin.so` (Linux), `lib*_plugin.dylib` (macOS), or `*_plugin.dll` (Windows)
- A **`plugins.dat` cache file** is generated in each plugin directory after the first scan, significantly speeding up subsequent loads
- If the cache is stale (plugin file modified/updated), it is automatically invalidated and the plugin is re-scanned

**Setting `VLC_PLUGIN_PATH`:**

```c
// Before calling libvlc_new():
// Linux/macOS:
setenv("VLC_PLUGIN_PATH", "/opt/vlc-plugins:/usr/local/lib/vlc/plugins", 1);
// Windows:
_putenv("VLC_PLUGIN_PATH=C:\\vlc\\plugins;D:\\extra-plugins");

libvlc_instance_t *inst = libvlc_new(0, NULL);
```

```csharp
// C# — set before creating LibVLC:
Environment.SetEnvironmentVariable("VLC_PLUGIN_PATH", "/path/to/plugins");
using var libVLC = new LibVLC();
```

```python
# Python — set before importing vlc or creating Instance:
import os
os.environ["VLC_PLUGIN_PATH"] = "/path/to/plugins"
import vlc
instance = vlc.Instance()
```

**Related CLI options** (passed to `libvlc_new()`):
- `--plugins-cache` — use the plugins cache (default: enabled). Disable with `--no-plugins-cache` to force re-scanning on every startup.
- `--plugins-scan` — scan plugin directories (default: enabled). Disable with `--no-plugins-scan` to only load from cache (faster startup, but new plugins won't be found).
- `--reset-plugins-cache` — force rebuild the `plugins.dat` cache file on next startup.

**Common deployment issues:**
- **"No suitable decoder"** — plugins directory not found or codec plugin missing. Verify `VLC_PLUGIN_PATH` points to a directory containing `libavcodec_plugin.*`
- **"No audio/video output"** — output plugins missing. Ensure `libaout_*` / `libvout_*` plugins are present
- **Slow startup** — first launch scans all plugins. Pre-generate cache or reuse the instance. On mobile, prefer static linking.
- **Custom plugin directory** — when redistributing libvlc, ship `plugins/` alongside `libvlc.so`/`.dll`, or set `VLC_PLUGIN_PATH`

---

## §3. API Reference by Domain

### 3.1 Instance (`libvlc_instance_t`)

| Function | Description |
|----------|-------------|
| `libvlc_new(argc, argv)` | Create instance. `argv` = VLC CLI args (e.g., `"--verbose=2"`). Returns `NULL` on failure. |
| `libvlc_release(inst)` | Release instance (decrement refcount) |
| `libvlc_retain(inst)` | Increment refcount |
| `libvlc_add_intf(inst, name)` | Add interface module (e.g., `"http"` for web control). `NULL` = default. |
| `libvlc_set_exit_handler(inst, cb, opaque)` | Callback when libvlc wants to exit |
| `libvlc_set_user_agent(inst, name, http)` | Set application name and HTTP User-Agent |
| `libvlc_set_app_id(inst, id, version, icon)` | Set app ID (e.g., `"com.example.myapp"`) |
| `libvlc_get_version()` | Returns version string (e.g., `"3.0.18 Vetinari"`) |
| `libvlc_get_compiler()` | Returns compiler used to build libvlc |
| `libvlc_get_changeset()` | Returns git changeset hash |

**Constructor arguments** use VLC CLI format: `"--option=value"`. Common:
```c
const char *args[] = {
    "--verbose=2",          // Debug logging
    "--no-video-title-show", // Don't show title overlay
    "--network-caching=1000", // 1 second network buffer
};
libvlc_instance_t *inst = libvlc_new(3, args);
```

### 3.2 Media (`libvlc_media_t`)

#### Creation

| Function | Description |
|----------|-------------|
| `libvlc_media_new_location(inst, mrl)` | From URL/MRL (e.g., `"https://..."`, `"rtsp://..."`, `"file:///..."`) |
| `libvlc_media_new_path(inst, path)` | From local file path (auto-converts to `file://` MRL) |
| `libvlc_media_new_fd(inst, fd)` | From file descriptor (ownership transfers to libvlc) |
| `libvlc_media_new_callbacks(inst, open, read, seek, close, opaque)` | From custom bitstream callbacks (in-memory streams, custom protocols) |
| `libvlc_media_new_as_node(inst, name)` | Create empty node (for playlists) |

#### Options

```c
// Per-media options use ":option=value" format (note: colon, not double-dash)
libvlc_media_add_option(media, ":no-audio");
libvlc_media_add_option(media, ":network-caching=1000");
libvlc_media_add_option(media, ":sout=#transcode{...}:std{...}");
libvlc_media_add_option_flag(media, ":option", libvlc_media_option_trusted);
```

**Important:** Most audio/video filter options (text renderer, video filters) must be set at Instance level, not per-Media.

#### Parsing (Metadata Extraction)

```c
// Asynchronous parsing (recommended)
libvlc_media_parse_with_options(media,
    libvlc_media_parse_local    // or libvlc_media_parse_network, libvlc_media_fetch_local, etc.
    | libvlc_media_fetch_local, // fetch art too
    5000);                      // timeout in ms (-1 = infinite)

// Check result
libvlc_media_parsed_status_t status = libvlc_media_get_parsed_status(media);
// Values: libvlc_media_parsed_status_skipped, _failed, _timeout, _done
```

**Parse options flags (combinable):**

| Flag | Value | Description |
|------|-------|-------------|
| `libvlc_media_parse_local` | 0x00 | Parse local files only |
| `libvlc_media_parse_network` | 0x01 | Parse network streams too |
| `libvlc_media_fetch_local` | 0x02 | Fetch art from local files |
| `libvlc_media_fetch_network` | 0x04 | Fetch art from network |
| `libvlc_media_do_interact` | 0x08 | Allow interaction (login dialogs) |

#### Metadata

```c
char *title = libvlc_media_get_meta(media, libvlc_meta_Title);
// Must free returned string with libvlc_free()
libvlc_free(title);

libvlc_media_set_meta(media, libvlc_meta_Title, "New Title");
libvlc_media_save_meta(media);  // Persist to file
```

**Meta types:** `Title`, `Artist`, `Genre`, `Copyright`, `Album`, `TrackNumber`, `Description`, `Rating`, `Date`, `Setting`, `URL`, `Language`, `NowPlaying`, `Publisher`, `EncodedBy`, `ArtworkURL`, `TrackID`, `TrackTotal`, `Director`, `Season`, `Episode`, `ShowName`, `Actors`, `AlbumArtist`, `DiscNumber`, `DiscTotal`

#### Track Information

```c
libvlc_media_track_t **tracks;
unsigned count = libvlc_media_tracks_get(media, &tracks);
for (unsigned i = 0; i < count; i++) {
    switch (tracks[i]->i_type) {
        case libvlc_track_audio:
            printf("Audio: %d channels, %d Hz\n",
                   tracks[i]->audio->i_channels,
                   tracks[i]->audio->i_rate);
            break;
        case libvlc_track_video:
            printf("Video: %dx%d\n",
                   tracks[i]->video->i_width,
                   tracks[i]->video->i_height);
            break;
        case libvlc_track_text:
            printf("Subtitle: %s\n", tracks[i]->psz_description);
            break;
    }
}
libvlc_media_tracks_release(tracks, count);
```

#### Statistics

```c
libvlc_media_stats_t stats;
libvlc_media_get_stats(media, &stats);
// stats.i_decoded_video, stats.i_decoded_audio,
// stats.i_demux_read_bytes, stats.f_demux_bitrate,
// stats.i_lost_pictures, stats.i_played_abuffers, etc.
```

#### Other

| Function | Description |
|----------|-------------|
| `libvlc_media_get_mrl(media)` | Get MRL string (must free with `libvlc_free`) |
| `libvlc_media_duplicate(media)` | Clone media object |
| `libvlc_media_get_state(media)` | Get state: `NothingSpecial`, `Opening`, `Buffering`, `Playing`, `Paused`, `Stopped`, `Ended`, `Error` |
| `libvlc_media_get_duration(media)` | Duration in ms (-1 if unknown; parse first) |
| `libvlc_media_get_type(media)` | `unknown`, `file`, `directory`, `disc`, `stream`, `playlist` |
| `libvlc_media_subitems(media)` | Get sub-items as `libvlc_media_list_t` (for playlists, YouTube URLs, m3u8) |
| `libvlc_media_slaves_add(media, type, priority, uri)` | Add subtitle/audio slave |
| `libvlc_media_slaves_get(media, &slaves)` | Get attached slaves |
| `libvlc_media_retain(media)` / `libvlc_media_release(media)` | Refcounting |

### 3.3 Media Player (`libvlc_media_player_t`)

The largest API surface (~123 C functions).

#### Creation & Media

| Function | Description |
|----------|-------------|
| `libvlc_media_player_new(inst)` | Create empty player |
| `libvlc_media_player_new_from_media(media)` | Create player pre-loaded with media |
| `libvlc_media_player_set_media(mp, media)` | Set/change current media |
| `libvlc_media_player_get_media(mp)` | Get current media (caller must release) |
| `libvlc_media_player_release(mp)` | Release player |
| `libvlc_media_player_retain(mp)` | Retain player |

#### Playback Control

| Function | Description |
|----------|-------------|
| `libvlc_media_player_play(mp)` | Start playback (async — returns immediately) |
| `libvlc_media_player_pause(mp)` | Toggle pause |
| `libvlc_media_player_set_pause(mp, pause)` | Set pause state (1=pause, 0=resume) |
| `libvlc_media_player_stop(mp)` | Stop playback (can be slow with network streams — offload to thread) |
| `libvlc_media_player_is_playing(mp)` | Returns 1 if playing |
| `libvlc_media_player_get_state(mp)` | Get player state enum |
| `libvlc_media_player_get_length(mp)` | Duration in ms |
| `libvlc_media_player_get_time(mp)` | Current time in ms |
| `libvlc_media_player_set_time(mp, time)` | Seek to time in ms |
| `libvlc_media_player_get_position(mp)` | Position 0.0–1.0 |
| `libvlc_media_player_set_position(mp, pos)` | Seek to position |
| `libvlc_media_player_set_rate(mp, rate)` | Playback speed (1.0 = normal, 2.0 = 2x) |
| `libvlc_media_player_get_rate(mp)` | Get current rate |
| `libvlc_media_player_will_play(mp)` | Can this media be played? |
| `libvlc_media_player_is_seekable(mp)` | Is seeking supported? |
| `libvlc_media_player_can_pause(mp)` | Is pausing supported? |
| `libvlc_media_player_program_scrambled(mp)` | Is stream scrambled? |
| `libvlc_media_player_next_frame(mp)` | Advance one frame (while paused) |
| `libvlc_media_player_navigate(mp, nav)` | DVD navigation: `activate`, `up`, `down`, `left`, `right` |

#### Video Output & Window Embedding

| Function | Platform | Description |
|----------|----------|-------------|
| `libvlc_media_player_set_hwnd(mp, hwnd)` | Windows | Set Win32 window handle (`HWND`) |
| `libvlc_media_player_set_xwindow(mp, xid)` | Linux/X11 | Set X11 window ID |
| `libvlc_media_player_set_nsobject(mp, view)` | macOS/iOS | Set `NSView*` / `UIView*` |
| `libvlc_media_player_set_android_context(mp, ctx)` | Android | Set Android `AWindow` context |
| `libvlc_media_player_set_evas_object(mp, obj)` | Tizen/EFL | Set Evas object |

#### Video Properties

| Function | Description |
|----------|-------------|
| `libvlc_video_get_size(mp, num, &w, &h)` | Get video dimensions for track `num` |
| `libvlc_video_get_cursor(mp, num, &x, &y)` | Get cursor position in video |
| `libvlc_video_get_scale(mp)` / `set_scale` | Video scaling factor (0 = auto-fit) |
| `libvlc_video_get_aspect_ratio(mp)` / `set_aspect_ratio` | Aspect ratio string (e.g., `"16:9"`, `"4:3"`) |
| `libvlc_video_set_crop_geometry(mp, geo)` | Crop geometry (e.g., `"16:10"`) |
| `libvlc_video_set_deinterlace(mp, mode)` | Deinterlace mode: `"blend"`, `"linear"`, `"x"`, `"yadif"`, `"yadif2x"`, `""` (disable) |
| `libvlc_video_get_spu(mp)` / `set_spu` | Subtitle track selection |
| `libvlc_video_get_spu_count(mp)` | Number of subtitle tracks |
| `libvlc_video_get_spu_delay(mp)` / `set_spu_delay` | Subtitle delay in microseconds |
| `libvlc_video_set_teletext(mp, page)` | Teletext page |
| `libvlc_video_take_snapshot(mp, num, path, w, h)` | Save screenshot to file |
| `libvlc_video_get_track_count(mp)` | Number of video tracks |
| `libvlc_video_get_track(mp)` / `set_track` | Select video track |
| `libvlc_video_get_track_description(mp)` | List of track descriptions |

#### Video Marquee (Text Overlay)

```c
libvlc_video_set_marquee_int(mp, libvlc_marquee_Enable, 1);
libvlc_video_set_marquee_string(mp, libvlc_marquee_Text, "Hello World");
libvlc_video_set_marquee_int(mp, libvlc_marquee_Color, 0xFF0000);    // Red
libvlc_video_set_marquee_int(mp, libvlc_marquee_Size, 24);           // Font size
libvlc_video_set_marquee_int(mp, libvlc_marquee_Position, 8);        // Bottom
libvlc_video_set_marquee_int(mp, libvlc_marquee_Timeout, 5000);      // 5 seconds
libvlc_video_set_marquee_int(mp, libvlc_marquee_Opacity, 200);       // 0-255
libvlc_video_set_marquee_int(mp, libvlc_marquee_X, 10);              // X position
libvlc_video_set_marquee_int(mp, libvlc_marquee_Y, 10);              // Y position
libvlc_video_set_marquee_int(mp, libvlc_marquee_Refresh, 1000);      // Refresh interval ms
```

#### Video Logo (Image Overlay)

```c
libvlc_video_set_logo_int(mp, libvlc_logo_enable, 1);
libvlc_video_set_logo_string(mp, libvlc_logo_file, "/path/to/logo.png");
libvlc_video_set_logo_int(mp, libvlc_logo_x, 10);
libvlc_video_set_logo_int(mp, libvlc_logo_y, 10);
libvlc_video_set_logo_int(mp, libvlc_logo_opacity, 200);  // 0-255
libvlc_video_set_logo_int(mp, libvlc_logo_delay, 0);      // ms between images
libvlc_video_set_logo_int(mp, libvlc_logo_repeat, -1);     // -1 = infinite
```

#### Audio

| Function | Description |
|----------|-------------|
| `libvlc_audio_get_volume(mp)` / `set_volume` | Volume 0–200 (100 = normal, >100 = amplify) |
| `libvlc_audio_get_mute(mp)` / `set_mute` / `toggle_mute` | Mute control |
| `libvlc_audio_get_track(mp)` / `set_track` | Audio track selection |
| `libvlc_audio_get_track_count(mp)` | Number of audio tracks |
| `libvlc_audio_get_track_description(mp)` | List of track descriptions |
| `libvlc_audio_get_delay(mp)` / `set_delay` | Audio delay in microseconds |
| `libvlc_audio_get_channel(mp)` / `set_channel` | Audio channel mode: `Stereo`, `RStereo`, `Left`, `Right`, `Dolbys` |
| `libvlc_audio_output_list_get(inst)` | List available audio outputs |
| `libvlc_audio_output_set(mp, name)` | Set audio output module |
| `libvlc_audio_output_device_list_get(inst, aout)` | List devices for output |
| `libvlc_audio_output_device_set(mp, module, device_id)` | Set specific audio device |

#### Audio Equalizer

LibVLC provides a 10-band audio equalizer with 18 built-in presets (Flat, Classical, Club, Dance, Full bass, etc.). The equalizer is an independent object that you configure and then apply to a media player. Changes take effect immediately, even during playback.

**C — Full equalizer workflow:**
```c
// List available presets
unsigned preset_count = libvlc_audio_equalizer_get_preset_count();
for (unsigned i = 0; i < preset_count; i++)
    printf("Preset %u: %s\n", i, libvlc_audio_equalizer_get_preset_name(i));

// Create from preset (e.g., "Rock" = preset index 1)
libvlc_equalizer_t *eq = libvlc_audio_equalizer_new_from_preset(1);
// Or create blank (all bands at 0 dB):
// libvlc_equalizer_t *eq = libvlc_audio_equalizer_new();

// Pre-amplification: -20.0 to +20.0 dB
libvlc_audio_equalizer_set_preamp(eq, 12.0);

// 10 frequency bands — get frequencies:
unsigned band_count = libvlc_audio_equalizer_get_band_count();  // Always 10
for (unsigned i = 0; i < band_count; i++)
    printf("Band %u: %.0f Hz\n", i, libvlc_audio_equalizer_get_band_frequency(i));
// Bands: 60Hz, 170Hz, 310Hz, 600Hz, 1kHz, 3kHz, 6kHz, 12kHz, 14kHz, 16kHz

// Set amplification per band: -20.0 to +20.0 dB
libvlc_audio_equalizer_set_amp_at_index(eq, 8.0, 0);   // Boost 60Hz bass
libvlc_audio_equalizer_set_amp_at_index(eq, -3.0, 9);   // Cut 16kHz treble

// Apply to player (can be done before or during playback)
libvlc_media_player_set_equalizer(mp, eq);

// Disable equalizer:
libvlc_media_player_set_equalizer(mp, NULL);

// Release when done (player does NOT keep a reference)
libvlc_audio_equalizer_release(eq);
```

**C# (LibVLCSharp):**
```csharp
// Create from preset
using var eq = new Equalizer(presetIndex: 1);  // "Rock"

// Or blank:
// using var eq = new Equalizer();

// Configure
eq.SetPreamp(12.0f);
eq.SetAmp(8.0f, 0);   // Band 0 = 60Hz

// Apply
player.SetEqualizer(eq);

// Disable
player.UnsetEqualizer();

// List presets
for (uint i = 0; i < Equalizer.PresetCount; i++)
    Console.WriteLine($"Preset {i}: {Equalizer.PresetName(i)}");
```

**Python:**
```python
import vlc

# Create from preset
eq = vlc.AudioEqualizer.from_preset(1)  # "Rock"

# Configure
eq.set_preamp(12.0)
eq.set_amp_at_index(8.0, 0)  # Boost 60Hz

# Apply to player
player.set_equalizer(eq)

# Disable
player.set_equalizer(None)
```

**Key points:**
- The player does NOT keep a reference to the equalizer — you can release/modify it after `set_equalizer()` and re-apply
- Changes apply immediately to the currently playing audio
- If set before playback, settings persist for subsequently played media
- The equalizer object is independent of the player — you can reuse one equalizer across multiple players

#### Custom Video Rendering (Callbacks)

For rendering video frames yourself (e.g., into a texture, off-screen buffer, or custom UI):

```c
// Lock callback: allocate/return buffer for VLC to decode into
void *lock(void *opaque, void **planes) {
    my_context *ctx = (my_context *)opaque;
    *planes = ctx->pixel_buffer;
    return NULL;  // picture identifier (passed to unlock/display)
}

// Unlock callback: called after decoding
void unlock(void *opaque, void *picture, void *const *planes) {
    // Optional: post-processing
}

// Display callback: frame is ready to show
void display(void *opaque, void *picture) {
    my_context *ctx = (my_context *)opaque;
    // Render ctx->pixel_buffer to screen/texture
}

libvlc_video_set_callbacks(mp, lock, unlock, display, my_context);
libvlc_video_set_format(mp, "RV32", width, height, width * 4);  // BGRA 32-bit
// Or use format callback for dynamic sizing:
// libvlc_video_set_format_callbacks(mp, setup_cb, cleanup_cb);
```

**Chroma formats:** `"RV32"` (BGRA), `"RV24"` (BGR), `"RV16"`, `"I420"` (YUV planar), `"NV12"`, `"UYVY"`, `"YUYV"`

**Performance note (LibVLC 3.x):** Video callbacks involve CPU copies — no GPU acceleration. Minimize resolution and prefer `I420` chroma over `RV32` to reduce copy overhead.

#### Custom Audio Rendering (Callbacks)

```c
void audio_play(void *data, const void *samples, unsigned count, int64_t pts) {
    // Render audio samples
}
void audio_pause(void *data, int64_t pts) { /* pause output */ }
void audio_resume(void *data, int64_t pts) { /* resume output */ }
void audio_flush(void *data, int64_t pts) { /* flush buffers */ }
void audio_drain(void *data) { /* drain remaining */ }

libvlc_audio_set_callbacks(mp, audio_play, audio_pause, audio_resume,
                           audio_flush, audio_drain, my_context);
libvlc_audio_set_format(mp, "S16N", 44100, 2);  // 16-bit signed, 44.1kHz, stereo
// Or: libvlc_audio_set_format_callbacks(mp, setup_cb, cleanup_cb);
```

**C# (LibVLCSharp) — Full audio callbacks with NAudio playback + file recording:**

This example uses `SetAudioFormatCallback` to negotiate audio format, then `SetAudioCallbacks` to route decoded PCM samples to both a speaker (via NAudio `WaveOutEvent`) and a WAV file writer:

```csharp
using var libVLC = new LibVLC(enableDebugLogs: true);
using var media = new Media(libVLC,
    new Uri("http://example.com/video.mp4"), ":no-video");
using var mediaPlayer = new MediaPlayer(media);

// Set up audio output
var waveFormat = new WaveFormat(8000, 16, 1);  // 8kHz, 16-bit, mono
var writer = new WaveFileWriter("sound.wav", waveFormat);
var waveProvider = new BufferedWaveProvider(waveFormat);
using var outputDevice = new WaveOutEvent();
outputDevice.Init(waveProvider);

// Negotiate format — libvlc calls this to agree on sample rate/channels
mediaPlayer.SetAudioFormatCallback(
    (ref IntPtr opaque, ref IntPtr format, ref uint rate, ref uint channels) =>
    {
        channels = (uint)waveFormat.Channels;
        rate = (uint)waveFormat.SampleRate;
        return 0;
    },
    (IntPtr opaque) => { /* cleanup */ });

// Route decoded audio samples
mediaPlayer.SetAudioCallbacks(
    (IntPtr data, IntPtr samples, uint count, long pts) =>
    {
        int bytes = (int)count * 2;  // 16-bit mono = 2 bytes per sample
        var buffer = new byte[bytes];
        Marshal.Copy(samples, buffer, 0, bytes);
        waveProvider.AddSamples(buffer, 0, bytes);  // Speaker output
        writer.Write(buffer, 0, bytes);              // File recording
    },
    (IntPtr data, long pts) => outputDevice.Pause(),   // pause
    (IntPtr data, long pts) => outputDevice.Play(),    // resume
    (IntPtr data, long pts) => { writer.Flush(); waveProvider.ClearBuffer(); },  // flush
    (IntPtr data) => writer.Flush());                  // drain

mediaPlayer.Play();
outputDevice.Play();
```

**Key points for audio callbacks:**
- Use `:no-video` media option when only audio is needed — avoids video decoding overhead
- `SetAudioFormatCallback` is called **before** playback — use it to negotiate sample rate and channels
- The `play` callback receives raw PCM samples as `IntPtr` — use `Marshal.Copy` to get managed byte arrays
- `count` is the number of **samples**, not bytes — multiply by bytes-per-sample (e.g., `count * 2` for 16-bit mono)
- All callbacks run on libvlc's audio thread — keep processing fast to avoid audio glitches

#### Subtitle / Media Slave

```c
// Add external subtitle file
libvlc_media_player_add_slave(mp, libvlc_media_slave_type_subtitle,
                               "file:///path/to/subs.srt", true);
// Add external audio track
libvlc_media_player_add_slave(mp, libvlc_media_slave_type_audio,
                               "file:///path/to/audio.mp3", true);
```

#### Chapters & Titles (DVD/Blu-ray)

| Function | Description |
|----------|-------------|
| `libvlc_media_player_get_chapter(mp)` / `set_chapter` | Current chapter |
| `libvlc_media_player_get_chapter_count(mp)` | Total chapters |
| `libvlc_media_player_get_title(mp)` / `set_title` | Current title |
| `libvlc_media_player_get_title_count(mp)` | Total titles |
| `libvlc_media_player_get_full_title_descriptions(mp, &descs)` | Detailed title info |
| `libvlc_media_player_get_full_chapter_descriptions(mp, title, &descs)` | Detailed chapter info |
| `libvlc_media_player_previous_chapter(mp)` / `next_chapter` | Chapter navigation |

#### 360° Video

```c
libvlc_video_update_viewpoint(mp, &(libvlc_video_viewpoint_t){
    .f_yaw   = 45.0,   // Horizontal rotation (-180 to 180)
    .f_pitch = -10.0,   // Vertical rotation (-90 to 90)
    .f_roll  = 0.0,     // Rotation around axis
    .f_field_of_view = 80.0  // FOV in degrees
}, false);  // false = absolute, true = relative
```

#### Media Player Role

```c
libvlc_media_player_set_role(mp, libvlc_role_Music);
// Roles: None, Music, Video, Communication, Game, Notification,
//        Animation, Production, Accessibility, Test
```

### 3.4 Media List (`libvlc_media_list_t`)

Thread-safe ordered collection of media items. **Must lock before read/write operations.**

```c
libvlc_media_list_t *ml = libvlc_media_list_new(inst);

libvlc_media_list_lock(ml);       // MUST lock before modifying
libvlc_media_list_add_media(ml, media1);
libvlc_media_list_add_media(ml, media2);
libvlc_media_list_insert_media(ml, media3, 0);  // Insert at index
int count = libvlc_media_list_count(ml);
libvlc_media_t *m = libvlc_media_list_item_at_index(ml, 0);  // Must release
libvlc_media_list_remove_index(ml, 0);
libvlc_media_list_unlock(ml);     // MUST unlock after

libvlc_media_list_release(ml);
```

### 3.5 Media List Player (`libvlc_media_list_player_t`)

Plays through a media list with configurable playback mode.

```c
libvlc_media_list_player_t *mlp = libvlc_media_list_player_new(inst);
libvlc_media_list_player_set_media_player(mlp, mp);
libvlc_media_list_player_set_media_list(mlp, ml);

// Playback modes
libvlc_media_list_player_set_playback_mode(mlp, libvlc_playback_mode_default);  // Sequential
libvlc_media_list_player_set_playback_mode(mlp, libvlc_playback_mode_loop);     // Repeat all
libvlc_media_list_player_set_playback_mode(mlp, libvlc_playback_mode_repeat);   // Repeat one

libvlc_media_list_player_play(mlp);
libvlc_media_list_player_next(mlp);
libvlc_media_list_player_previous(mlp);
libvlc_media_list_player_play_item_at_index(mlp, 2);
libvlc_media_list_player_play_item(mlp, specific_media);

libvlc_media_list_player_pause(mlp);
libvlc_media_list_player_stop(mlp);
libvlc_media_list_player_is_playing(mlp);
libvlc_media_list_player_get_state(mlp);

libvlc_media_list_player_release(mlp);
```

### 3.6 Events (`libvlc_event_t`)

#### Event Types

**MediaPlayer events (most common):**

| Event | Extra Data |
|-------|-----------|
| `libvlc_MediaPlayerMediaChanged` | `new_media` |
| `libvlc_MediaPlayerOpening` | — |
| `libvlc_MediaPlayerBuffering` | `new_cache` (float, 0–100%) |
| `libvlc_MediaPlayerPlaying` | — |
| `libvlc_MediaPlayerPaused` | — |
| `libvlc_MediaPlayerStopped` | — |
| `libvlc_MediaPlayerForward` | — |
| `libvlc_MediaPlayerBackward` | — |
| `libvlc_MediaPlayerEndReached` | — |
| `libvlc_MediaPlayerEncounteredError` | — |
| `libvlc_MediaPlayerTimeChanged` | `new_time` (int64_t, ms) |
| `libvlc_MediaPlayerPositionChanged` | `new_position` (float, 0.0–1.0) |
| `libvlc_MediaPlayerSeekableChanged` | `new_seekable` (int) |
| `libvlc_MediaPlayerPausableChanged` | `new_pausable` (int) |
| `libvlc_MediaPlayerTitleChanged` | `new_title` (int) |
| `libvlc_MediaPlayerSnapshotTaken` | `psz_filename` (char*) |
| `libvlc_MediaPlayerLengthChanged` | `new_length` (int64_t) |
| `libvlc_MediaPlayerVout` | `new_count` (int) |
| `libvlc_MediaPlayerScrambledChanged` | `new_scrambled` (int) |
| `libvlc_MediaPlayerESAdded` | `i_type`, `i_id` |
| `libvlc_MediaPlayerESDeleted` | `i_type`, `i_id` |
| `libvlc_MediaPlayerESSelected` | `i_type`, `i_id` |
| `libvlc_MediaPlayerCorked` | — |
| `libvlc_MediaPlayerUncorked` | — |
| `libvlc_MediaPlayerMuted` | — |
| `libvlc_MediaPlayerUnmuted` | — |
| `libvlc_MediaPlayerAudioVolume` | `volume` (float) |
| `libvlc_MediaPlayerAudioDevice` | `device` (char*) |
| `libvlc_MediaPlayerChapterChanged` | `new_chapter` (int) |

**Media events:**

| Event | Extra Data |
|-------|-----------|
| `libvlc_MediaMetaChanged` | `meta_type` |
| `libvlc_MediaSubItemAdded` | `new_child` (media) |
| `libvlc_MediaDurationChanged` | `new_duration` (int64_t) |
| `libvlc_MediaParsedChanged` | `new_status` (int) |
| `libvlc_MediaFreed` | `md` (media) |
| `libvlc_MediaStateChanged` | `new_state` |
| `libvlc_MediaSubItemTreeAdded` | `item` (media) |

**MediaList events:** `ItemAdded` (`item`, `index`), `WillAddItem`, `ItemDeleted`, `WillDeleteItem`

**MediaDiscoverer events:** `Started`, `Ended`

**RendererDiscoverer events:** `ItemAdded` (`item`), `ItemDeleted` (`item`)

**VLM events:** `MediaAdded`, `MediaRemoved`, `MediaChanged`, `MediaInstanceStarted`, `MediaInstanceStopped`, `MediaInstanceStatusInit/Opening/Playing/Pause/End/Error`

### 3.7 Dialog API (`libvlc_dialog_cbs`)

Handle login prompts, questions, and progress for user interaction:

```c
const libvlc_dialog_cbs cbs = {
    .pf_display_error    = on_error,     // (title, text)
    .pf_display_login    = on_login,     // (id, title, text, default_user, ask_store)
    .pf_display_question = on_question,  // (id, title, text, type, cancel, action1, action2)
    .pf_display_progress = on_progress,  // (id, title, text, indeterminate, position, cancel)
    .pf_cancel           = on_cancel,    // (id)
    .pf_update_progress  = on_update,    // (id, position, text)
};
libvlc_dialog_set_callbacks(inst, &cbs, my_data);

// Respond to dialog:
libvlc_dialog_post_login(id, username, password, store);
libvlc_dialog_post_action(id, action_number);  // 1 or 2
libvlc_dialog_dismiss(id);
```

### 3.8 Media Discoverer (`libvlc_media_discoverer_t`)

Discover network services (UPnP, Bonjour, SAP, etc.):

```c
// List available discoverers by category
libvlc_media_discoverer_description_t **descs;
size_t count = libvlc_media_discoverer_list_get(inst,
    libvlc_media_discoverer_devices,  // or _lan, _podcasts, _localdirs
    &descs);
// Each has: psz_name, psz_longname, i_cat

// Create and start
libvlc_media_discoverer_t *md = libvlc_media_discoverer_new(inst, descs[0]->psz_name);
libvlc_media_discoverer_start(md);

// Get discovered items
libvlc_media_list_t *ml = libvlc_media_discoverer_media_list(md);
// Listen for ItemAdded/ItemDeleted events on the media list

libvlc_media_discoverer_stop(md);
libvlc_media_discoverer_release(md);
libvlc_media_discoverer_description_list_release(descs, count);
```

**Categories:**
- `libvlc_media_discoverer_devices` — Audio/video devices (webcam, mic)
- `libvlc_media_discoverer_lan` — LAN services (UPnP, SMB shares)
- `libvlc_media_discoverer_podcasts` — Podcast directories
- `libvlc_media_discoverer_localdirs` — Local directories

### 3.9 Renderer Discoverer (`libvlc_renderer_discoverer_t`)

Find Chromecast, UPnP renderers:

```c
libvlc_renderer_discoverer_description_t **descs;
size_t count = libvlc_renderer_discoverer_list_get(inst, &descs);

libvlc_renderer_discoverer_t *rd = libvlc_renderer_discoverer_new(inst, descs[0]->psz_name);

// Listen for renderer items
libvlc_event_manager_t *em = libvlc_renderer_discoverer_event_manager(rd);
libvlc_event_attach(em, libvlc_RendererDiscovererItemAdded, on_renderer_found, ctx);

libvlc_renderer_discoverer_start(rd);

// When renderer found:
void on_renderer_found(const libvlc_event_t *e, void *data) {
    libvlc_renderer_item_t *item = e->u.renderer_discoverer_item_added.item;
    const char *name = libvlc_renderer_item_name(item);
    // Check: libvlc_renderer_item_flags(item) & LIBVLC_RENDERER_CAN_VIDEO
    // To cast: libvlc_media_player_set_renderer(mp, item);
    // To stop casting: libvlc_media_player_set_renderer(mp, NULL);
}

libvlc_renderer_discoverer_stop(rd);
libvlc_renderer_discoverer_release(rd);
```

**Renderer flags:** `LIBVLC_RENDERER_CAN_AUDIO` (0x0001), `LIBVLC_RENDERER_CAN_VIDEO` (0x0002)

### 3.10 VLM (Video LAN Manager)

Server-side broadcast/VOD streaming management:

```c
// Add a broadcast
libvlc_vlm_add_broadcast(inst, "mystream",
    "file:///path/to/video.mp4",     // input
    "#standard{access=http,mux=ts,dst=:8080/stream}",  // output
    0, NULL,                          // extra options
    1,   // enabled
    0);  // no loop

libvlc_vlm_play_media(inst, "mystream");
libvlc_vlm_pause_media(inst, "mystream");
libvlc_vlm_stop_media(inst, "mystream");
libvlc_vlm_seek_media(inst, "mystream", 50.0);  // 50%

// VOD
libvlc_vlm_add_vod(inst, "myvod", "file:///path/to/video.mp4",
    0, NULL, 1, "ts");

// Query state
float pos = libvlc_vlm_get_media_instance_position(inst, "mystream", 0);
int time = libvlc_vlm_get_media_instance_time(inst, "mystream", 0);

// JSON info (debugging)
const char *info = libvlc_vlm_show_media(inst, "mystream");

libvlc_vlm_del_media(inst, "mystream");
libvlc_vlm_release(inst);
```

---

## §4. Language Binding Patterns

### 4.1 C# — LibVLCSharp (Official, Cross-platform)

> **Targets LibVLCSharp 3.x** (NuGet `LibVLCSharp` 3.x + `VideoLAN.LibVLC.*` 3.x). The master branch of LibVLCSharp targets libvlc 4.x and has a different API surface.

**Package:** `VideoLAN.LibVLC.Forms` (Xamarin), `LibVLCSharp` (core), `VideoLAN.LibVLC.Windows/Mac/...` (platform-specific)

**Type Mapping:**

| C Type | C# Type | Notes |
|--------|---------|-------|
| `libvlc_instance_t` | `LibVLC` | Constructor takes `params string[]` CLI args |
| `libvlc_media_player_t` | `MediaPlayer` | Created from `LibVLC` or `Media` |
| `libvlc_media_t` | `Media` | Created from `LibVLC` + URI/path/stream |
| `libvlc_media_list_t` | `MediaList` | Implements `IEnumerable` |
| `libvlc_event_manager_t` | C# events | `.Playing += handler` |
| `libvlc_renderer_item_t` | `RendererItem` | |
| `libvlc_equalizer_t` | `Equalizer` | |

**Initialization:**
```csharp
// Load native libvlc (does plugin scan — can be slow first time)
using var libVLC = new LibVLC(enableDebugLogs: true);
// Or with args:
using var libVLC = new LibVLC("--verbose=2", "--no-video-title-show");
```

**Basic Playback:**
```csharp
using var libVLC = new LibVLC();
using var media = new Media(libVLC, new Uri("https://example.com/video.mp4"));
using var player = new MediaPlayer(media);
player.Play();
```

**Events:**
```csharp
player.Playing += (sender, e) => Console.WriteLine("Playing!");
player.EndReached += (sender, e) => {
    // MUST offload — never call libvlc from callback thread
    ThreadPool.QueueUserWorkItem(_ => player.Play(nextMedia));
};
player.EncounteredError += (sender, e) => Console.WriteLine("Error!");
player.TimeChanged += (sender, e) => Console.WriteLine($"Time: {e.Time}ms");
player.Buffering += (sender, e) => Console.WriteLine($"Buffering: {e.Cache}%");
```

**Media Parsing:**
```csharp
using var media = new Media(libVLC, new Uri("file:///path/to/file.mp4"));
await media.Parse(MediaParseOptions.ParseLocal);
// media.Tracks, media.Meta(MetadataType.Title), media.Duration
```

**YouTube / m3u8 / Playlists (network-parsed media with sub-items):**

LibVLC can resolve playlist-like URLs (YouTube, HLS manifests) by parsing them over the network. The actual playable stream is exposed as the first sub-item:

```csharp
using var media = new Media(libVLC, new Uri("https://youtube.com/watch?v=..."));
await media.Parse(MediaParseOptions.ParseNetwork);
// The resolved stream URL is in SubItems — play the first one:
player.Play(media.SubItems.First());
```

This works for any URL where libvlc resolves the actual stream via network parsing (YouTube, Dailymotion, some m3u8 playlists, etc.). Always parse with `ParseNetwork` and check `SubItems` rather than playing the original URL directly.

**Custom Stream Input (imem):**
```csharp
using var media = new Media(libVLC, new StreamMediaInput(myStream));
player.Play(new MediaPlayer(media));
```

**Platform VideoView:**

| Platform | Control | Embedding |
|----------|---------|-----------|
| WPF | `VideoView` (wraps `WindowsFormsHost`) | XAML: `<vlc:VideoView />` |
| WinForms | `VideoView` | Direct control |
| UWP | `VideoView` (SwapChainPanel) | Requires `"--aout=winstore"` |
| macOS/iOS | `VideoView` (NSView/UIView) | `player.SetNSObject(view.Handle)` |
| Android | `VideoView` (SurfaceView) | `player.SetAndroidContext(...)` |
| GTK | `VideoView` | DrawingArea |
| Avalonia | `VideoView` | NativeControlHost |

**IDisposable — CRITICAL:** All main types (`LibVLC`, `MediaPlayer`, `Media`, `MediaList`) implement `IDisposable`. Always `using` or `.Dispose()`. Events are native callbacks — **unsubscribe before disposal** to prevent both managed and native memory leaks.

### 4.2 Python — python-vlc

**Package:** `pip install python-vlc`

**Type Mapping:**

| C Type | Python Type | Notes |
|--------|-------------|-------|
| `libvlc_instance_t` | `vlc.Instance` | Constructor takes string or list of args |
| `libvlc_media_player_t` | `vlc.MediaPlayer` | Auto-creates default Instance if not provided |
| `libvlc_media_t` | `vlc.Media` | |
| `libvlc_media_list_t` | `vlc.MediaList` | |
| `libvlc_event_manager_t` | `vlc.EventManager` | |

**Quickstart (Implicit Instance):**
```python
import vlc

player = vlc.MediaPlayer("file:///path/to/video.mp4")
player.play()

# Wait for playback
import time
time.sleep(10)
```

**Explicit Instance (Recommended):**
```python
import vlc

instance = vlc.Instance('--no-audio', '--verbose=2')
player = instance.media_player_new()

media = instance.media_new('/path/to/file.mp4')
player.set_media(media)

# Embed in window (Linux/X11)
player.set_xwindow(window_id)
# Windows: player.set_hwnd(hwnd)
# macOS: player.set_nsobject(nsview_ptr)

player.play()
```

**Events:**
```python
import vlc
import queue

cmd_queue = queue.Queue()

def on_end(event):
    # DO NOT call player methods here — deadlock!
    cmd_queue.put('ended')

def on_position(event):
    cmd_queue.put(('pos', event.u.new_position))

player = vlc.MediaPlayer("file.mp4")
em = player.event_manager()
em.event_attach(vlc.EventType.MediaPlayerEndReached, on_end)
em.event_attach(vlc.EventType.MediaPlayerPositionChanged, on_position)

player.play()

# Process events in main thread
while True:
    try:
        msg = cmd_queue.get(timeout=0.1)
        if msg == 'ended':
            break
    except queue.Empty:
        pass
```

**Media Options:**
```python
media = instance.media_new('file.mp4', 'network-caching=1000')
# Or:
media = instance.media_new('file.mp4')
media.add_option(':sout=#transcode{vcodec=h264}:std{access=file,dst=out.mp4}')
```

**Custom Callbacks (in-memory stream):**
```python
import vlc
import ctypes

@vlc.CallbackDecorators.MediaOpenCb
def open_cb(opaque, data_pointer, size_pointer):
    size_pointer.value = 2**64 - 1
    return 0

@vlc.CallbackDecorators.MediaReadCb
def read_cb(opaque, buffer, length):
    data = get_next_chunk()
    buf = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char * len(data)))
    for i, b in enumerate(data):
        buf.contents[i] = ctypes.c_char(b)
    return len(data)

@vlc.CallbackDecorators.MediaCloseCb
def close_cb(opaque):
    pass

media = instance.media_new_callbacks(open_cb, read_cb, None, close_cb, None)
```

**Python Gotchas:**
1. **Keep references alive** — if Python GC collects a wrapper, the C pointer becomes invalid. Always assign to variables, not inline.
2. **Callbacks run on libvlc thread** — not Python main thread. Use `queue.Queue` to communicate.
3. **String encoding** — auto UTF-8 conversion. Non-ASCII paths work.
4. **`event_manager()` reference** — keep the EventManager reference alive, or callbacks stop working.

### 4.3 Java/Kotlin — vlcj

> **Targets vlcj 4.x** (which wraps libvlc 3.x — note: vlcj version numbers differ from libvlc version numbers).

**Package:** `uk.co.caprica:vlcj:4.x` (Maven Central)

**Type Mapping:**

| C Type | vlcj Type | Notes |
|--------|-----------|-------|
| `libvlc_instance_t` | `MediaPlayerFactory` | Auto-discovers libvlc |
| `libvlc_media_player_t` | `MediaPlayer` / `EmbeddedMediaPlayer` | |
| `libvlc_media_t` | `Media` | |
| `libvlc_event_manager_t` | `MediaPlayerEventAdapter` / listeners | |

**Initialization (vlcj 4.x — auto-discovery):**
```java
MediaPlayerFactory factory = new MediaPlayerFactory();
// Or with args:
MediaPlayerFactory factory = new MediaPlayerFactory("--verbose=2", "--no-video-title-show");
```

**Basic Playback (Swing):**
```java
EmbeddedMediaPlayerComponent component = new EmbeddedMediaPlayerComponent();
frame.setContentPane(component);
frame.setVisible(true);

component.mediaPlayer().media().play("/path/to/video.mp4");
```

**Fluent API (module pattern):**
```java
MediaPlayer mp = component.mediaPlayer();
mp.controls().play();
mp.controls().pause();
mp.controls().stop();
mp.controls().setPosition(0.5f);
mp.audio().setVolume(80);
mp.video().setAspectRatio("16:9");
mp.media().play(mrl, ":network-caching=1000");
long time = mp.status().time();
```

**Events:**
```java
mp.events().addMediaPlayerEventListener(new MediaPlayerEventAdapter() {
    @Override
    public void playing(MediaPlayer mediaPlayer) {
        // On native thread — marshal to EDT for UI updates
        SwingUtilities.invokeLater(() -> statusLabel.setText("Playing"));
    }

    @Override
    public void finished(MediaPlayer mediaPlayer) {
        // NEVER call libvlc directly — use submit()
        mediaPlayer.submit(() -> mediaPlayer.media().play(nextMrl));
    }

    @Override
    public void error(MediaPlayer mediaPlayer) {
        SwingUtilities.invokeLater(() ->
            JOptionPane.showMessageDialog(frame, "Playback error"));
    }
});
```

**Direct/Callback Rendering (for JavaFX, OpenGL):**
```java
CallbackMediaPlayerComponent component = new CallbackMediaPlayerComponent();
// Renders via BufferedImage — suitable for JavaFX ImageView
```

**Cleanup — CRITICAL:**
```java
// Must release native resources explicitly
component.release();
factory.release();
```

**vlcj Gotchas:**
1. **GC crashes** — keep hard references to all vlcj objects. Local variables go out of scope → native thread outlives Java object → JVM crash.
2. **macOS Java 7+** — no heavyweight AWT. Use JavaFX or `CallbackMediaPlayerComponent`.
3. **`play()` is async** — returns immediately. Success/failure reported via events.
4. **Thread safety** — events fire on native callback thread. Use `submit()` for libvlc calls, `SwingUtilities.invokeLater()` for UI.

### 4.4 Go — libvlc-go

**Package:** `github.com/adrg/libvlc-go/v3`

**Type Mapping:**

| C Type | Go Type | Notes |
|--------|---------|-------|
| `libvlc_instance_t` | module-level (via `vlc.Init()`) | Global singleton |
| `libvlc_media_player_t` | `vlc.Player` | |
| `libvlc_media_t` | `vlc.Media` | |
| `libvlc_event_manager_t` | `vlc.EventManager` | |

**Usage:**
```go
package main

import (
    "log"
    vlc "github.com/adrg/libvlc-go/v3"
)

func main() {
    // Initialize (global, call once)
    if err := vlc.Init("--quiet"); err != nil {
        log.Fatal(err)
    }
    defer vlc.Release()

    // Create player
    player, err := vlc.NewPlayer()
    if err != nil {
        log.Fatal(err)
    }
    defer func() { player.Stop(); player.Release() }()

    // Load media
    media, err := player.LoadMediaFromPath("/path/to/file.mp4")
    if err != nil {
        log.Fatal(err)
    }
    defer media.Release()

    // Events
    manager, err := player.EventManager()
    if err != nil {
        log.Fatal(err)
    }

    eventID, err := manager.Attach(vlc.MediaPlayerEndReached, func(event vlc.Event, userData interface{}) {
        log.Println("Playback ended")
    }, nil)
    if err != nil {
        log.Fatal(err)
    }
    defer manager.Detach(eventID)

    // Play
    if err := player.Play(); err != nil {
        log.Fatal(err)
    }

    // Block main goroutine
    select {}
}
```

**Go Gotchas:**
1. **CGo overhead** — each libvlc call crosses the CGo boundary. Minimize calls in hot paths.
2. **Global init** — `vlc.Init()` must be called once; `vlc.Release()` at shutdown.
3. **Error returns** — Go-idiomatic `(result, error)` pattern. Always check errors.
4. **Event callbacks** — fire on libvlc thread via CGo. Safe to use goroutines for follow-up work.

### 4.5 C++ — libvlcpp (Header-only)

**Type Mapping:**

| C Type | C++ Type | Notes |
|--------|----------|-------|
| `libvlc_instance_t` | `VLC::Instance` | RAII, shared_ptr-based |
| `libvlc_media_player_t` | `VLC::MediaPlayer` | |
| `libvlc_media_t` | `VLC::Media` | |
| `libvlc_media_list_t` | `VLC::MediaList` | |
| `libvlc_event_manager_t` | `VLC::EventManager` | |

**Usage:**
```cpp
#include <vlcpp/vlc.hpp>

auto instance = VLC::Instance(0, nullptr);
auto media = VLC::Media(instance, "/path/to/file.mp4", VLC::Media::FromPath);
auto player = VLC::MediaPlayer(media);

// Events (lambda-based)
player.eventManager().onPlaying([&]() {
    std::cout << "Playing!" << std::endl;
});

player.eventManager().onEndReached([&]() {
    // Still must not call libvlc directly — use async dispatch
    std::async(std::launch::async, [&]() { player.play(); });
});

player.play();
```

**C++ Features:**
- **RAII** — automatic cleanup via destructors (no manual retain/release)
- **Shared ownership** — internal `std::shared_ptr` wrapping
- **Lambda events** — `eventManager().onXxx(lambda)`
- **Type-safe** — wraps all C enums and types

### 4.6 Other Language Bindings

**VB.NET (LibVLCSharp):**

LibVLCSharp works with any .NET language, including Visual Basic:

```vb
Imports LibVLCSharp.Shared

Module Program
    Sub Main(args As String())
        Core.Initialize()
        Using libVLC = New LibVLC()
            Dim video = New Media(libVLC, New Uri("http://example.com/video.mp4"))
            Using mp = New MediaPlayer(video)
                video.Dispose()
                mp.Play()
                Console.ReadKey()
            End Using
        End Using
    End Sub
End Module
```

**PHP (via PeachPie — experimental):**

LibVLCSharp can be used from PHP through the [PeachPie](https://www.peachpie.io/) PHP-to-.NET compiler:

```php
<?php
use LibVLCSharp\Shared\Core;
use LibVLCSharp\Shared\LibVLC;
use LibVLCSharp\Shared\MediaPlayer;
use LibVLCSharp\Shared\Media;

Core::Initialize();
$libVLC = new LibVLC();
$mediaPlayer = new MediaPlayer($libVLC);
$media = new Media($libVLC, "http://example.com/video.mp4", 1);
$mediaPlayer->Play($media);
```

These demonstrate that LibVLCSharp is not limited to C# — any .NET-compatible language can use it with the same API surface.

### 4.7 Binding Cross-Reference

**"Play a file" across all languages:**

| Language | Code |
|----------|------|
| C | `m = libvlc_media_new_path(inst, path); libvlc_media_player_set_media(mp, m); libvlc_media_player_play(mp);` |
| C# | `player.Play(new Media(libVLC, path, FromType.FromPath));` |
| Python | `player = vlc.MediaPlayer(path); player.play()` |
| Java | `component.mediaPlayer().media().play(path);` |
| Go | `media, _ := player.LoadMediaFromPath(path); player.Play()` |
| C++ | `auto m = VLC::Media(inst, path, VLC::Media::FromPath); player.setMedia(m); player.play();` |

---

## §5. Common Workflows

### 5.1 Play a Local File

```c
libvlc_instance_t *inst = libvlc_new(0, NULL);
libvlc_media_t *media = libvlc_media_new_path(inst, "/path/to/file.mp4");
libvlc_media_player_t *mp = libvlc_media_player_new_from_media(media);
libvlc_media_release(media);
libvlc_media_player_play(mp);
// ... wait or handle events ...
libvlc_media_player_stop(mp);
libvlc_media_player_release(mp);
libvlc_release(inst);
```

### 5.2 Play a Network Stream

```c
libvlc_media_t *media = libvlc_media_new_location(inst, "https://example.com/stream.m3u8");
libvlc_media_add_option(media, ":network-caching=1000");
// Same as local file from here
```

### 5.3 Get Media Metadata

```c
libvlc_media_t *media = libvlc_media_new_path(inst, path);
// Must parse first!
libvlc_media_parse_with_options(media, libvlc_media_parse_local | libvlc_media_fetch_local, 5000);
// Wait for parsing (event or poll):
while (libvlc_media_get_parsed_status(media) != libvlc_media_parsed_status_done) {
    usleep(100000);
}

char *title = libvlc_media_get_meta(media, libvlc_meta_Title);
char *artist = libvlc_media_get_meta(media, libvlc_meta_Artist);
int64_t duration = libvlc_media_get_duration(media);  // ms

libvlc_media_track_t **tracks;
unsigned n = libvlc_media_tracks_get(media, &tracks);
// ... inspect tracks ...
libvlc_media_tracks_release(tracks, n);

if (title) libvlc_free(title);
if (artist) libvlc_free(artist);
libvlc_media_release(media);
```

### 5.4 Extract Thumbnail / Screenshot

**Method 1: Snapshot (requires video output)**
```c
libvlc_media_player_play(mp);
// Wait until playing...
libvlc_video_take_snapshot(mp, 0, "/path/to/thumb.png", 320, 0);  // 0 = auto height
```

**Method 2: Video callbacks (headless)**
```c
// Set up video callbacks (see §3.3) with desired resolution
// In display callback, save the first frame, then stop
libvlc_video_set_callbacks(mp, lock, unlock, display, ctx);
libvlc_video_set_format(mp, "RV32", 320, 240, 320 * 4);
libvlc_media_player_play(mp);
```

### 5.5 Build a Playlist

```c
libvlc_media_list_t *ml = libvlc_media_list_new(inst);
libvlc_media_list_player_t *mlp = libvlc_media_list_player_new(inst);
libvlc_media_player_t *mp = libvlc_media_player_new(inst);

libvlc_media_list_player_set_media_player(mlp, mp);

libvlc_media_list_lock(ml);
for (int i = 0; i < file_count; i++) {
    libvlc_media_t *m = libvlc_media_new_path(inst, files[i]);
    libvlc_media_list_add_media(ml, m);
    libvlc_media_release(m);
}
libvlc_media_list_unlock(ml);

libvlc_media_list_player_set_media_list(mlp, ml);
libvlc_media_list_player_set_playback_mode(mlp, libvlc_playback_mode_loop);
libvlc_media_list_player_play(mlp);
```

### 5.6 Cast to Chromecast

```c
// 1. Discover renderers
libvlc_renderer_discoverer_t *rd = libvlc_renderer_discoverer_new(inst, "microdns_renderer");
libvlc_event_manager_t *em = libvlc_renderer_discoverer_event_manager(rd);
libvlc_event_attach(em, libvlc_RendererDiscovererItemAdded, on_renderer, ctx);
libvlc_renderer_discoverer_start(rd);

// 2. In callback, save the renderer item
void on_renderer(const libvlc_event_t *e, void *data) {
    libvlc_renderer_item_t *item = e->u.renderer_discoverer_item_added.item;
    libvlc_renderer_item_hold(item);  // Retain
    // Store item for later use
}

// 3. Set renderer on player
libvlc_media_player_set_renderer(mp, chromecast_item);
libvlc_media_player_play(mp);

// 4. Stop casting
libvlc_media_player_set_renderer(mp, NULL);
```

**Chromecast-specific options:**
```c
// On the media:
libvlc_media_add_option(media, ":sout-chromecast-conversion-quality=2");
// Quality: 0=low, 1=medium, 2=high
```

### 5.7 Transcode and Save to File

```c
libvlc_media_t *media = libvlc_media_new_path(inst, "/input.avi");
libvlc_media_add_option(media,
    ":sout=#transcode{vcodec=h264,vb=800,acodec=mpga,ab=128,channels=2}"
    ":std{access=file,mux=mp4,dst=/output.mp4}");
libvlc_media_add_option(media, ":no-sout-all");  // Only stream the first track
libvlc_media_add_option(media, ":sout-keep");

libvlc_media_player_t *mp = libvlc_media_player_new_from_media(media);
libvlc_media_release(media);
libvlc_media_player_play(mp);
// Wait for EndReached event
```

**C# (LibVLCSharp) — Record an HLS stream to file:**
```csharp
using var libvlc = new LibVLC();
using var mediaPlayer = new MediaPlayer(libvlc);

libvlc.Log += (sender, e) => Console.WriteLine($"[{e.Level}] {e.Module}:{e.Message}");
mediaPlayer.EndReached += (sender, e) =>
    Console.WriteLine("Recording complete: " + destination);

var destination = Path.Combine(Directory.GetCurrentDirectory(), "record.ts");
using var media = new Media(libvlc,
    new Uri("http://example.com/stream.m3u8"),
    ":sout=#file{dst=" + destination + "}",
    ":sout-keep");

mediaPlayer.Play(media);
// Playback continues until the stream ends — EndReached fires when done
```

**Key points:**
- Use `#file{dst=...}` for passthrough recording (no transcoding) — preserves original codecs
- Use `#transcode{...}:std{access=file,...}` when codec conversion is needed
- `:sout-keep` keeps the sout chain alive across media changes
- `:no-sout-all` limits streaming to the first track of each type (avoids duplicate tracks)

### 5.8 Stream Over HTTP

```c
libvlc_media_t *media = libvlc_media_new_path(inst, "/input.mp4");
libvlc_media_add_option(media,
    ":sout=#transcode{vcodec=h264,acodec=mpga}:http{mux=ts,dst=:8080/stream}");

libvlc_media_player_t *mp = libvlc_media_player_new_from_media(media);
libvlc_media_release(media);
libvlc_media_player_play(mp);
// Stream available at http://localhost:8080/stream
```

### 5.9 Record/Capture from Camera

```c
// Linux (Video4Linux)
libvlc_media_t *media = libvlc_media_new_location(inst, "v4l2:///dev/video0");
libvlc_media_add_option(media, ":v4l2-width=640");
libvlc_media_add_option(media, ":v4l2-height=480");

// To save: add sout option
libvlc_media_add_option(media,
    ":sout=#transcode{vcodec=h264}:std{access=file,mux=mp4,dst=capture.mp4}");
```

### 5.10 Record the Screen

Capture the entire screen to a video file using the `screen://` access module. Works on Windows, macOS, and Linux.

**C:**
```c
libvlc_media_t *media = libvlc_media_new_location(inst, "screen://");
libvlc_media_add_option(media, ":screen-fps=24");
libvlc_media_add_option(media,
    ":sout=#transcode{vcodec=h264,vb=0,scale=0,acodec=mp4a,ab=128,"
    "channels=2,samplerate=44100}:file{dst=record.mp4}");
libvlc_media_add_option(media, ":sout-keep");

libvlc_media_player_t *mp = libvlc_media_player_new_from_media(media);
libvlc_media_release(media);
libvlc_media_player_play(mp);  // Start recording

// ... record for desired duration ...

libvlc_media_player_stop(mp);  // Stop recording and finalize file
libvlc_media_player_release(mp);
```

**C# (LibVLCSharp):**
```csharp
using var libvlc = new LibVLC();
using var mediaPlayer = new MediaPlayer(libvlc);
using var media = new Media(libvlc, "screen://", FromType.FromLocation);

media.AddOption(":screen-fps=24");
media.AddOption(":sout=#transcode{vcodec=h264,vb=0,scale=0,acodec=mp4a," +
    "ab=128,channels=2,samplerate=44100}:file{dst=record.mp4}");
media.AddOption(":sout-keep");

mediaPlayer.Play(media);       // Start recording
await Task.Delay(5000);        // Record for 5 seconds
mediaPlayer.Stop();            // Stop and save
```

**Key points:**
- `screen://` is a pseudo-MRL — it captures the entire primary display
- `vb=0,scale=0` in transcode means auto-bitrate and original resolution
- `:screen-fps=24` controls capture frame rate (higher = smoother but larger files)
- The file is only finalized when `Stop()` is called — ensure clean shutdown
- On Linux, requires X11 (Wayland support varies); on macOS, requires screen recording permission

### 5.11 Browse NAS / UPnP Shares

```c
// 1. Get UPnP media discoverer
libvlc_media_discoverer_t *md = libvlc_media_discoverer_new(inst, "upnp");
libvlc_media_discoverer_start(md);

// 2. Get discovered media list
libvlc_media_list_t *ml = libvlc_media_discoverer_media_list(md);

// 3. Each item is a directory or media
libvlc_media_list_lock(ml);
int count = libvlc_media_list_count(ml);
for (int i = 0; i < count; i++) {
    libvlc_media_t *m = libvlc_media_list_item_at_index(ml, i);
    libvlc_media_type_t type = libvlc_media_get_type(m);
    if (type == libvlc_media_type_directory) {
        // Browse sub-items: parse, then check subitems
        libvlc_media_parse_with_options(m, libvlc_media_parse_network, 5000);
        libvlc_media_list_t *sub = libvlc_media_subitems(m);
        // ... recurse ...
    }
    libvlc_media_release(m);
}
libvlc_media_list_unlock(ml);
```

**C# (LibVLCSharp) — Local Network Browser with MediaDiscoverer:**

Discover LAN services (UPnP, SMB shares) and browse directories. This pattern is used in media browser applications:

```csharp
var libVLC = new LibVLC("--verbose=2");
var mediaDiscoverers = new List<MediaDiscoverer>();

// Find all LAN-type discoverers and start them
foreach (var md in libVLC.MediaDiscoverers(MediaDiscovererCategory.Lan))
{
    var discoverer = new MediaDiscoverer(libVLC, md.Name);

    // Listen for discovered items (e.g., UPnP servers, SMB shares)
    discoverer.MediaList.ItemAdded += (sender, e) =>
        Console.WriteLine($"Found: {e.Media.Meta(MetadataType.Title)}");
    discoverer.MediaList.ItemDeleted += (sender, e) =>
        Console.WriteLine($"Lost: {e.Media.Meta(MetadataType.Title)}");

    mediaDiscoverers.Add(discoverer);
}

// Start discovery
foreach (var md in mediaDiscoverers)
    md.Start();

// Browse into a discovered directory
async Task BrowseDirectory(Media directoryMedia)
{
    // Parse to discover sub-items
    directoryMedia.SubItems.ItemAdded += (sender, e) =>
        Console.WriteLine($"  Sub-item: {e.Media.Meta(MetadataType.Title)}");

    await directoryMedia.Parse(MediaParseOptions.ParseNetwork);
    // Sub-items are now accessible via directoryMedia.SubItems
}
```

### 5.12 Select Audio, Video, and Subtitle Tracks

Track selection must happen **after** playback starts (tracks are discovered during demuxing). Wait for the `MediaPlayerPlaying` event or poll until tracks are available.

**C — Enumerate and select tracks:**
```c
// Wait until playing (tracks aren't available before playback starts)
// Then enumerate audio tracks:
libvlc_track_description_t *tracks = libvlc_audio_get_track_description(mp);
for (libvlc_track_description_t *t = tracks; t != NULL; t = t->p_next) {
    printf("Audio track %d: %s\n", t->i_id, t->psz_name);
}
libvlc_track_description_list_release(tracks);

// Select audio track by ID (i_id from description):
libvlc_audio_set_track(mp, track_id);

// Disable audio: set track to -1
libvlc_audio_set_track(mp, -1);

// Video tracks (same pattern):
libvlc_track_description_t *vtracks = libvlc_video_get_track_description(mp);
libvlc_video_set_track(mp, video_track_id);
libvlc_track_description_list_release(vtracks);

// Subtitle tracks:
libvlc_track_description_t *stracks = libvlc_video_get_spu_description(mp);
libvlc_video_set_spu(mp, subtitle_track_id);
libvlc_track_description_list_release(stracks);

// Disable subtitles:
libvlc_video_set_spu(mp, -1);

// Add external subtitle file at runtime:
libvlc_media_player_add_slave(mp, libvlc_media_slave_type_subtitle,
    "file:///path/to/subtitles.srt", true);

// Add external audio track at runtime:
libvlc_media_player_add_slave(mp, libvlc_media_slave_type_audio,
    "file:///path/to/audio.aac", true);

// Adjust subtitle/audio sync:
libvlc_video_set_spu_delay(mp, 500000);   // +500ms (microseconds)
libvlc_audio_set_delay(mp, -200000);       // -200ms
```

**C# (LibVLCSharp):**
```csharp
player.Playing += (s, e) =>
{
    // Audio tracks (0 = disable, 1+ = track index)
    foreach (var track in player.AudioTrackDescription)
        Console.WriteLine($"Audio {track.Id}: {track.Name}");
    player.SetAudioTrack(trackId);

    // Subtitle tracks (SPU)
    foreach (var track in player.SpuDescription)
        Console.WriteLine($"Sub {track.Id}: {track.Name}");
    player.SetSpu(trackId);
    player.SetSpu(-1);  // Disable subtitles

    // Add external subtitle
    player.AddSlave(MediaSlaveType.Subtitle, "file:///path/to/subs.srt", true);

    // Subtitle delay
    player.SetSpuDelay(500000);  // +500ms in microseconds
};
```

**Python:**
```python
import vlc, time

player = vlc.MediaPlayer("video.mkv")
player.play()
time.sleep(2)  # Wait for tracks to become available

# Audio tracks
for t in player.audio_get_track_description():
    print(f"Audio {t[0]}: {t[1]}")
player.audio_set_track(track_id)

# Subtitle tracks
for t in player.video_get_spu_description():
    print(f"Sub {t[0]}: {t[1]}")
player.video_set_spu(track_id)
player.video_set_spu(-1)  # Disable

# External subtitle
player.add_slave(vlc.MediaSlaveType.subtitle, "file:///path/to/subs.srt", True)
```

**Key points:**
- Track IDs come from the `i_id` field of `libvlc_track_description_t`, NOT sequential indices
- Track ID `-1` typically means "disable" (no audio / no subtitle)
- Track ID `0` in audio often means "disable" depending on the binding
- `add_slave()` can add external subtitles or audio tracks **during playback** — the `select` parameter (`true`) auto-selects the new track
- Subtitle and audio delays are in **microseconds** and reset when media changes

### 5.13 Video Mosaic (Multiple Players)

Play multiple video streams simultaneously using separate `MediaPlayer` instances sharing a single `LibVLC` instance. Common for CCTV/surveillance dashboards or multi-camera views.

**C:**
```c
// Single instance, multiple players
libvlc_instance_t *inst = libvlc_new(0, NULL);

libvlc_media_player_t *players[4];
const char *urls[] = {
    "rtsp://camera1/stream", "rtsp://camera2/stream",
    "rtsp://camera3/stream", "rtsp://camera4/stream"
};

for (int i = 0; i < 4; i++) {
    players[i] = libvlc_media_player_new(inst);
    libvlc_media_player_set_hwnd(players[i], window_handles[i]);  // One window per player
    libvlc_media_t *m = libvlc_media_new_location(inst, urls[i]);
    libvlc_media_player_set_media(players[i], m);
    libvlc_media_release(m);
    libvlc_media_player_play(players[i]);
}

// Cleanup: stop and release each player, then release instance
```

**C# (LibVLCSharp / Xamarin.Forms) — RTSP Mosaic:**
```csharp
const string VideoUrl = "rtsp://camera/stream";
var libvlc = new LibVLC();

// Create separate MediaPlayer for each VideoView in the layout
VideoView0.MediaPlayer = new MediaPlayer(libvlc);
using (var media = new Media(libvlc, new Uri(VideoUrl)))
    VideoView0.MediaPlayer.Play(media);

VideoView1.MediaPlayer = new MediaPlayer(libvlc);
using (var media = new Media(libvlc, new Uri(VideoUrl)))
    VideoView1.MediaPlayer.Play(media);

// Repeat for VideoView2, VideoView3, etc.
```

**Key points:**
- **Always share a single `LibVLC` instance** — each `MediaPlayer` has its own decoder pipeline but shares plugin infrastructure
- Each `MediaPlayer` needs its own video output window/surface — never share a window between players
- For RTSP streams, set `:network-caching=1000` to buffer against network jitter
- On mobile, consider CPU/GPU limits — 4+ simultaneous HD streams may drop frames

### 5.14 Mobile Foreground/Background Lifecycle (Android)

On Android, the native video surface is released when the app goes to background. You must save playback state, tear down the `VideoView`, and recreate it when returning to foreground.

**C# (LibVLCSharp.Forms / Xamarin.Forms):**
```csharp
LibVLC _libVLC;
MediaPlayer _mediaPlayer;
float _position;

// When app goes to background (OnPause):
MessagingCenter.Subscribe<string>(this, "OnPause", app =>
{
    _mediaPlayer.Pause();
    _position = _mediaPlayer.Position;  // Save position (0.0–1.0)
    _mediaPlayer.Stop();
    MainGrid.Children.Clear();          // Remove VideoView (releases native surface)
});

// When app returns to foreground (OnRestart):
MessagingCenter.Subscribe<string>(this, "OnRestart", app =>
{
    var videoView = new VideoView {
        HorizontalOptions = LayoutOptions.FillAndExpand,
        VerticalOptions = LayoutOptions.FillAndExpand
    };
    MainGrid.Children.Add(videoView);   // Create fresh VideoView

    videoView.MediaPlayer = _mediaPlayer;
    _mediaPlayer.Position = _position;   // Restore position
    _position = 0;
    _mediaPlayer.Play();
});
```

**Key points:**
- On Android, the native libvlc video surface is destroyed when the app is paused/stopped — this is a platform behavior, not a bug
- **Save** `Position` (or `Time`) before `Stop()`, and **remove** the `VideoView` from the layout
- On resume, create a **new** `VideoView` and add it to the layout — reattach the existing `MediaPlayer`
- The `MediaPlayer` object itself survives backgrounding — only the view surface needs recreation
- iOS does not have this issue — `UIView` survives background transitions
- For MAUI/.NET 8+, use `Application.Current.Windows[0].Activated` / `Deactivated` instead of `MessagingCenter`

### 5.15 Gesture-Based Playback Control

Map touch/pan gestures to seeking and volume control. Horizontal swipes control time position, vertical swipes control volume.

**C# (Xamarin.Forms — PanGestureRecognizer):**
```csharp
long _finalTime;
int _finalVolume;
bool _timeChanged, _volumeChanged;

void OnGesture(PanUpdatedEventArgs e)
{
    switch (e.StatusType)
    {
        case GestureStatus.Running:
            if (Math.Abs(e.TotalX) > Math.Abs(e.TotalY))
            {
                // Horizontal swipe → seek
                var timeDiff = Convert.ToInt64(e.TotalX * 1000);  // ms
                _finalTime = MediaPlayer.Time + timeDiff;
                _timeChanged = true;
            }
            else
            {
                // Vertical swipe → volume (up = louder)
                var volume = (int)(MediaPlayer.Volume + e.TotalY * -1);
                _finalVolume = Math.Clamp(volume, 0, 200);
                _volumeChanged = true;
            }
            break;

        case GestureStatus.Completed:
            if (_timeChanged)
                MediaPlayer.Time = _finalTime;
            if (_volumeChanged)
                MediaPlayer.Volume = _finalVolume;
            _timeChanged = _volumeChanged = false;
            break;
    }
}
```

**Key points:**
- Apply time/volume changes on `GestureStatus.Completed`, not `Running` — avoids excessive libvlc calls during the drag
- Volume range is 0–200 (100 = normal, >100 = amplification)
- `Time` is in milliseconds — multiply gesture distance by a scaling factor for natural feel
- This pattern works for 360° video too — map gestures to `UpdateViewpoint()` yaw/pitch instead

### 5.16 Hardware-Accelerated Playback (EnableHardwareDecoding)

Enable platform-specific hardware decoding for better performance and lower CPU usage.

**C:**
```c
const char *args[] = {"--avcodec-hw=any"};  // auto-select best HW decoder
libvlc_instance_t *inst = libvlc_new(1, args);
// Hardware decoding options: "any", "none", "d3d11va" (Win), "vaapi" (Linux),
// "videotoolbox" (macOS/iOS), "mediacodec" (Android)
```

**C# (LibVLCSharp):**
```csharp
var media = new Media(LibVLC,
    new Uri("http://example.com/video.mp4"));
var mediaPlayer = new MediaPlayer(media) { EnableHardwareDecoding = true };
media.Dispose();
mediaPlayer.Play();
```

**Key points:**
- `EnableHardwareDecoding = true` maps to `--avcodec-hw=any` in libvlc
- Hardware decoding reduces CPU usage significantly for H.264/H.265 content
- Falls back to software decoding automatically if hardware decoder is unavailable
- On Android, uses MediaCodec; on iOS/macOS, uses VideoToolbox; on Windows, uses D3D11VA or DXVA2
- If you see green/corrupt frames, try disabling hardware decoding as a diagnostic step (see §8.2)

### 5.17 Audio-Only Playback (Music Player)

Build a music player by disabling video output. Reduces resource usage and works headless.

**C# (LibVLCSharp) — Audio service with event-driven UI updates:**
```csharp
var libVLC = new LibVLC();
var mediaPlayer = new MediaPlayer(libVLC);

// Create media with video disabled
using var media = new Media(libVLC,
    new Uri("https://example.com/song.mp4"), ":no-video");
mediaPlayer.Media = media;

// Subscribe to playback events for UI updates
mediaPlayer.TimeChanged += (s, e) => UpdateTimeDisplay(e.Time);
mediaPlayer.PositionChanged += (s, e) => UpdateSeekBar(e.Position);
mediaPlayer.LengthChanged += (s, e) => UpdateDuration(e.Length);
mediaPlayer.EndReached += (s, e) => OnTrackFinished();
mediaPlayer.Playing += (s, e) => ShowPlayingState();
mediaPlayer.Paused += (s, e) => ShowPausedState();

mediaPlayer.Play();

// Seeking: offset by milliseconds
mediaPlayer.Time += 5000;   // Forward 5 seconds
mediaPlayer.Time -= 5000;   // Rewind 5 seconds
```

**Key points:**
- `:no-video` prevents video decoding entirely — not just hiding the output
- `TimeChanged` and `PositionChanged` fire frequently during playback — use them for scrubber/progress UI
- `LengthChanged` fires once the duration is known (may not be immediate for streams)
- Remember: never call libvlc from event callbacks — offload to UI thread

---

## §6. Platform Integration

### 6.1 Windows

**WPF:**
```csharp
// LibVLCSharp.WPF — uses WindowsFormsHost (airspace limitation)
<vlc:VideoView x:Name="VideoView" />

// Code-behind:
VideoView.MediaPlayer = new MediaPlayer(libVLC);
VideoView.MediaPlayer.Play(media);
```

**WinForms:**
```csharp
// Direct handle access
var videoView = new VideoView();
videoView.MediaPlayer = new MediaPlayer(libVLC);
videoView.MediaPlayer.Play(media);
```

**UWP:**
```csharp
// Requires SwapChainPanel + special options
using var libVLC = new LibVLC("--aout=winstore");
```

**Win32 (C):**
```c
libvlc_media_player_set_hwnd(mp, (void *)GetActiveWindow());
```

### 6.2 macOS / iOS / tvOS

```c
// Set NSView (macOS) or UIView (iOS)
libvlc_media_player_set_nsobject(mp, (__bridge void *)myView);
```

**LibVLCSharp:**
```csharp
// VideoView is NSView/UIView based
<vlc:VideoView x:Name="VideoView" />
```

### 6.3 Linux

```c
// X11 window ID
libvlc_media_player_set_xwindow(mp, (uint32_t)xid);
```

**GTK:**
```c
GtkWidget *drawing_area = gtk_drawing_area_new();
// After realize:
GdkWindow *gdk_win = gtk_widget_get_window(drawing_area);
XID xid = gdk_x11_window_get_xid(gdk_win);
libvlc_media_player_set_xwindow(mp, xid);
```

### 6.4 Android

```c
libvlc_media_player_set_android_context(mp, awindow);
```

**LibVLCSharp.Android:**
```csharp
// VideoView wraps SurfaceView
<vlc:VideoView android:id="@+id/videoView" />
```

**vlcj (Android via libvlcjni):**
- Uses `org.videolan.libvlc` from JitPack
- `IVLCVout` interface for surface management

### 6.5 Framework Comparison

| Framework | Binding | Video Surface | GPU Accel |
|-----------|---------|---------------|-----------|
| WPF | LibVLCSharp.WPF | WindowsFormsHost | Yes (D3D) |
| WinForms | LibVLCSharp.WinForms | Direct Handle | Yes (D3D) |
| UWP | LibVLCSharp.UWP | SwapChainPanel | Yes (D3D11) |
| Xamarin.iOS | LibVLCSharp | UIView | Yes (OpenGL) |
| Xamarin.Android | LibVLCSharp | SurfaceView | Yes (MediaCodec) |
| Swing | vlcj | AWT Canvas | Yes (platform) |
| JavaFX | vlcj | PixelBuffer callback | CPU copy |
| GTK | C/Python | DrawingArea | Yes (platform) |
| Qt | C++ | QWidget (winId) | Yes (platform) |
| Avalonia | LibVLCSharp.Avalonia | NativeControlHost | Yes (platform) |

### 6.6 Using MediaPlayerElement (Plug-and-Play UI Control)

`MediaPlayerElement` is a high-level control in LibVLCSharp.Forms that provides a ready-made video player UI with transport controls (play/pause, seek bar, volume, track selection, Chromecast). It replaces the need to build playback UI from scratch.

**Xamarin.Forms / MAUI XAML:**
```xml
<vlc:MediaPlayerElement
    EnableRendererDiscovery="True"
    LibVLC="{Binding LibVLC}"
    MediaPlayer="{Binding MediaPlayer}" />
```

**ViewModel:**
```csharp
public class MainViewModel : INotifyPropertyChanged
{
    public LibVLC LibVLC { get; private set; }
    public MediaPlayer MediaPlayer { get; private set; }

    public void OnAppearing()
    {
        Core.Initialize();
        LibVLC = new LibVLC(enableDebugLogs: true);

        var media = new Media(LibVLC,
            new Uri("http://example.com/video.mp4"));
        MediaPlayer = new MediaPlayer(media) { EnableHardwareDecoding = true };
        media.Dispose();
        MediaPlayer.Play();
    }

    public void OnDisappearing()
    {
        MediaPlayer.Dispose();
        LibVLC.Dispose();
    }
}
```

**Customization** — hide/show controls, change colors, toggle features:
```xml
<vlc:MediaPlayerElement LibVLC="{Binding LibVLC}" MediaPlayer="{Binding MediaPlayer}">
    <vlc:MediaPlayerElement.PlaybackControls>
        <vlc:PlaybackControls
            MainColor="Red"
            IsAspectRatioButtonVisible="False"
            IsAudioTracksSelectionButtonVisible="False"
            IsClosedCaptionsSelectionButtonVisible="False"
            KeepScreenOn="True"
            ShowAndHideAutomatically="True" />
    </vlc:MediaPlayerElement.PlaybackControls>
</vlc:MediaPlayerElement>
```

**Available customization properties:**
- `MainColor`, `ButtonColor`, `Foreground` — theme colors
- `IsPlayPauseButtonVisible`, `IsStopButtonVisible`, `IsSeekBarVisible`, `IsSeekEnabled` — transport controls
- `IsRewindButtonVisible`, `IsSeekButtonVisible` — skip forward/back buttons
- `IsAudioTracksSelectionButtonVisible`, `IsClosedCaptionsSelectionButtonVisible` — track pickers
- `IsCastButtonVisible` — Chromecast button (requires `EnableRendererDiscovery="True"`)
- `IsAspectRatioButtonVisible` — aspect ratio toggle
- `KeepScreenOn` — prevent screen dimming during playback
- `ShowAndHideAutomatically` — auto-hide controls after inactivity

### 6.7 Avalonia Desktop Integration

LibVLCSharp.Avalonia provides a `VideoView` control using Avalonia's `NativeControlHost`. This is suitable for cross-platform desktop apps on Windows, macOS, and Linux.

```csharp
// Avalonia ViewModel — proper Dispose pattern
public class MainWindowViewModel : IDisposable
{
    private readonly LibVLC _libVlc = new();
    public MediaPlayer MediaPlayer { get; }

    public MainWindowViewModel()
    {
        MediaPlayer = new MediaPlayer(_libVlc);
    }

    public void Play()
    {
        if (Design.IsDesignMode) return;  // Skip in XAML preview
        using var media = new Media(_libVlc,
            new Uri("http://example.com/video.mp4"));
        MediaPlayer.Play(media);
    }

    public void Dispose()
    {
        MediaPlayer.Stop();
        MediaPlayer.Dispose();
        _libVlc.Dispose();
    }
}
```

**Key points:**
- Check `Design.IsDesignMode` to avoid libvlc calls during XAML previewer rendering
- Implement `IDisposable` to properly clean up native resources
- `VideoView` in Avalonia wraps `NativeControlHost` — ensure `AllowsTransparency` is not set on the window (native video surfaces don't support transparency on all platforms)

---

## §7. Streaming & Transcoding

### 7.1 Sout Chain Syntax

The stream output chain uses the `:sout=` option with `#module{params}:module{params}` syntax:

```
:sout=#transcode{<params>}:standard{<params>}
:sout=#transcode{<params>}:duplicate{dst=display,dst=standard{<params>}}
```

**Common sout modules:**

| Module | Purpose | Key Parameters |
|--------|---------|---------------|
| `transcode` | Convert codec | `vcodec`, `vb` (bitrate), `acodec`, `ab`, `channels`, `width`, `height`, `fps`, `scale` |
| `standard`/`std` | Output destination | `access` (file/http/udp), `mux` (ts/mp4/ogg/webm), `dst` (path/url) |
| `duplicate` | Split stream | `dst=display` (show locally), `dst=standard{...}` |
| `rtp` | RTP streaming | `dst`, `port`, `mux` |
| `http` | HTTP streaming | `dst`, `mux` |

### 7.2 Common Sout Recipes

**Save to file:**
```
:sout=#transcode{vcodec=h264,vb=2000,acodec=mp4a,ab=192}:std{access=file,mux=mp4,dst=/output.mp4}
```

**HTTP live stream:**
```
:sout=#transcode{vcodec=h264,acodec=mpga,ab=128}:http{mux=ts,dst=:8080/stream}
```

**UDP multicast:**
```
:sout=#transcode{vcodec=h264}:rtp{mux=ts,dst=239.0.0.1,port=1234}
```

**Display locally AND save:**
```
:sout=#transcode{vcodec=h264}:duplicate{dst=display,dst=std{access=file,mux=mp4,dst=out.mp4}}
```

**Audio only (extract audio):**
```
:sout=#transcode{acodec=mp3,ab=192}:std{access=file,mux=raw,dst=output.mp3}
:no-video
```

### 7.3 Video Codecs

| Codec ID | Codec | Notes |
|----------|-------|-------|
| `h264` | H.264/AVC | Most compatible |
| `h265` | H.265/HEVC | Better compression |
| `mp4v` | MPEG-4 Part 2 | Legacy |
| `VP80` | VP8 | WebM |
| `VP90` | VP9 | WebM, better |
| `theo` | Theora | Ogg |
| `none` | No video | Strip video track |

### 7.4 Audio Codecs

| Codec ID | Codec | Notes |
|----------|-------|-------|
| `mpga` | MP3 | Universal |
| `mp4a` | AAC | Better quality |
| `vorb` | Vorbis | Ogg |
| `opus` | Opus | Best for voice |
| `flac` | FLAC | Lossless |
| `none` | No audio | Strip audio track |

### 7.5 Container Formats (Mux)

| Mux | Format | Typical Use |
|-----|--------|-------------|
| `ts` | MPEG-TS | Streaming (HTTP, UDP) |
| `mp4` | MP4/MOV | File output |
| `ogg` | Ogg | Vorbis/Theora |
| `webm` | WebM | VP8/VP9 + Opus |
| `avi` | AVI | Legacy |
| `raw` | Raw | Single codec output |
| `asf` | ASF/WMV | Windows |

---

## §8. Troubleshooting & Gotchas

### 8.1 Critical Pitfalls (Will Bite You)

#### Deadlock from Event Callbacks
**Symptom:** Application freezes/hangs during playback event.
**Cause:** Calling any libvlc function from within a libvlc event callback.
**Fix:** Offload work to another thread. See §2.2 for per-language patterns.

#### Stop() Freezing
**Symptom:** `libvlc_media_player_stop()` blocks for seconds (especially RTSP streams in LibVLC 3).
**Fix:** Call `stop()` from a background thread:
```csharp
// C#
ThreadPool.QueueUserWorkItem(_ => player.Stop());
```
```java
// Java
mediaPlayer.submit(() -> mediaPlayer.controls().stop());
```

#### Memory Leaks from Event Handlers
**Symptom:** Growing memory usage over time.
**Cause (C#):** LibVLCSharp events are native callbacks. Failing to unsubscribe causes both managed and native memory leaks.
**Fix:** Always unsubscribe event handlers before disposing objects:
```csharp
player.Playing -= OnPlaying;
player.Dispose();
```

#### Multiple LibVLC Instances
**Symptom:** Crashes, undefined behavior, plugin conflicts.
**Cause:** Creating more than one `libvlc_instance_t`.
**Fix:** Create exactly ONE instance, share it across all players.

#### GC Collecting Active Players
**Symptom:** Random crashes, especially in Java/Python.
**Cause:** Player object goes out of scope while native thread still runs.
**Fix:** Keep strong references to all libvlc objects as class fields, not local variables.

#### Untrusted Input to `media_add_option` (Security)
**Symptom:** Media exfiltration, arbitrary file writes, or unexpected streaming behavior.
**Cause:** `libvlc_media_add_option()` treats the option as **trusted** — it can set `sout` chains, write files, open network streams, etc. If the option string comes from user input (e.g., a URL parameter, config file, or UI text field), an attacker can inject `:sout=#transcode{...}:std{access=file,dst=/etc/passwd}` or redirect media to a remote server.
**Fix:** Use `libvlc_media_add_option_flag()` with the **untrusted** flag (value `0x0`, the default when no flags are set) for any user-provided input. Only use `libvlc_media_option_trusted` (`0x2`) for options your application controls:
```c
// SAFE — user-provided options are untrusted (default flag = 0)
libvlc_media_add_option_flag(media, user_input, 0);

// TRUSTED — only for app-controlled options
libvlc_media_add_option_flag(media, ":network-caching=1000", libvlc_media_option_trusted);

// DANGEROUS — libvlc_media_add_option() always trusts the input
// Never pass user/network input to this function:
libvlc_media_add_option(media, user_input);  // ⚠️ DO NOT DO THIS
```
**Binding equivalents:**
- **C#** (LibVLCSharp): `media.AddOption(":option")` — trusted by default. Validate/sanitize user input before passing.
- **Python**: `media.add_option(":option")` — same caveat.
- **vlcj**: `media().play(mrl, ":option")` — trusted. Sanitize.

### 8.2 Common Issues

#### Green/Corrupt Video Frames
**Cause:** GPU driver issue or incompatible hardware decoding.
**Fix:**
1. Update GPU drivers
2. Disable hardware decoding: `--avcodec-hw=none`
3. Try different video output: `--vout=x11` (Linux), `--vout=directdraw` (Windows)

#### No Audio Output
**Cause:** Audio output device not configured or unavailable.
**Fix:**
1. List available outputs: `libvlc_audio_output_list_get()`
2. Set explicitly: `libvlc_audio_output_set(mp, "alsa")` (or `"directsound"`, `"coreaudio"`)
3. Check volume: `libvlc_audio_set_volume(mp, 100)`

#### Chromecast Not Found
**Cause:** VPN blocking mDNS discovery, or network isolation.
**Fix:**
1. Disconnect VPN
2. Ensure device is on same subnet
3. Check firewall (mDNS uses port 5353/UDP)

#### YouTube URLs Not Playing
**Cause:** YouTube requires network parsing to resolve actual stream URL.
**Fix:**
```c
libvlc_media_parse_with_options(media, libvlc_media_parse_network, 10000);
// Then play first sub-item:
libvlc_media_list_t *subs = libvlc_media_subitems(media);
libvlc_media_list_lock(subs);
libvlc_media_t *actual = libvlc_media_list_item_at_index(subs, 0);
libvlc_media_list_unlock(subs);
libvlc_media_player_set_media(mp, actual);
libvlc_media_player_play(mp);
```

#### Slow Startup / Plugin Scan
**Cause:** LibVLC scans all plugins on first `libvlc_new()`.
**Fix:**
1. Pre-generate `plugins.dat` cache file (or use `--reset-plugins-cache` once, then rely on cache)
2. Initialize LibVLC early (splash screen, app startup)
3. Reuse the instance — don't destroy and recreate
4. Use `--no-plugins-scan` to skip directory scanning and load only from cache (if cache exists)
5. See §2.7 for full plugin discovery details and `VLC_PLUGIN_PATH` usage

#### Video Callbacks Performance (LibVLC 3.x)
**Cause:** CPU-based pixel copying with no GPU acceleration.
**Fix:**
1. Use smallest necessary resolution
2. Use `I420` chroma (smaller than `RV32`)
3. Process frames asynchronously — don't block the lock/unlock callbacks

#### Subtitle Encoding Issues
**Fix:** Set encoding option:
```c
// Instance level:
"--subsdec-encoding=Windows-1252"
// Or per-media:
":subsdec-encoding=UTF-8"
```

### 8.3 Debugging Methodology

1. **Enable verbose logging:**
   ```c
   const char *args[] = {"--verbose=2"};
   libvlc_instance_t *inst = libvlc_new(1, args);
   ```
   Or set log callback to capture programmatically (see §2.5).

2. **Build minimal reproduction:** Isolate the issue in the smallest possible code.

3. **Check the logs:** Look for `[error]` and `[warning]` lines. Common indicators:
   - `no suitable decoder` — missing codec plugin
   - `connection refused` — network issue
   - `main decoder error` — corrupt media or unsupported format

4. **Regression test:** Does it work in official VLC app? Does it work with a different file? Different platform?

5. **Version check:** `libvlc_get_version()` — verify you're running expected version.

---

## §9. CLI Options Quick Reference

### Instance-Level (`--option=value` in constructor)

| Option | Description | Default |
|--------|-------------|---------|
| `--verbose=N` | Log verbosity: 0=errors, 1=warnings, 2=debug | 0 |
| `--no-video-title-show` | Don't show media title on video | off |
| `--no-video` | Disable video output entirely | off |
| `--no-audio` | Disable audio output entirely | off |
| `--avcodec-hw=MODE` | Hardware decoding: `any`, `none`, `d3d11va`, `vaapi`, `videotoolbox` | `any` |
| `--network-caching=MS` | Network stream buffer in ms | 1000 |
| `--file-caching=MS` | File stream buffer in ms | 300 |
| `--live-caching=MS` | Live stream buffer in ms | 300 |
| `--vout=MODULE` | Video output: `x11`, `gl`, `directdraw`, `d3d11`, `caca` | auto |
| `--aout=MODULE` | Audio output: `pulse`, `alsa`, `directsound`, `coreaudio`, `winstore` | auto |
| `--freetype-rel-fontsize=N` | Subtitle font size (relative) | 16 |
| `--freetype-color=N` | Subtitle color (decimal, e.g., 16711680 = red) | 16777215 |
| `--subsdec-encoding=ENC` | Subtitle encoding: `UTF-8`, `Windows-1252`, etc. | auto |
| `--hrtf-file=PATH` | 3D audio HRTF file path | — |
| `--no-plugins-cache` | Disable plugin cache, force re-scan every startup | cache enabled |
| `--no-plugins-scan` | Don't scan plugin dirs, load from cache only | scan enabled |
| `--reset-plugins-cache` | Rebuild `plugins.dat` cache on next startup | off |

### Media-Level (`:option=value` via `media_add_option`)

| Option | Description |
|--------|-------------|
| `:no-audio` | Disable audio for this media |
| `:no-video` | Disable video for this media |
| `:network-caching=MS` | Override network caching |
| `:start-time=SEC` | Start playback at N seconds |
| `:stop-time=SEC` | Stop playback at N seconds |
| `:run-time=SEC` | Play for N seconds |
| `:sub-file=PATH` | External subtitle file path |
| `:sub-language=LANG` | Preferred subtitle language (e.g., `"eng"`, `"none"`) |
| `:sout=CHAIN` | Stream output chain (see §7) |
| `:sout-keep` | Keep sout instance across media changes |
| `:no-sout-all` | Only stream first track of each type |
| `:sout-chromecast-conversion-quality=N` | Chromecast quality: 0=low, 1=medium, 2=high |
| `:input-repeat=N` | Repeat input N times (0=play once) |

**Format difference:** Instance options use `--double-dash`, Media options use `:colon-prefix`.

---

## §10. Deprecated API — Do NOT Use

The following functions are deprecated. Always suggest their modern replacements:

| Deprecated | Replacement |
|-----------|-------------|
| `libvlc_media_parse()` | `libvlc_media_parse_with_options()` |
| `libvlc_media_parse_async()` | `libvlc_media_parse_with_options()` |
| `libvlc_media_is_parsed()` | `libvlc_media_get_parsed_status()` |
| `libvlc_media_get_tracks_info()` | `libvlc_media_tracks_get()` |
| `libvlc_media_player_get_fps()` | `libvlc_media_tracks_get()` (get FPS from video track info) |
| `libvlc_video_get_height()` | `libvlc_video_get_size()` |
| `libvlc_video_get_width()` | `libvlc_video_get_size()` |
| `libvlc_video_set_subtitle_file()` | `libvlc_media_player_add_slave()` |
| `libvlc_track_description_release()` | `libvlc_track_description_list_release()` |
| `libvlc_media_player_set_agl()` | `libvlc_media_player_set_nsobject()` |
| `libvlc_media_discoverer_new_from_name()` | `libvlc_media_discoverer_new()` + `_start()` |
| `libvlc_media_discoverer_localized_name()` | `libvlc_media_discoverer_list_get()` |
| `libvlc_wait()` | `libvlc_set_exit_handler()` |
| `libvlc_log_open/close/count/clear/get_iterator/iterator_*()` | `libvlc_log_set()` with callback |
| `libvlc_playlist_play()` | `libvlc_media_list` + `libvlc_media_list_player` |
| `libvlc_audio_output_device_count/longname/id()` | `libvlc_audio_output_device_list_get()` |
| `libvlc_toggle_teletext()` | `libvlc_video_set_teletext()` |

---

## §11. Available Language Bindings

| Language | Binding | Package/Repo |
|----------|---------|--------------|
| C | libvlc (native) | `#include <vlc/vlc.h>` |
| C++ | libvlcpp | Header-only, part of VLC ecosystem |
| C# / .NET | LibVLCSharp | NuGet: `LibVLCSharp` + `VideoLAN.LibVLC.*` |
| Python | python-vlc | PyPI: `python-vlc` |
| Java (Desktop) | vlcj | Maven: `uk.co.caprica:vlcj:4.x` |
| Java (Android) | libvlcjni | JitPack / VLC Android SDK |
| Kotlin | vlcj / libvlcjni | Same as Java |
| Objective-C / Swift | VLCKit | CocoaPods: `MobileVLCKit` / `TVVLCKit` |
| Go | libvlc-go | `github.com/adrg/libvlc-go/v3` |
| Rust | vlc-rs | `crates.io/crates/vlc-rs` |
| Dart/Flutter | dart_vlc (desktop), flutter_vlc_player (mobile) | pub.dev |
| Node.js | webchimera.js | npm: `webchimera.js` |

---

## §12. Quick Decision Guide

**"Which binding should I use?"**

| Platform | Recommended Binding |
|----------|-------------------|
| Windows desktop (.NET) | LibVLCSharp |
| macOS/iOS/tvOS (Swift) | VLCKit |
| Android (Kotlin/Java) | libvlcjni + LibVLCSharp.Android |
| Cross-platform .NET (MAUI, Avalonia) | LibVLCSharp |
| Desktop Java/Kotlin | vlcj 4.x |
| Python scripting | python-vlc |
| Go application | libvlc-go |
| C/C++ application | libvlc / libvlcpp |
| Rust application | vlc-rs |
| Electron/Web | webchimera.js or LibVLC WASM (experimental) |

**"How should I render video?"**

| Need | Approach |
|------|----------|
| Embedded in native window | `set_hwnd`/`set_xwindow`/`set_nsobject` |
| Custom rendering / texture | Video callbacks (lock/unlock/display) |
| Headless (no display) | `--no-video` or video callbacks to `/dev/null` |
| Off-screen thumbnail | Video callbacks, capture first frame |
| Multiple simultaneous videos | Multiple MediaPlayers, one LibVLC instance |

**"How do I handle the end of playback?"**

All bindings: Listen for `EndReached` / `MediaPlayerEndReached` event. **Always** offload the next action to a different thread — never call libvlc from the callback.
