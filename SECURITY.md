# Security Policy

## Overview

Security is an important part of **PromptVault**. We are committed to protecting our users, their accounts, and the integrity of the platform.

PromptVault is an open-source prompt discovery and management platform that includes user authentication, personalized prompt collections, administrative functionality, API services, and a browser extension.

We welcome responsible security research and encourage researchers, developers, and users to report potential vulnerabilities through coordinated disclosure.

This policy outlines how to report vulnerabilities, the systems covered, our disclosure expectations, and how security reports are handled.

## Supported Versions

Security fixes are prioritized for the latest actively maintained version of PromptVault.

| Version | Supported |
|---|---|
| Latest version (`main` branch) | Yes |
| Previous commits and outdated deployments | No |
| Legacy components (`legacy/`) | No |

Security patches may not be backported to older versions.

Users running self-hosted instances are responsible for keeping their deployments and dependencies updated.

## Reporting a Vulnerability

**Please do not disclose security vulnerabilities through public GitHub issues, pull requests, discussions, or social media before coordinated disclosure.**

If you believe you have discovered a vulnerability, please report it privately through:

**[GitHub Private Vulnerability Reporting](https://github.com/SadanandaPaul89/promptvault/security/advisories)**

Navigate to the repository's **Security → Advisories → Report a vulnerability** section.

*Note: Private vulnerability reporting must be enabled by the repository maintainer before this option becomes available.*

If private reporting is unavailable, contact the maintainer through their [GitHub profile](https://github.com/SadanandaPaul89) to request a secure communication channel. Do not include exploit details in public messages.

### Information to Include

To help us investigate efficiently, please provide:

1. **Summary:** A clear description of the vulnerability.
2. **Affected component:** The relevant endpoint, file, feature, or module.
3. **Vulnerability classification:** CWE identifier or vulnerability category, if known.
4. **Severity:** Estimated impact and severity, optionally including a CVSS score.
5. **Steps to reproduce:** Detailed, reproducible instructions.
6. **Proof of concept:** Minimal code, requests, screenshots, or logs demonstrating the issue.
7. **Security impact:** What an attacker could potentially access, modify, or compromise.
8. **Suggested remediation:** An optional recommendation for fixing the issue.

Please redact credentials, session tokens, personal information, and other sensitive data.

## Security Scope

We are particularly interested in vulnerabilities affecting the confidentiality, integrity, or availability of PromptVault.

### In Scope

- **Authentication and session management:** Authentication bypass, session hijacking, token validation flaws, and account takeover.
- **Authorization and access control:** IDOR, privilege escalation, unauthorized access to another user's data, and admin authorization bypass.
- **API security:** Injection vulnerabilities, broken access controls, insecure endpoints, and exploitable business logic.
- **Database security:** SQL injection, unauthorized modification, and exposure of sensitive records.
- **Browser extension security:** Unsafe content handling, extension privilege abuse, and security boundary violations.
- **Client-side security:** Cross-site scripting (XSS), exploitable content injection, and other vulnerabilities affecting users.
- **Administrative features:** Unauthorized prompt moderation, administrative actions, or access to restricted functionality.
- **Sensitive information exposure:** Disclosure of credentials, secrets, authentication tokens, or private user information.
- **Dependency vulnerabilities:** Exploitable third-party vulnerabilities with a demonstrable impact on PromptVault.
- **Security control bypasses:** Circumvention of meaningful security checks or restrictions with a demonstrable impact.

Other security issues may also be considered when they demonstrate a credible impact on the project.

### Out of Scope

The following are generally not considered eligible security vulnerabilities unless a meaningful security impact can be demonstrated:

- UI or visual bugs without security implications.
- Missing security headers without a practical exploit.
- Automated scanner findings without validation or demonstrated impact.
- Self-XSS that cannot affect another user or cross a security boundary.
- Social engineering, phishing, or physical attacks.
- Denial-of-service testing against production infrastructure.
- Brute-force attacks, credential stuffing, or high-volume automated requests.
- Vulnerabilities affecting unrelated third-party platforms or services.
- Issues requiring an already-compromised operating system or browser without an additional security boundary violation.
- Duplicate reports or vulnerabilities already publicly documented and acknowledged.
- Reports based solely on speculative security risks without reproducible evidence.

We may reassess an out-of-scope category if a report demonstrates a significant, previously unrecognized security impact.

## Responsible Security Research

We support ethical, good-faith security research.

Researchers are expected to follow these guidelines:

**Permitted activities**

- Review publicly available source code.
- Perform static or dependency analysis.
- Reproduce vulnerabilities in a locally deployed instance.
- Test using accounts, data, and infrastructure you own or have explicit permission to use.
- Develop minimal, non-destructive proofs of concept.
- Privately share technical findings with the maintainers.

**Prohibited activities**

- Access, extract, modify, or delete another user's information without authorization.
- Exfiltrate credentials, access tokens, session cookies, or sensitive data.
- Perform destructive exploitation or persistence.
- Disrupt production availability or degrade service performance.
- Conduct automated exploitation against production systems without explicit authorization.
- Attempt lateral movement into third-party infrastructure.
- Publicly release exploit code or vulnerability details before coordinated disclosure.
- Use discovered vulnerabilities for financial gain, unauthorized access, or malicious activity.

**Publicly accessible source code does not constitute authorization to test or exploit production infrastructure.**

If testing unexpectedly exposes sensitive information or affects another user, stop immediately and report the incident privately.

## Disclosure and Response Process

We aim to handle security reports transparently and responsibly.

| Stage | Target |
|---|---|
| Initial acknowledgement | Within 72 hours |
| Preliminary assessment | Within 7 calendar days |
| Severity classification | Following technical validation |
| Remediation | Prioritized according to severity and complexity |
| Coordinated disclosure | After remediation or an agreed disclosure date |

These are best-effort targets, not guaranteed service-level commitments.

### Severity Assessment

Confirmed vulnerabilities will be assessed using their technical impact, exploitability, affected components, and potential consequences.

Where appropriate, we may use **CVSS v4.0** and relevant **CWE classifications** to communicate severity.

Critical vulnerabilities affecting authentication, sensitive data, or administrative privileges will receive priority.

### Coordinated Disclosure

We request that researchers allow a reasonable remediation period before publicly disclosing vulnerability details.

Our preferred initial disclosure window is **90 days from acknowledgement**, subject to coordination between the researcher and the maintainers.

This period is not an indefinite restriction. Earlier or later disclosure may be appropriate depending on active exploitation, available mitigations, the severity of the issue, and remediation progress.

The disclosure process may include:

1. Private submission of the vulnerability.
2. Technical verification and impact assessment.
3. Development and testing of a security fix.
4. Release of the patch or mitigation.
5. Publication of a GitHub Security Advisory, where appropriate.
6. Public disclosure with researcher attribution, when requested.

We encourage researchers to coordinate publication dates and technical details with maintainers.

## Researcher Recognition

We appreciate the contributions of security researchers who help improve PromptVault.

For validated, responsibly disclosed vulnerabilities, researchers may receive:

- Attribution in a GitHub Security Advisory.
- Recognition in release notes or security acknowledgements.
- Credit for discovering and responsibly reporting the vulnerability.
- Coordination on CVE publication when appropriate and eligible.

Researchers may request anonymity.

**PromptVault does not currently operate a paid bug bounty program.** Monetary compensation should not be assumed.

## Safe Harbor

We support security research conducted in good faith and in accordance with this policy.

For research that remains within the authorized scope, avoids privacy violations and service disruption, and follows coordinated disclosure practices, the PromptVault maintainers do not intend to initiate legal action solely because of that research.

This statement applies only to systems and rights under our control. It does not authorize activity against third-party services, infrastructure, or accounts, and does not provide immunity from applicable laws.

Researchers remain responsible for ensuring their activities are lawful and properly authorized.

## Security Best Practices for Deployments

Users deploying PromptVault independently should follow these recommendations:

- Keep Node.js and project dependencies updated.
- Configure a strong, randomly generated `JWT_SECRET`.
- Never commit `.env` files, credentials, database tokens, or production secrets.
- Use HTTPS for production deployments.
- Protect database connection strings and Turso authentication tokens.
- Restrict administrative access using `ADMIN_EMAILS`.
- Apply appropriate access controls to databases and hosting infrastructure.
- Monitor authentication, authorization, and application errors.
- Regularly review dependencies for known vulnerabilities.
- Keep browser extensions updated and limit permissions to those required.
- Back up important application data securely.

Self-hosted deployments may have additional risks depending on their infrastructure and configuration.

## Policy Updates

This security policy may be updated as PromptVault evolves.

Changes to supported versions, reporting procedures, research scope, or disclosure practices will be reflected in this document.

For security-related matters, refer to the latest version of this policy in the repository.

---

**Maintainer:** [Sadananda Paul](https://github.com/SadanandaPaul89)  
**Project:** [PromptVault](https://github.com/SadanandaPaul89/promptvault)  
**Security Advisories:** [GitHub Security Advisories](https://github.com/SadanandaPaul89/promptvault/security/advisories)

*Security is a continuous process. Responsible disclosure helps make PromptVault safer for everyone.*
