# Third Party Notices

Life OS Assistant includes references to public methodology and role-style AI
skill materials so users can choose conversational perspectives inside the AI
assistant. These materials are used as prompt context only. They are not
executable code, update channels, payment logic, or license-bypass mechanisms.

The original authors and rightsholders retain their rights in the referenced
materials. Source URLs are preserved in the plugin UI and source code when
available. If a rightsholder wants a bundled skill removed or replaced with a
link-only import flow, please open an issue in the public repository.

## Bundled AI Skill Sources

The built-in AI skill catalog was filtered from the public colleague-skill
gallery at:

- https://titanwings.github.io/colleague-skill-site/gallery/

Known source repositories or source files include:

- steve-jobs-skill: https://github.com/alchaincyf/steve-jobs-skill
- elon-musk-skill: https://github.com/alchaincyf/elon-musk-skill
- buffett-skill: https://github.com/will2025btc/buffett-perspective
- munger-skill: https://github.com/alchaincyf/munger-skill
- naval-skill: https://github.com/alchaincyf/naval-skill
- karpathy-skill: https://github.com/alchaincyf/karpathy-skill
- taleb-skill: https://github.com/alchaincyf/taleb-skill
- paul-graham-skill: https://github.com/alchaincyf/paul-graham-skill
- tim-cook-skill: https://github.com/heywanrong/tim-cook-skill
- rob-pike-skill: https://github.com/smallnest/rob-pike-skill
- feynman-skill: https://github.com/alchaincyf/feynman-skill
- confucius-skill: https://github.com/ceetity/confucius-skill
- zeng-guofan-skill: https://github.com/2559063619/zeng-guofan-perspective
- mises-perspective: https://github.com/LijiayuDeng/mises-perspective
- xinqingnian-skill: https://github.com/SamadhiFire/xinqingnian-skill
- batman-skill: https://github.com/BeamusWayne/Batman-skill
- flash-skill: https://github.com/BeamusWayne/TheFlash-skill
- superman-skill: https://github.com/BeamusWayne/Superman-skill
- sunday-skill: https://github.com/onism11/sunday
- firefly-skill: https://github.com/guilings/firefly.skill
- saul-goodman-skill: https://github.com/bankeluilian/Better-Call-Saul-Goodman-skill
- yuntianming-skill: https://github.com/lkysyzxz/yuntianming-skills
- teach-skill: https://github.com/mattpocock/skills/blob/main/skills/productivity/teach/SKILL.md

Some entries are link-only or have no public source URL in the filtered export.
Those entries are kept as lightweight prompt metadata when no source file is
available.

## Runtime Dependencies

Life OS Assistant bundles or depends on third-party runtime packages through
the npm dependency graph. Their license metadata is preserved in `package.json`
and `package-lock.json`. Key runtime packages include:

- Tesseract.js and OCR language data packages for local scanned PDF OCR.
- pdfjs-dist for PDF text extraction.
- fflate for DOCX archive reading.
- @ybouane/liquidglass for the Liquid Glass visual theme.

Manual delivery packages may include local OCR assets under
`personal-life-system/assets/ocr/`. Official community installs that only
download `manifest.json`, `main.js`, and `styles.css` may use the Tesseract.js
default CDN asset paths the first time scanned PDF OCR is used.
