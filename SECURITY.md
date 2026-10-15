# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:
[Security → Report a vulnerability](https://github.com/odoucet/cf-waitingroom/security/advisories/new).
Do not open a public issue, and do not include real cookies, secrets or customer data in the report.

You should receive an acknowledgement within 7 days. We will agree on a disclosure date with you once
a fix is available.

## Scope

In scope: the code of this repository (edge handler, coordinator, cookie format, admin API, waiting
page) and the example configurations. Out of scope: Cloudflare's platform itself, and deployments that
diverge from the documented configuration (for example, `BOT_HEADER` enabled without the Transform Rule).

See [docs/threat-model.md](docs/threat-model.md) for the threat model and the known residual risks.

## Supported versions

Only the latest released version receives security fixes.
