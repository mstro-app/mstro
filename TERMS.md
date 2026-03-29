# Mstro Terms of Service

**Effective Date:** March 2026

---

## 1. Acceptance of Terms

By installing, accessing, or using Mstro -- including the CLI tool, the web application at mstro.app, the relay platform, or any associated service (collectively, "the Service") -- you agree to be bound by these Terms of Service ("Terms"). If you do not agree, do not use the Service.

These Terms form a binding agreement between you and Mstro, Inc. ("Mstro," "we," "us," or "our"). If you are using the Service on behalf of an organization, you represent that you have authority to bind that organization to these Terms.

---

## 2. Description of Service

Mstro is a remote workspace platform that lets you run AI-assisted development workflows from any browser, executing locally on your machine. The Service consists of three connected components:

- **CLI** -- Installed on your local machine. Runs Claude Code, manages local file operations, git workflows, terminal sessions, and connects to the relay platform.
- **Platform Server (Relay)** -- A cloud server hosted on Fly.io that acts as a secure WebSocket relay between your browser and your local CLI. Mstro does not store your code or execute commands on this server; it relays messages between your browser and your machine.
- **Web Application** -- A browser interface at mstro.app that provides Plan View (multi-step AI execution), Chat View, Quality View (codebase quality checks), File Explorer, Git integration, Terminal, session sharing, and additional features as they are released.

The Service also includes the Security Bouncer, a 2-layer tool approval system that evaluates AI-generated tool calls before they execute on your machine.

Upcoming features include App View, which enables deployment of user applications to mstro.app subdomains with payments processed via Coinbase Smart Wallet. App View terms in Sections 13 and 14 apply when that feature is available to your account.

---

## 3. Eligibility and Age Requirements

### 3.1 General Use

You must be at least **13 years old** to create an account and use the non-payment features of the Service. By using the Service, you represent that you meet this minimum age requirement.

### 3.2 Payment Features

To use any payment feature of the Service -- including subscriptions, App View deployment, or Coinbase Smart Wallet micropayments -- you must be at least **18 years old** (or the age of majority in your jurisdiction, if higher). You represent that you meet this requirement before enabling any payment feature.

### 3.3 COPPA

The Service is not directed to children under 13. If we become aware that a child under 13 has provided personal information, we will delete it promptly. If you believe a child under 13 has created an account, contact us at legal@mstro.app.

---

## 4. Account Registration

To use certain features of the Service, you must create an account at mstro.app. You agree to:

- Provide accurate and complete registration information
- Keep your account information current
- Maintain the security of your account credentials and any device authentication tokens
- Accept responsibility for all activities that occur under your account
- Notify us immediately at legal@mstro.app of any unauthorized access or security breach

You may not create accounts using automated means or under false pretenses.

---

## 5. Acceptable Use

### 5.1 Permitted Use

You may use the Service for lawful software development, automation, and related technical work, subject to these Terms.

### 5.2 Prohibited Use

You agree not to use the Service to:

- Violate any applicable law, regulation, or third-party rights
- Infringe the intellectual property rights of any person or entity
- Transmit malware, viruses, or other malicious code
- Attempt to gain unauthorized access to any system, network, or data
- Interfere with or disrupt the integrity or performance of the Service
- Circumvent or attempt to disable the Security Bouncer or any safety mechanism
- Use the Service to generate, distribute, or deploy content that is illegal, abusive, or harmful
- Scrape, reverse-engineer, or extract Mstro's proprietary systems or platform infrastructure
- Resell or sublicense access to the relay platform without authorization
- Use the Service in any way that violates Anthropic's usage policies, which govern your use of Claude through the Service

### 5.3 Security Bouncer

The Security Bouncer evaluates AI-generated tool calls before they execute on your machine. You agree not to disable, circumvent, or attempt to bypass the Security Bouncer. Mstro is not liable for harm resulting from circumvention of this system.

---

## 6. AI-Generated Code Disclaimer

**This section is important. Please read it carefully.**

The Service enables Claude (an AI model developed by Anthropic) to write, edit, and execute code and commands directly on your local machine. You acknowledge and agree that:

- **AI outputs are not guaranteed to be correct, safe, or fit for any purpose.** AI-generated code may contain bugs, security vulnerabilities, unintended side effects, or errors.
- **You are solely responsible for reviewing all AI-generated code** before deploying it to any production environment, sharing it with others, or using it in any context where failures could cause harm.
- **Mstro does not review, audit, or warrant AI-generated outputs.** We provide the platform and tooling; the AI model is operated by Anthropic under a separate agreement.
- **Execution is local.** Commands and code run on your machine, under your user account, with your filesystem permissions. You are responsible for the consequences of execution.
- **You bear full responsibility** for any AI-generated code that you deploy, distribute, publish, or integrate into products or services, including code deployed via App View.

Mstro strongly recommends that you:

- Review all AI-generated code before committing or deploying
- Use version control to track changes
- Test in isolated environments before production deployment
- Maintain backups of important data

---

## 7. User-Generated Content

### 7.1 Your Content

"User Content" means any code, files, prompts, data, or other material you transmit through the Service. You retain ownership of your User Content. By using the Service, you grant Mstro a limited, non-exclusive, royalty-free license to process and relay your User Content solely as necessary to operate and provide the Service.

### 7.2 Content Standards

You represent that your User Content does not violate any law or third-party right, and that you have all rights necessary to submit it. You are solely responsible for the accuracy, legality, and appropriateness of your User Content.

### 7.3 No Endorsement

Mstro does not review User Content transmitted through the relay and does not endorse any User Content. We reserve the right to remove or disable access to content that violates these Terms.

### 7.4 Data Handling

The relay platform is designed to pass messages between your browser and your CLI without persistent storage of your code or commands. See our Privacy Policy at https://mstro.app/privacy for details on what data we do collect and retain.

---

## 8. Telemetry and Data Collection

Mstro collects anonymous telemetry data to improve the Service. This includes:

- Error reports and crash data
- Anonymous usage statistics
- System information (OS, architecture, version)

**You can opt out of telemetry at any time by running:**

```
mstro config telemetry off
```

See our Privacy Policy at https://mstro.app/privacy for details on data handling, retention, and your rights.

---

## 9. Intellectual Property

### 9.1 CLI (Open Source)

The Mstro CLI tool is licensed under the Apache License, Version 2.0. You may use, modify, and distribute the CLI in accordance with the terms of that license. A copy of the Apache 2.0 license is included in the repository.

### 9.2 Platform and Security Bouncer (Proprietary)

The Mstro relay platform (server infrastructure, relay logic, session management) and the Security Bouncer (pattern matching rules, AI integration, audit system) are proprietary and are **not** open-source. All rights in these components are reserved by Mstro, Inc. You receive no license to copy, modify, reverse-engineer, or redistribute these components.

### 9.3 Your Content

You retain full ownership of all code, files, and other content you create using the Service. Mstro claims no ownership over your work product.

### 9.4 Trademarks

"Mstro," the Mstro logo, and related marks are trademarks of Mstro, Inc. Nothing in these Terms grants you any right to use Mstro's trademarks without prior written permission.

---

## 10. Third-Party Services

### 10.1 Anthropic / Claude

The Service integrates with Anthropic's Claude AI models. Your use of Claude through the Service is subject to Anthropic's Terms of Service and Usage Policies (https://www.anthropic.com/legal). Mstro is not responsible for Claude's outputs, availability, accuracy, or changes to Anthropic's policies.

### 10.2 Clerk (Authentication)

Account authentication is handled by Clerk. By creating an account, you also agree to Clerk's terms as they apply to the authentication service.

### 10.3 Other Integrations

The Service may integrate with additional third-party services (e.g., GitHub, code hosting providers). Your use of those services is governed by their respective terms. Mstro is not responsible for third-party service availability, security, or policies.

---

## 11. Payment Terms

### 11.1 Subscriptions

Certain features of the Service require a paid subscription. Subscription fees, billing cycles, and included features are described at https://mstro.app/pricing. By subscribing, you authorize Mstro to charge your payment method on a recurring basis until you cancel. Cancellation takes effect at the end of the current billing period.

### 11.2 Refunds

Subscription fees are generally non-refundable except where required by applicable law or as explicitly stated at the time of purchase.

### 11.3 Price Changes

We may change subscription pricing with at least 30 days' notice. Continued use of the Service after a price change takes effect constitutes acceptance of the new pricing.

### 11.4 Taxes

You are responsible for any applicable taxes on your purchases. Mstro will collect taxes where required by law.

---

## 12. Digital Assets and Micropayments (App View)

*This section applies when App View and Coinbase Smart Wallet integration are available on your account.*

### 12.1 Coinbase Smart Wallet Integration

App View enables micropayments processed via Coinbase Smart Wallet. By using this feature, you also agree to Coinbase's applicable terms of service and any relevant wallet or network terms.

### 12.2 Cryptocurrency Risks

Transactions on blockchain networks are irreversible. Mstro is not responsible for:

- Lost, stolen, or inaccessible wallet credentials
- Failed or delayed transactions due to network conditions
- Fluctuations in the value of any digital asset
- Actions or omissions of wallet providers or blockchain networks

### 12.3 Your Responsibility

You are solely responsible for the security of your wallet credentials and for all transactions initiated through your account. Mstro does not have custody of your digital assets and cannot reverse transactions.

### 12.4 Regulatory Compliance

You are responsible for complying with all laws applicable to your use of digital assets and cryptocurrency in your jurisdiction. You must be at least 18 years old to use any payment or digital asset feature (see Section 3.2).

---

## 13. App View -- Third-Party App Deployment

*This section applies when App View is available on your account.*

### 13.1 Deployed Applications

App View allows you to deploy applications to mstro.app subdomains. You are solely responsible for the content, functionality, security, and legality of any application you deploy. Mstro provides hosting infrastructure; we do not review or take responsibility for deployed application behavior.

### 13.2 Content Requirements

Applications deployed via App View must comply with these Terms, including the Acceptable Use policy in Section 5. You may not deploy applications that:

- Distribute malware or engage in phishing
- Violate the intellectual property rights of others
- Facilitate illegal activity
- Collect personal data without proper disclosures and consent mechanisms
- Violate any applicable law or regulation

### 13.3 Takedowns

We reserve the right to suspend or remove any deployed application that we determine, in our sole discretion, violates these Terms, poses a security risk, or is subject to a valid DMCA notice (see Section 14).

### 13.4 Service Continuity

App View is provided on a best-efforts basis. We do not guarantee uptime for deployed applications and may modify or discontinue App View with reasonable notice.

---

## 14. DMCA and Copyright Policy

Mstro respects intellectual property rights and complies with the Digital Millennium Copyright Act (DMCA), 17 U.S.C. Section 512.

### 14.1 Designated Agent

Our designated DMCA agent for receiving notices of claimed infringement is:

**DMCA Agent**
Mstro, Inc.
Email: legal@mstro.app

### 14.2 Filing a Takedown Notice

If you believe content accessible through the Service infringes your copyright, send a written notice to legal@mstro.app that includes:

1. Your physical or electronic signature
2. Identification of the copyrighted work(s) claimed to be infringed
3. Identification of the infringing material and information sufficient to locate it
4. Your contact information (name, address, phone, email)
5. A statement that you have a good-faith belief that the use is not authorized by the copyright owner, its agent, or the law
6. A statement, under penalty of perjury, that the information in the notice is accurate and that you are authorized to act on behalf of the copyright owner

### 14.3 Counter-Notice

If you believe content was removed in error, you may send a counter-notice to legal@mstro.app with the information required by 17 U.S.C. Section 512(g)(3).

### 14.4 Repeat Infringers

We will terminate accounts of users who are determined to be repeat infringers in appropriate circumstances.

---

## 15. Indemnification

You agree to indemnify, defend, and hold harmless Mstro, Inc. and its officers, directors, employees, contractors, and agents from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or relating to:

- Your use of the Service
- Your User Content
- Any application you deploy via App View
- Your violation of these Terms
- Your violation of any third-party right, including intellectual property or privacy rights
- Your violation of any applicable law or regulation
- Any AI-generated code or content you deploy or distribute

This indemnification obligation survives termination of your account and these Terms.

---

## 16. Disclaimer of Warranties

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND. TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, MSTRO, INC. EXPRESSLY DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO:

- WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT
- WARRANTIES THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE
- WARRANTIES REGARDING THE ACCURACY, RELIABILITY, OR COMPLETENESS OF ANY AI-GENERATED OUTPUT
- WARRANTIES THAT DEFECTS WILL BE CORRECTED
- WARRANTIES REGARDING THIRD-PARTY SERVICES, INCLUDING ANTHROPIC'S CLAUDE

YOU ASSUME ALL RISK ASSOCIATED WITH YOUR USE OF THE SERVICE, INCLUDING RISKS ASSOCIATED WITH AI-GENERATED CODE EXECUTING ON YOUR LOCAL MACHINE.

---

## 17. Limitation of Liability

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW:

**17.1** IN NO EVENT SHALL MSTRO, INC. BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, LOSS OF DATA, LOSS OF GOODWILL, SERVICE INTERRUPTION, COMPUTER DAMAGE, OR THE COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR IN CONNECTION WITH THESE TERMS OR YOUR USE OF THE SERVICE, EVEN IF MSTRO HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

**17.2** MSTRO'S TOTAL CUMULATIVE LIABILITY TO YOU FOR ANY CLAIMS ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF: (A) THE AMOUNT YOU PAID TO MSTRO IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS ($100).

**17.3** THESE LIMITATIONS APPLY REGARDLESS OF THE LEGAL THEORY ON WHICH THE CLAIM IS BASED. SOME JURISDICTIONS DO NOT ALLOW CERTAIN LIMITATIONS OF LIABILITY; IN SUCH JURISDICTIONS, MSTRO'S LIABILITY IS LIMITED TO THE MINIMUM EXTENT PERMITTED BY LAW.

---

## 18. Dispute Resolution and Arbitration

### 18.1 Informal Resolution First

Before initiating formal proceedings, you agree to contact us at legal@mstro.app and give us 30 days to attempt to resolve the dispute informally.

### 18.2 Binding Arbitration

If informal resolution fails, **you and Mstro agree that any dispute, claim, or controversy arising out of or relating to these Terms or the Service shall be resolved by binding individual arbitration**, rather than in court, except as set forth in Section 18.5 below. This applies to all claims regardless of legal theory.

Arbitration shall be administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules (for individual users) or Commercial Arbitration Rules (for business users), which are available at www.adr.org. The arbitration will be conducted in the English language. The arbitrator's decision shall be final and binding and may be entered as a judgment in any court of competent jurisdiction.

### 18.3 Class Action Waiver

**YOU AND MSTRO EACH WAIVE THE RIGHT TO PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION.** All claims must be brought on an individual basis only. The arbitrator may not consolidate more than one person's claims without both parties' consent.

### 18.4 Arbitration Fees

For individual users, Mstro will pay AAA filing fees for claims under $75,000, except that you will pay your share of fees if the arbitrator finds your claim frivolous.

### 18.5 Exceptions

Either party may bring an individual claim in small claims court. Either party may seek emergency injunctive or other equitable relief in a court of competent jurisdiction to protect intellectual property rights or prevent irreparable harm, pending arbitration.

### 18.6 Opt-Out

You may opt out of arbitration by sending written notice to legal@mstro.app within 30 days of first accepting these Terms. Your notice must include your name, account email, and a clear statement that you are opting out of arbitration. If you opt out, disputes will be resolved in the courts specified in Section 19.

---

## 19. Governing Law and Jurisdiction

These Terms are governed by the laws of the State of Delaware, United States, without regard to conflict of law principles. For any disputes not subject to arbitration, you consent to the exclusive jurisdiction of the state and federal courts located in Delaware.

---

## 20. Modifications to Terms

We may update these Terms from time to time. We will notify you of material changes by:

- Posting a notice in the Mstro CLI or web application
- Updating the "Effective Date" at the top of this document
- Sending an email notification (for significant changes) when we have your email address

Your continued use of the Service after the effective date of updated Terms constitutes acceptance of the changes. If you do not agree to updated Terms, you must stop using the Service.

---

## 21. Termination

### 21.1 By You

You may stop using the Service at any time. To delete your account, visit https://mstro.app/settings or contact legal@mstro.app.

### 21.2 By Mstro

We reserve the right to suspend or terminate your access to the Service at any time if we determine, in our sole discretion, that you have violated these Terms, engaged in fraudulent or harmful activity, or for any other reason with reasonable notice where practicable. We may immediately suspend access without notice when necessary to protect the security of the Service or other users.

### 21.3 Effect of Termination

Upon termination, your right to use the Service ends. Sections 6, 7, 9, 15, 16, 17, 18, 19, and any other provisions that by their nature should survive, will survive termination.

---

## 22. General Provisions

### 22.1 Entire Agreement

These Terms, together with our Privacy Policy and any additional terms applicable to specific features, constitute the entire agreement between you and Mstro concerning the Service.

### 22.2 Severability

If any provision of these Terms is found to be unenforceable, the remaining provisions will remain in full force and effect.

### 22.3 Waiver

Our failure to enforce any provision of these Terms is not a waiver of our right to enforce it in the future.

### 22.4 Assignment

You may not assign or transfer your rights under these Terms without our prior written consent. Mstro may assign these Terms in connection with a merger, acquisition, or sale of assets.

### 22.5 Force Majeure

Mstro is not liable for any failure or delay in performance caused by circumstances beyond our reasonable control, including natural disasters, government actions, third-party service failures, or internet disruptions.

### 22.6 No Agency

Nothing in these Terms creates a partnership, joint venture, employment, or agency relationship between you and Mstro.

---

## 23. Contact

For questions about these Terms, to report violations, or to reach our DMCA agent:

- **Email:** legal@mstro.app
- **Website:** https://mstro.app

---

Copyright (c) 2025-present Mstro, Inc. All rights reserved.
