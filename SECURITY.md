# Security policy

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting feature for this repository when enabled, or contact the repository owner privately through their GitHub profile. Include affected version/commit, impact, minimal reproduction, and suggested mitigation. Never send real identity cookies or private lyrics; use synthetic data and redact request logs.

No response-time or bounty commitment is made. Please allow maintainers to investigate before public disclosure.

## Supported version

Only the current default branch is maintained before the first release. The production service is available at [dictation.reporkey.com](https://dictation.reporkey.com).

## Security design notes

Each browser's HttpOnly anonymous cookie is a device bearer credential. Anyone who obtains it can access that device's current private or shared library. The app stores only its SHA-256 hash, validates same-origin mutations, derives data-space membership on the server, uses optimistic versions and idempotency where record creation/counting could duplicate, and marks private responses `no-store`.

Pairing codes are temporary bearer capabilities. They use cryptographically secure randomness, are stored only as SHA-256 hashes, expire after ten minutes, work once, and are invalidated by membership changes. Users should share them only with the intended device. Pairing does not provide account recovery: if every paired device credential is lost, the data is inaccessible.

Device descriptions are deliberately coarse. The Worker normalizes request metadata into a platform, browser family, major version, and device type, then discards the raw User-Agent and does not collect a device name or hardware identifier.

See [the threat model](docs/threat-model.md) for assumptions and known limitations.
