# OpenCode Desktop and UI

OpenAGI builds the original OpenCode v2 desktop client from the vendored source
in `vendor/opencode`. This includes the desktop main process and preload, the
complete app shell and settings, session timeline and message/tool rendering,
shared UI components and styles, GUI extension host and built-in extensions,
client protocol packages, fonts, icons, workers and other application assets.

Upstream repository: https://github.com/anomalyco/opencode
Source reference: `v2`, commit `903ec2bb35379efc255e6331fe264dd057eb84e4`.
Pinned package version: `2.0.26`.
Pinned source link: https://github.com/anomalyco/opencode/tree/903ec2bb35379efc255e6331fe264dd057eb84e4
Build provenance: `upstream.json`, the original `vendor/opencode/bun.lock`,
`scripts/upstream-prepare.mjs`, and `desktop-upstream-builder.mjs`.

OpenAGI additions integrate through the original GUI extension SDK in
`packages/gui-extensions/src/openagi`. Small adaptations register that extension,
open its real backend sessions in native tabs, select the OpenAGI application
identity and private profile, apply proxy settings, and bind project-specific
execution backends. These additions do not replace the original client with
a separately drawn interface.

The original OpenCode license is preserved verbatim in
`vendor/opencode/LICENSE` and distributed as `OPENCODE_LICENSE` alongside this
notice in the application's Resources directory. The client retains its original
About / Notices interface and bundled font and engine notices. Other dependencies,
fonts, Electron and Chromium retain their respective licenses; the MIT text below
applies to the OpenCode source, not to every bundled third-party dependency.

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
