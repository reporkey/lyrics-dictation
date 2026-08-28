# Contributing

Thanks for helping improve Lyrics Dictation.

## Before opening a change

Use Node.js 22 or later and install with `npm ci`. Keep changes focused, add tests for observable behavior, and use only original or public-domain lyric fixtures. Do not add credentials, user data, build output, local D1 files, screenshots containing private lyrics, analytics, or external lyric providers.

Run:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:a11y
npm run build
npm run audit:runtime
```

Schema changes require a new ordered migration; never rewrite a migration that may have been applied remotely. UI changes must keep English and Simplified Chinese catalogs in parity and be checked at 360 px and desktop widths, in light and dark themes.

Security-sensitive changes should include negative tests for ownership, origins, versions, unsafe text, and cache policy as applicable. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in a public issue.

## Licensing

No open-source license has been selected yet. A contribution process for copyright grants has therefore not been established. Contact the repository owner before submitting substantial external contributions.
