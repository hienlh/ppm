# Third-party notices

PPM itself is licensed under the Elastic License 2.0 (see `LICENSE`). It also
redistributes the components below, each under its own terms, which continue to
apply to those components.

Every section here is emitted by the generator that vendors the component —
edit that generator, not this file. Re-run:

```
bun scripts/gen-product-icons.ts
bun scripts/gen-file-icons.ts
bun scripts/gen-nerd-font.ts
```

<!-- BEGIN product-icons -->

## Product icons

`src/web/lib/icons.generated.tsx` holds the path data for 175 glyphs, emitted by
`scripts/gen-product-icons.ts` at 20px Regular. The outlines are reproduced unchanged;
only the surrounding component is PPM's. The 15 names Fluent has no glyph for stay on
`lucide-react`, which is a dependency rather than something vendored here.

| Component | Upstream | Version | Licence | Copyright |
| --- | --- | --- | --- | --- |
| Fluent UI System Icons | [github.com/microsoft/fluentui-system-icons](https://github.com/microsoft/fluentui-system-icons) | 1.1.338 | [MIT](licenses/MIT.txt) | © Microsoft Corporation |

- **Fluent UI System Icons** — vendored through `@iconify-json/fluent`.

<!-- END product-icons -->

<!-- BEGIN file-icons -->

## File icons

`src/web/styles/file-icons.generated.css` inlines 224 SVG drawings as data URIs and
`src/web/lib/file-icons.generated.ts` holds the name-to-glyph tables. Both are emitted by
`scripts/gen-file-icons.ts` from the packages below: the artwork comes from the icon
collection, the extension-to-name mapping from `vscode-icons-js`. The drawings are
reproduced unchanged apart from being minified into a URI.

| Component | Upstream | Version | Licence | Copyright |
| --- | --- | --- | --- | --- |
| vscode-icons (artwork) | [github.com/vscode-icons/vscode-icons](https://github.com/vscode-icons/vscode-icons) | 12.19.0 | [MIT](licenses/MIT.txt) | © Roberto Huertas |
| vscode-icons-js (name mapping) | [github.com/dderevjanik/vscode-icons-js](https://github.com/dderevjanik/vscode-icons-js) | 11.6.1 | [MIT](licenses/MIT.txt) | © Daniel Derevjanik |

- **vscode-icons (artwork)** — vendored through `@iconify-json/vscode-icons`.

<!-- END file-icons -->

<!-- BEGIN nerd-font -->

## Terminal icon glyphs

`src/web/styles/fonts/nerd-symbols-*.woff2` (14 files) are subsets of the
symbols-only face from [Nerd Fonts v3.5.1](https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.5.1/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf), cut per icon set by
`scripts/gen-nerd-font.ts`. Nerd Fonts assembles them from the projects below; the
subsetting reproduces their outlines unchanged.

The `@font-face` family is `PPM Nerd Symbols`, not any upstream family name. That is there so
a local install of the real font is not shadowed, and it also satisfies the Reserved
Font Name clause the SIL OFL sets on Pomicons: no PPM face is offered under a
reserved name.

| Component | Upstream | Version | Licence | Copyright |
| --- | --- | --- | --- | --- |
| Codicons | [github.com/microsoft/vscode-codicons](https://github.com/microsoft/vscode-codicons) | 0.0.45 | [CC-BY-4.0](licenses/CC-BY-4.0.txt) | © Microsoft Corporation |
| Devicons | [github.com/devicons/devicon](https://github.com/devicons/devicon) | 2.17.0 | [MIT](licenses/MIT.txt) | © konpa |
| Font Awesome Free | [github.com/FortAwesome/Font-Awesome](https://github.com/FortAwesome/Font-Awesome) | 6.5.1 | [CC-BY-4.0](licenses/CC-BY-4.0.txt) (icons), [OFL-1.1](licenses/OFL-1.1.txt) (fonts) | © Fonticons, Inc. |
| Font Awesome Extension | [github.com/AndreLZGava/font-awesome-extension](https://github.com/AndreLZGava/font-awesome-extension) | 0.0.3 | [MIT](licenses/MIT.txt) | © André Luiz Gava |
| Font Logos | [github.com/Lukas-W/font-logos](https://github.com/Lukas-W/font-logos) | 1.3.0 | [Unlicense](licenses/Unlicense.txt) | © Lukas W |
| Unicode Power Symbols | [github.com/jloughry/Unicode](https://github.com/jloughry/Unicode) | Feb 2015 | [MIT](licenses/MIT.txt) | © Joe Loughry |
| Material Design Icons | [github.com/Templarian/MaterialDesign-Font](https://github.com/Templarian/MaterialDesign-Font) | Oct 6, 2022 | [Apache-2.0](licenses/Apache-2.0.txt) | © Pictogrammers |
| Nerd Fonts (patcher and its own Custom glyphs) | [github.com/ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts) | v3.5.1 | [MIT](licenses/MIT.txt) | © Ryan L McIntyre |
| Octicons | [github.com/primer/octicons](https://github.com/primer/octicons) | 18.3.0 | [MIT](licenses/MIT.txt) | © GitHub Inc. |
| Pomicons | [github.com/gabrielelana/pomicons](https://github.com/gabrielelana/pomicons) | 1.001 | [OFL-1.1](licenses/OFL-1.1.txt) | © Gabriele Lana |
| Powerline Symbols | [github.com/powerline/powerline](https://github.com/powerline/powerline) | 1.000 | [MIT](licenses/MIT.txt) | © Kim Silkebækken and other contributors |
| Powerline Extra Symbols | [github.com/ryanoasis/powerline-extra-symbols](https://github.com/ryanoasis/powerline-extra-symbols) | 1.200 | [MIT](licenses/MIT.txt) | © Ryan L McIntyre |
| Seti UI | [github.com/jesseweed/seti-ui](https://github.com/jesseweed/seti-ui) | 0.8.1 | [MIT](licenses/MIT.txt) | © Jesse Weed |
| Weather Icons | [github.com/erikflowers/weather-icons](https://github.com/erikflowers/weather-icons) | 2.0.10 | [OFL-1.1](licenses/OFL-1.1.txt) | © Erik Flowers, artwork by Lukas Bischoff |

<!-- END nerd-font -->
