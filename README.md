<p align="center">
  <img width="120" height="120" src="build/icon.png">
</p>
<h3 align="center">Fluent Reader Tauri</h3>
<p align="center">A Tauri + Rust rewrite of Fluent Reader, with on-device AI translation</p>
<hr />

> **Status: experimental / work in progress.** This is a personal rewrite, not
> an official successor to Fluent Reader. Expect rough edges, missing sync
> services (see below), and no signed/notarized release builds yet.

## Credits

Fluent Reader Tauri is a derivative work of
**[Fluent Reader](https://github.com/yang991178/fluent-reader)** by
**Haoyuan Liu ([@yang991178](https://github.com/yang991178))** — the original
Electron + React RSS reader this project is rewritten from. Its UI, data
model, and much of the frontend logic are carried over and reimplemented here
on top of a Tauri + Rust backend. If you just want the original, actively
maintained app, [get it here](https://github.com/yang991178/fluent-reader) or
support its author through
[GitHub Sponsors](https://github.com/sponsors/yang991178).

The original project's BSD 3-Clause notice, reproduced per its attribution
requirement:

```
BSD 3-Clause License

Copyright (c) 2020, Haoyuan Liu
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Fluent Reader Tauri itself (the Tauri/Rust rewrite, the translation feature,
and everything added since) is licensed separately under the GPL — see
[License](#license).

## What's different from Fluent Reader

This is not a 1:1 port. The Electron shell and the Node/Lovefield storage
layer were replaced with a Tauri + Rust backend (SQLite instead of
Lovefield), and the sync layer was narrowed while a new AI translation layer
was added.

### New

- **On-device AI translation.** Auto-downloads a matching `llama-server`
  runtime for your OS/arch and runs a local, OpenAI-compatible chat endpoint.
  Ships with a curated default model (Qwen2.5-7B-Instruct, GGUF) and supports
  importing your own `.gguf` models.
- **Per-article target language and model routing** — pick a target language
  and which imported model handles it, per article.
- **Daily Digest.** A curated, bounded set of "enough for today" unread
  articles, picked across your groups by weight (with a per-group coverage
  guarantee and a per-source cap so one prolific feed can't dominate), frozen
  once per local day. Group weights are configurable, including muting a
  group out of the digest entirely.
- **Global show/hide shortcut and close-to-hide.** A system-wide shortcut
  toggles the window even while it's unfocused or hidden, and closing the
  window hides it instead of quitting (with a separate quit shortcut).

### Missing

- **Sync services beyond Fever.** Only the Fever protocol (and Fever-compatible
  self-hosted servers, e.g. FreshRSS, Tiny Tiny RSS's Fever plugin) is
  implemented. The original's native Google Reader API, Inoreader, Feedbin,
  The Old Reader, and BazQux Reader integrations are not present.
- **Full-content article extraction.** No Mercury-Parser-equivalent reader
  view. Articles render from their raw HTML/RSS content, no "extract full
  page" fallback.
- **Store distribution.** No Microsoft Store / Mac App Store packaging,
  code-signing, or notarization. Build and run it yourself (below).
- **Mobile companion app.** The original has a
  [separate mobile app](https://github.com/yang991178/fluent-reader-lite);
  this rewrite doesn't have (or plan) a mobile counterpart.

### Changed behavior

- **Search and auto-rules use substring matching, not regular expressions.**
  The original's regex-based search and hide/mark-read/star rules are
  implemented here as case-insensitive substring matches instead.

### Kept

OPML import/export, full data backup, folder-style subscription groups,
read/star/hide rules, native OS notifications for rule-flagged items on
background fetch, and the original's single-key keyboard shortcuts
(`j`/`k`/`m`/`s`/`r`/`o`).

## Development

| Task | Command |
|---|---|
| Dev | `pnpm tauri:dev` |
| Production build | `pnpm tauri:build` |
| Install desktop entry (Linux) | `pnpm tauri:install` |
| Frontend tests | `pnpm test` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Type / build check | `pnpm build` |

### Developed with

- [Tauri](https://github.com/tauri-apps/tauri) + [Rust](https://www.rust-lang.org/)
- [React](https://github.com/facebook/react)
- [SQLite](https://www.sqlite.org/) via [sqlx](https://github.com/launchbadge/sqlx)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, for local translation

## License

GPL-3.0-or-later - see [LICENSE](LICENSE). Portions of this codebase are
derived from Fluent Reader (BSD 3-Clause); see [Credits](#credits) above for
the original notice.

I wrote most of the code here with heavy AI assistance, directing and
revising it myself. US copyright law treats only fully autonomous AI output
as unauthored and already public domain. Work directed by a human doesn't
qualify no matter how much of the typing an AI did. GPL is the license that
gets closest to what I want here, because this code should stay everyone's
permanently. Projects using this code should also stay everyone's.
Public-domain dedication, however, would let someone fork this, close the
source, and resell it.
