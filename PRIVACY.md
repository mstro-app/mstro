# Mstro Privacy Policy

**Effective Date:** March 2026
**Last Updated:** March 2026

---

## 1. Introduction

Mstro, Inc. ("we", "us", "our", "Mstro") is committed to protecting your privacy and handling your personal data with transparency and care. This Privacy Policy explains how we collect, use, store, share, and protect your information when you use the Mstro platform, including the Mstro CLI, the mstro.app web application, and all related services (collectively, the "Service").

We are the **data controller** for personal data processed through the Service. Our registered place of business is in the United States.

**Privacy contact:** privacy@mstro.app
**Website:** https://mstro.app

If you have questions about how we handle your data, please contact us before using the Service.

---

## 2. Scope and Applicability

This policy applies to:

- Users who access mstro.app from any jurisdiction, including the European Union, United Kingdom, and European Economic Area (EEA)
- Users who install and run the Mstro CLI on their local machines
- Visitors to our website and GitHub repositories

This policy does not apply to third-party services, websites, or tools that you may access through or alongside Mstro.

---

## 3. Data We Collect and Lawful Basis

We only process personal data where we have a valid lawful basis under Article 6 of the GDPR (or equivalent applicable law). The lawful basis for each category of processing is identified below.

### 3.1 Account Information

**What we collect:**
- Email address
- Name (optional, if provided during registration)
- Clerk user ID (assigned by our authentication provider)
- Device identifiers and hashed device tokens (for the device code authentication flow)

**Lawful basis:** Performance of a contract (Article 6(1)(b) GDPR) -- this data is necessary to create and maintain your account and provide the Service.

**Storage:** Neon Postgres (platform database), managed by Fly.io infrastructure.

### 3.2 Session and Workspace Data

**What we collect:**
- Orchestra configurations (workspace relay settings)
- Session metadata (connection timestamps, session identifiers, tab state)
- WebSocket connection state (held temporarily in Redis for active sessions)

**What we do NOT store:** File contents and source code transmitted through the WebSocket relay pass through our platform servers in transit but are **not stored** on our servers. They exist only in your active session.

**Lawful basis:** Performance of a contract (Article 6(1)(b) GDPR) -- session data is necessary to provide real-time workspace relay functionality.

**Storage:** Neon Postgres (persistent session metadata), Redis (ephemeral active-session state, not persisted beyond the session lifecycle).

### 3.3 Anonymous Telemetry Data

By default, Mstro collects anonymous telemetry to improve the software. We process two categories of telemetry:

**Error Reporting (via Sentry):**
- Stack traces and error messages
- Mstro version and environment
- Operating system and architecture
- Node.js version

**Usage Analytics (via PostHog):**
- Feature usage patterns
- Session duration
- Command frequency

**What we DO NOT collect:**
- File contents or source code
- API keys or credentials
- Personal identifying information in error reports
- IP addresses (stripped before storage)

**Lawful basis:** Legitimate interests (Article 6(1)(f) GDPR) -- we have a legitimate interest in understanding how the software is used and identifying bugs in order to improve reliability and performance. This interest is not overridden by your rights because telemetry is anonymised before processing, you retain the ability to opt out at any time, and we collect the minimum data necessary.

**How to opt out:**

```bash
mstro telemetry off
# or
export MSTRO_TELEMETRY=0
```

When telemetry is disabled:
- No error reports are sent to Sentry
- No usage analytics are sent to PostHog
- Core functionality remains unchanged

### 3.4 Security Bouncer Audit Logs

The Mstro CLI includes a Security Bouncer component that evaluates and approves tool calls made by Claude Code running on your local machine. Audit records of these decisions are written to a local log file at:

```
~/.mstro/logs/bouncer-audit.jsonl
```

**Important:** These audit logs are stored **only on your local machine**. They are never transmitted to Mstro servers. However, because they may record the content of tool calls (for example, file paths, command arguments, or code snippets), they may incidentally contain personal data.

You are responsible for the security and retention of these local files. You may delete them at any time. We recommend reviewing this log periodically if you operate in a sensitive environment.

**Lawful basis:** Not applicable for platform purposes -- this data is not processed by Mstro, Inc. It is retained locally on your device and is outside our control.

### 3.5 Credentials

Authentication credentials (including device tokens and session keys) are stored locally on your machine at `~/.mstro/credentials.json` with restrictive file permissions (chmod 600). These credentials are not transmitted to or stored on Mstro's platform servers beyond what is necessary for active authentication verification.

**Lawful basis:** Performance of a contract (Article 6(1)(b) GDPR) -- credentials are necessary to authenticate your access to the Service.

### 3.6 Payment and Financial Data

For paid features of the Service, we collect and process payment information. This currently includes, and may in future include:

- Billing contact information (name, email, billing address)
- Payment method details (processed by Stripe; we do not store raw card numbers)
- Cryptocurrency wallet interactions (via Coinbase Smart Wallet integration, where applicable)
- Transaction history and subscription status

**Lawful basis:** Performance of a contract (Article 6(1)(b) GDPR) for billing and subscription management; Legal obligation (Article 6(1)(c) GDPR) for financial record-keeping and tax compliance.

**Note:** Payment processing is handled by third-party processors (Stripe, Coinbase). Their privacy policies govern the data they collect independently.

---

## 4. Cookies and Tracking Technologies

When you use mstro.app, we and our third-party service providers use cookies and similar tracking technologies.

### 4.1 Types of Cookies We Use

| Category | Purpose | Examples | Can be disabled? |
|---|---|---|---|
| Strictly necessary | Authentication, session management, security | Clerk session cookies | No -- required for the Service |
| Analytics | Understanding how users interact with the platform | PostHog analytics cookies | Yes -- via telemetry opt-out or browser settings |
| Error tracking | Capturing errors for debugging | Sentry session replay (if enabled) | Yes -- via telemetry opt-out |

### 4.2 Managing Cookies

You can control cookies through:

- **Browser settings:** Most browsers allow you to block or delete cookies. Blocking strictly necessary cookies will prevent the Service from functioning.
- **Telemetry opt-out:** Running `mstro telemetry off` or setting `MSTRO_TELEMETRY=0` disables analytics and error tracking cookies.
- **Do Not Track:** We respect browser-level Do Not Track signals for analytics processing.

We do not use cookies for advertising or cross-site tracking.

---

## 5. How We Use Your Information

We use personal data only for the purposes for which it was collected or for compatible purposes. Specifically:

- Provide, operate, and maintain the Mstro Service
- Authenticate your identity and manage your devices
- Process payments and manage subscriptions
- Identify and fix bugs and crashes
- Improve software performance and features
- Communicate service updates, security notices, and changes to this policy
- Ensure security, detect abuse, and protect against fraud
- Comply with applicable legal obligations

We do not use your personal data for automated decision-making or profiling that produces legal or similarly significant effects.

---

## 6. Data Sharing and Processors

We do not sell your personal information. We do not share personal data with third parties for their own marketing purposes.

We engage the following data processors, each bound by data processing agreements and appropriate contractual safeguards:

| Processor | Role | Data Processed | Location |
|---|---|---|---|
| **Clerk** | Authentication and identity management | Email, name, device identifiers, session tokens | United States |
| **Neon** | Managed Postgres database | Account data, session metadata, device records | United States |
| **Fly.io** | Platform server hosting and infrastructure | All server-side data in transit and at rest | United States (primary) |
| **Vercel** | Web frontend hosting (mstro.app) | Web request logs, static asset delivery | United States / Global CDN |
| **Sentry** | Error tracking and monitoring | Anonymised error reports, stack traces | United States |
| **PostHog** | Product analytics | Anonymised usage events | United States (EU hosting option available) |
| **Stripe** | Payment processing | Billing information, payment method data | United States |
| **Coinbase** | Cryptocurrency wallet integration | Wallet interaction data (where applicable) | United States |

We may also disclose personal data in the following circumstances:

- **Legal requirements:** Where required by applicable law, court order, or regulatory authority, including to comply with valid legal process.
- **Protection of rights:** Where necessary to protect the rights, property, or safety of Mstro, our users, or the public.
- **Business transfers:** In connection with a merger, acquisition, or sale of all or a portion of our assets, in which case we will provide notice before personal data is transferred and becomes subject to a different privacy policy.

---

## 7. International Data Transfers

Mstro, Inc. is based in the United States. If you are located in the European Union, United Kingdom, EEA, or other jurisdictions with data transfer restrictions, your personal data is transferred to and processed in the United States.

We ensure that such transfers are subject to appropriate safeguards as required by applicable law. Specifically:

- **Standard Contractual Clauses (SCCs):** We rely on the European Commission-approved Standard Contractual Clauses (including, where applicable, the UK International Data Transfer Addendum) as the transfer mechanism for personal data transferred from the EU/EEA/UK to the United States.
- **Processor agreements:** All third-party processors who receive personal data from EU/EEA/UK users are required to maintain SCCs or another valid transfer mechanism.

You may request a copy of the applicable transfer safeguards by contacting us at privacy@mstro.app.

---

## 8. Data Retention

We retain personal data only for as long as necessary for the purposes for which it was collected, or as required by law.

| Data Category | Retention Period |
|---|---|
| Account data (email, name, Clerk ID) | Retained while your account is active; deleted within 30 days of account deletion |
| Device records and hashed tokens | Deleted upon device deregistration or account deletion |
| Session metadata | Retained for up to 12 months from the session date |
| Redis session state | Ephemeral; purged at session end |
| Telemetry -- error reports (Sentry) | Up to 30 days |
| Telemetry -- usage analytics (PostHog) | Up to 90 days |
| Payment records | Retained for up to 7 years as required by applicable tax and financial regulations |
| Local audit logs (`bouncer-audit.jsonl`) | Stored only on your machine; not subject to our retention schedule |

When your account is deleted, we will delete or anonymise your personal data within 30 days, unless a longer retention period is required by law or legitimate business necessity (for example, for fraud investigation or to resolve outstanding disputes).

---

## 9. Your Rights Under GDPR and Applicable Law

If you are located in the European Union, United Kingdom, or EEA, you have the following rights with respect to your personal data:

| Right | Description |
|---|---|
| **Right of access** | Request a copy of the personal data we hold about you |
| **Right to rectification** | Request correction of inaccurate or incomplete personal data |
| **Right to erasure** | Request deletion of your personal data ("right to be forgotten"), subject to legal retention obligations |
| **Right to restriction** | Request that we restrict processing of your personal data in certain circumstances |
| **Right to data portability** | Receive your personal data in a structured, commonly used, machine-readable format |
| **Right to object** | Object to processing based on legitimate interests; object to direct marketing at any time |
| **Right to withdraw consent** | Where processing is based on consent, withdraw it at any time without affecting prior processing |
| **Right not to be subject to automated decisions** | Not be subject to solely automated decisions that produce legal or similarly significant effects |

**Response timeframe:** We will respond to all valid data subject requests within **30 days** of receipt. Where requests are complex or numerous, we may extend this period by a further two months, in which case we will notify you within the initial 30-day period.

**How to exercise your rights:** Submit a request by email to privacy@mstro.app. We may need to verify your identity before processing your request.

**Residents of other jurisdictions:** If you are a California resident, you may have additional rights under the CCPA/CPRA, including the right to know, delete, correct, and opt out of sale (we do not sell data). Contact us at privacy@mstro.app for jurisdiction-specific requests.

---

## 10. Right to Lodge a Complaint

If you believe we have not handled your personal data in accordance with applicable law, you have the right to lodge a complaint with a supervisory authority.

- **EU:** Contact the data protection authority in your EU member state. A list of EU supervisory authorities is available at: https://edpb.europa.eu/about-edpb/about-edpb/members_en
- **UK:** Contact the Information Commissioner's Office (ICO) at https://ico.org.uk

We ask that you contact us first at privacy@mstro.app so that we have the opportunity to address your concern before you escalate to a supervisory authority.

---

## 11. Data Protection Officer

At Mstro's current scale and given the nature of our processing activities, we are not required to appoint a Data Protection Officer (DPO) under Article 37 of the GDPR. We nonetheless take privacy obligations seriously and have designated a privacy contact to handle data protection matters.

**Privacy contact:** privacy@mstro.app

If our processing activities change in a way that triggers the DPO requirement, we will appoint a DPO and update this policy accordingly.

---

## 12. Data Security

We implement appropriate technical and organisational measures to protect your personal data against unauthorised access, accidental loss, destruction, or disclosure:

- Encryption in transit using TLS/HTTPS for all platform communications
- Secure local credential storage with restrictive file permissions (chmod 600)
- Hashed device tokens (SHA-256) -- plaintext tokens are never stored
- Neon Postgres encryption at rest
- Regular security reviews of platform infrastructure
- Minimal data collection -- we do not collect what we do not need
- Access controls limiting personnel access to personal data on a need-to-know basis

No method of electronic transmission or storage is 100% secure. We cannot guarantee absolute security, but we are committed to maintaining industry-standard protections.

---

## 13. Data Breach Notification

In the event of a personal data breach that is likely to result in a risk to the rights and freedoms of individuals, we will:

- Notify the relevant supervisory authority **within 72 hours** of becoming aware of the breach, as required by Article 33 of the GDPR
- Notify affected individuals **without undue delay** where the breach is likely to result in a high risk to their rights and freedoms, as required by Article 34 of the GDPR
- Document all data breaches in our internal breach register, regardless of whether notification is required

Breach notifications to affected users will be sent to the email address associated with your account. We recommend keeping your account email address current.

---

## 14. Children's Privacy

**General use:** The Service is not directed to children under the age of **13**. We do not knowingly collect personal data from children under 13. If you believe a child under 13 has provided us with personal data, please contact us at privacy@mstro.app and we will promptly delete that information.

**Payment features:** Access to paid features and any functionality involving financial transactions requires users to be at least **18 years of age** (or the age of majority in their jurisdiction, if higher). We do not knowingly permit minors to engage in payment-related activities on the platform.

If you are a parent or guardian and believe your child has used or registered for the Service in violation of this policy, please contact us.

---

## 15. Open Source

The Mstro CLI is open source software, licensed under the **Apache License, Version 2.0**. The source code is available at https://github.com/mstro-app/mstro.

Your use of the open source CLI code is governed by the Apache 2.0 License terms. This Privacy Policy applies to your use of the hosted Service (mstro.app platform, relay server) and any personal data processed in connection with your Mstro account, regardless of whether you use the open source CLI or another client.

---

## 16. Changes to This Policy

We may update this Privacy Policy from time to time to reflect changes in our practices, technology, legal requirements, or other factors.

When we make material changes, we will:

- Update the "Last Updated" date at the top of this policy
- Notify registered users by email at least **14 days** before the changes take effect (for material changes affecting your rights)
- Display a notice on mstro.app

Your continued use of the Service after the effective date of a revised policy constitutes your acknowledgment of the changes. If you do not agree to the revised policy, you should discontinue use of the Service and may request deletion of your account.

---

## 17. Contact Us

For privacy-related questions, data subject requests, or concerns about this policy:

**Email:** privacy@mstro.app
**Website:** https://mstro.app
**GitHub Issues:** https://github.com/mstro-app/mstro/issues

**Mstro, Inc.**
United States

For formal data subject requests under GDPR or applicable law, please include "Privacy Request" in the subject line of your email.

---

*Copyright (c) 2025-present Mstro, Inc. All rights reserved.*
