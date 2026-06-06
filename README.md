# Life OS

Life OS organizes diary entries, tasks, knowledge, memory, and AI-assisted reviews inside your Obsidian vault.

It is designed as a local-first personal operating system: you keep the markdown files, you choose the AI provider, and the plugin helps connect daily records, unfinished tasks, project progress, knowledge notes, and long-term memory.

## Features

- Diary and quick capture workflows for daily records.
- Task extraction, task carryover, and project-aware task views.
- Project overview cards with progress rings and unfinished task lists.
- Knowledge base workflows for source material, drafts, and reusable notes.
- Memory review workflows where AI suggestions wait for user confirmation.
- AI assistant that can use selected vault context, task context, project context, knowledge context, and explicit web context.
- Daily, weekly, monthly, and growth review dashboards.
- Multiple visual themes for light and dark Obsidian appearances.

## Payment is required for full access

Life OS includes free local-first features and Pro features. Pro activation is handled by the Life OS license service. The plugin stores license state locally in Obsidian plugin data and verifies server-issued entitlement tokens before unlocking Pro-only workflows.

The client-side source can be inspected, but paid access is not granted by local settings alone. A valid server-issued entitlement is required for normal Pro access.

## Account or license requirement

Some Pro workflows require a license key, email-based order lookup, trial code, or activation code. These checks contact the Life OS license service only when you use activation, order lookup, trial, redeem, or account-related Pro actions.

## Network use

Life OS can use remote services in these cases:

- AI requests are sent to the AI provider and endpoint configured by the user.
- License and payment status requests are sent to the Life OS license service.
- Web search or webpage reading runs only when the user explicitly asks Life OS to search the web or read a web URL.

Life OS does not include silent client-side telemetry.

## Privacy

Life OS is local-first. Vault content remains in your Obsidian vault unless you explicitly use an AI, web, or license feature that needs remote access.

When AI features are used, the selected context is sent to the AI provider configured by the user. When web features are used, the requested URL or search query is sent to the corresponding network service. When license features are used, license and account information needed for activation or order lookup is sent to the Life OS license service.

The plugin does not silently upload your vault.

## No built-in updater

The community edition is updated through Obsidian's official Community Plugins update flow. It does not ship a separate self-updater.

## Desktop-first community submission

The initial community-market submission is desktop-first. Mobile support is being treated as a separate validation track so that the community release does not overstate mobile readiness.

## Data model

Life OS stores user-facing content as markdown files inside the vault. Typical folders include diary entries, task lists, knowledge notes, memory candidates, reports, and review documents. The exact root folder can be configured in the plugin settings.

Plugin settings, model configuration, and license state are stored in Obsidian plugin data and should not be overwritten during upgrades.

## Installation for community review

1. Install the plugin from Obsidian Community Plugins after it is accepted.
2. Enable "Life OS" in Obsidian settings.
3. Open the Life OS view from the ribbon or command palette.
4. Configure your AI provider if you want to use AI workflows.
5. Activate Pro only if you need Pro-only workflows.

## Development

```powershell
npm install
npm run check
npm run build
```

Community readiness checks for this repository are run from the private source workspace:

```powershell
npm run export:community
npm run test:community-ready
```

## Release assets

Each Obsidian release should attach:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag should match `manifest.json.version`.

## Support

For issues, feature requests, and community-plugin review feedback, use the GitHub issue tracker for the public community repository.

## License

This project uses the PolyForm Noncommercial License 1.0.0. Personal and non-commercial use is allowed under that license. Commercial use, resale, SaaS wrapping, or company-internal commercial deployment requires prior written permission from the author.
