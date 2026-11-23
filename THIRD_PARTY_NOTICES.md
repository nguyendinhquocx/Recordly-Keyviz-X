# Third-party notices

Desktop installers include this document, Recordly's license, dependency notices,
and the cursor source/license files in the application's `resources/licenses`
directory (`Recordly.app/Contents/Resources/licenses` on macOS). Each component
retains its own license; Recordly terms do not replace third-party permissions.

## OpenScreen

Recordly began as a fork of [OpenScreen](https://github.com/siddharthvaddem/openscreen).
The original OpenScreen code is provided under the following MIT license:

> MIT License
>
> Copyright (c) 2025 Siddharth Vaddem
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Voom

Recordly Share includes code adapted from the Voom project:

- Project: [Voom](https://github.com/aritropaul/voom)
- Adapted component: `services/recordly-share/worker`
- License: MIT
- Copyright © 2026 Aritro Paul
- Upstream reference: `c1c0350ed610b0c9bc4a307fcc6a01aab0f926f9`

Recordly changes include product branding, desktop publishing integration,
authenticated commenting, local-development configuration, and viewer styling.

The Voom software is provided under the following license:

> MIT License
>
> Copyright (c) 2026 Aritro Paul
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Solar Icons

Solar Icon Set by 480 Design, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Source: https://github.com/480-Design/Solar-Icon-Set. Icons are rendered using the MIT-licensed `@solar-icons/react` package. The muted microphone adds a diagonal stroke.

## DM Sans

Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts).

DM Sans is licensed under the SIL Open Font License, Version 1.1. The unmodified regular and italic variable fonts are sourced from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/dmsans). The full license is included in [src/assets/fonts/dm-sans/OFL.txt](src/assets/fonts/dm-sans/OFL.txt).

## Keyviz

Recordly bundles a Keyviz sidecar executable on Windows:

- Project: [Keyviz](https://github.com/mulaRahul/keyviz)
- Upstream component: `keyviz/` (Tauri app source), built into `recordly-keyviz.exe`
- License: GNU General Public License v3.0
- Copyright © 2026 Rahul Mula
- Upstream license text: [keyviz/LICENSE](keyviz/LICENSE)

Recordly changes include CLI sidecar modes (`--mode=capture`, `--mode=settings`),
a stdio JSON control protocol, on-demand input listener startup with shortcut
suppression, a separate sidecar app identity, and Vietnamese settings UI.

The Keyviz software is provided under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. This program is distributed in
the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
the GNU General Public License for more details. A copy of the license is
available at <https://www.gnu.org/licenses/gpl-3.0.html> and shipped in
[keyviz/LICENSE](keyviz/LICENSE).

## rdev (MIT)

Keyviz's Windows input listener includes the vendored `rdev` crate at `keyviz/src-tauri/crates/rdev/`, based on [Narsil/rdev](https://github.com/Narsil/rdev).

Copyright (c) 2020 Nicolas Patry. Licensed under the MIT License. The full MIT license text is shipped in the Windows package at `resources/keyviz/rdev-LICENSE` and is available in the source tree at `keyviz/src-tauri/crates/rdev/LICENSE`.
