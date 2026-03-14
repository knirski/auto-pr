# Security Policy

## Supported Versions

Security updates are provided for the latest major version.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

**Node.js:** We support Node.js 24+ (see `engines` in `package.json`).

## Reporting a Vulnerability

**Do not report security vulnerabilities through public issues or PRs.**

Report privately:

1. **GitHub Private Vulnerability Reporting** — [Open a private security advisory](https://github.com/knirski/auto-pr/security/advisories/new).
2. **Alternative** — Open an issue with the `security` label. Do not include sensitive details; request private contact.

Include: type of issue, affected paths, steps to reproduce, impact.

## Security Considerations

- **GitHub App token** — Used only for PR create/edit. Stored in `GH_TOKEN` env; never logged. Use a dedicated GitHub App with minimal permissions (Contents, Pull requests: Read and write).
- **Secrets** — `APP_PRIVATE_KEY` must be stored as a repository secret. Never commit it.
- **No telemetry** — auto-pr does not send data outside the workflow.

**Maintainers:** Keep secret scanning and push protection enabled in repository Settings.
