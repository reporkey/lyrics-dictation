# Lyrics Dictation

Lyrics Dictation is a planned bilingual web app for studying and writing lyrics from memory. Users will import their own plain-text or LRC files, practice without audio, and keep their library and progress synchronized through an anonymous cookie identity.

The production implementation is intentionally not scaffolded yet. [`CODEX_PROMPT.md`](./CODEX_PROMPT.md) is the complete autonomous build specification, including product requirements, Cloudflare constraints, tests, security controls, and an independent adversarial-review loop.

## Confirmed product decisions

- Simplified Chinese and English interface
- Paste plain text/LRC or upload `.txt`/`.lrc` files only
- No audio playback and no third-party lyric provider
- Cloud synchronization without accounts, using a secure anonymous cookie identity
- Cloudflare deployment target
- Private during initial development, with a future open-source release planned

## License

No open-source license has been selected. Until one is added, all rights are reserved.
