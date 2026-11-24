# Third-party material in this repository

The server has no runtime dependencies. What is copied into the repository (not installed) is listed here.

## Icons (public/icons.js)

The shapes of the icons are from **Lucide** (https://lucide.dev), taken from the `lucide-static` package, version 0.468.0,
and drawn with `createElementNS` so there is no markup string and no external file. Lucide is licensed under the ISC
licence; portions come from Feather (MIT), which is covered by the same notice. The package is not a dependency: only the
path data of the 21 icons in use was copied. The licence text:

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Fonts

None. The interface uses the system font stack (see docs/DESIGN.md, "Type"), so no font file is served or licensed.
