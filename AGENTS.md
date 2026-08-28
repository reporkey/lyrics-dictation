# Repository instructions

## Python

- Run all Python work through `uv` in this project.
- Pin the project Python with `uv init` and `.python-version` if Python is introduced.
- Never use or modify the system or Homebrew Python, and never set a global `UV_PYTHON` or `~/.python-version`.

## File deletion

- On macOS, use `trash` instead of `rm`. If `trash` fails, stop and ask the repository owner.
- Inside Docker or a local VM, `rm` is allowed.

## Project quality

- Keep the project deployable to Cloudflare and suitable for a future public repository.
- Do not commit secrets, user lyric content, local databases, generated build output, or test artifacts.
- Use official current documentation when selecting Cloudflare APIs or deployment configuration.
- Commit one package-manager lockfile and keep documented setup and validation commands reproducible.
- Do not select or add an open-source license without the repository owner's approval.

## Git worktrees

- If a worktree is explicitly requested or required by another instruction, use the current agent's worktree tooling.
- In an isolated worktree, run Git commands from that worktree. Do not use `git -C` to target a parent or shared checkout.
