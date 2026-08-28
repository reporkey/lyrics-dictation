# Lyrics Dictation

Lyrics Dictation is a planned bilingual web app for studying and writing an entire song’s lyrics from memory. Users import their own plain-text or LRC files, select a song, and type freely in one large multiline editor. The app aligns the draft with the expected lyrics in real time: correct text turns green, wrong or extra text receives an amber highlight, and missing runs appear as non-answer-revealing amber insertion markers. The library, draft, and progress synchronize through an anonymous cookie identity, with no audio or login.

The production implementation is intentionally not scaffolded yet. [`CODEX_PROMPT.md`](./CODEX_PROMPT.md) is the complete autonomous build specification, including product requirements, Cloudflare constraints, tests, security controls, and an independent adversarial-review loop.

## Confirmed product decisions

- Simplified Chinese and English interface
- Paste plain text/LRC or upload `.txt`/`.lrc` files only
- Full-song free-form dictation with live character-level alignment and inline feedback
- No audio playback and no third-party lyric provider
- Cloud synchronization without accounts, using a secure anonymous cookie identity
- Cloudflare deployment target
- Private during initial development, with a future open-source release planned

## License

No open-source license has been selected. Until one is added, all rights are reserved.
