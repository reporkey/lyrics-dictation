# Security policy

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting feature for this repository when enabled, or contact the repository owner privately through their GitHub profile. Include affected version/commit, impact, minimal reproduction, and suggested mitigation. Never send real identity cookies or private lyrics; use synthetic data and redact request logs.

No response-time or bounty commitment is made. Please allow maintainers to investigate before public disclosure.

## Supported version

Only the current default branch is maintained before the first release. No production deployment is asserted by this repository.

## Security design notes

The browser's HttpOnly anonymous cookie is the sole bearer credential. Anyone who obtains it can access that anonymous library, and clearing it makes recovery impossible. The app stores only its SHA-256 hash, validates same-origin mutations, scopes every query by the resolved identity, uses optimistic versions and idempotency where record creation/counting could duplicate, and marks private responses `no-store`.

See [the threat model](docs/threat-model.md) for assumptions and known limitations.
