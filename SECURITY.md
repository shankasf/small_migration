# Security policy

This application is restricted to migration metadata and synthetic examples. It is not approved for PHI. Never submit customer records, patient narratives, credentials or production extracts as test data. See [security implementation and outstanding evidence](docs/SECURITY_HARDENING.md).

Report suspected vulnerabilities privately to the repository security advisory channel (GitHub → Security → Report a vulnerability). If that channel is unavailable, contact the system owner through the organisation's existing incident channel; do not publish exploit details or sensitive records in a public issue. A named incident owner and monitored reporting contact must be assigned before a regulated release.

The proposed operating deadlines are: actively exploited or critical exposure — contain immediately and remediate within 24 hours; high — 7 days; medium — 30 days; low — 90 days. The accountable service owner must adopt these deadlines and maintain triage records. Every exception requires a named risk owner, compensating controls, an expiry date and a retest; do not lower scanner thresholds or silently ignore unfixed findings.

CI scans dependencies, secrets, source and images, with daily dependency/source rescans and weekly Dependabot updates. CI success is evidence of those automated checks, not an independent penetration test or compliance certification. An independent tester must cover the cases in `docs/SECURITY_HARDENING.md` before PHI use is reconsidered.
