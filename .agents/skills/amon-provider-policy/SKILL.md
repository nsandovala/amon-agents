---
name: amon-provider-policy
description: Check provider, endpoint, cost and mock-fallback constraints before model/API use or configuration changes; use when a new or billable provider is proposed.
metadata:
  version: "1.0.0"
---

# amon-provider-policy


1. Read `.agents/standards/policy.md` (ES-08–09) and current provider configuration
   without printing credentials. Reuse provider names from `src/llm/call-llm.ts`.
2. Record current/requested provider and endpoint, whether this activates billing,
   and the exact human authorization reference. Unknown cost or endpoint ownership blocks use.
   Local-looking names do not establish a free/local endpoint.
3. `providerGate` accepts trusted host authorization for the exact provider/endpoint pair;
   an unrelated or model-generated grant does not suffice. Switching or billing requires
   authorization even if a key already exists. It does not call providers or edit config.
4. Keep mock fallback explicitly simulated and isolated. Never silently switch provider
   after an error or present mock output as HTTP/browser/auth/emulator acceptance.
5. Report the proposed change and cost uncertainty if blocked. No new services/frameworks
   or external billable calls are part of installing these standards.
