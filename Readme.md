# RegKit

**Compliance-native AI development.** RegKit catches EU AI Act, HIPAA, GDPR, and other AI compliance violations in your code — *before it ships*. 13 regulations across federal, European Union, and 7 US jurisdictions, each grounded in actual statutory text — including cases where the same code is legal in one US state and illegal in another.

Think spell-check, but for the law.

```javascript
async function analyzePatientRisk(patientId) {
  const record = await db.patients.findById(patientId);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: record.notes }]
  });
  // ^ RegKit: BLOCK — PHI sent to OpenAI without a signed BAA
  //   HIPAA § 164.502 — fines up to $1.9M per violation category

  return response.choices[0].message.content;
  // ^ RegKit: BLOCK — AI decision returned with no human oversight gate
  //   EU AI Act Art. 14 — human oversight required for high-risk AI
}
```

## Status: Working MVP ✅

RegKit is built and functional across three surfaces. **[Download the VS Code extension from the latest release →](https://github.com/rodgutie/regkit/releases/latest)**

**Built:**
- ✅ Tree-sitter AST rule engine
- ✅ 13 regulation rule sets (federal, EU, 7 US jurisdictions) — see [`rules/`](./rules)
- ✅ 7-agent pipeline: context classification → rule mapping → Claude-powered legal reasoning → remediation → compliance-document generation
- ✅ CLI scanner (`regkit scan`)
- ✅ GitHub Action PR gate (blocks non-compliant merges)
- ✅ VS Code extension (live inline detection) — [installable .vsix in Releases](https://github.com/rodgutie/regkit/releases/latest)

**Next:** VS Code Marketplace publish · expanded rule coverage

## Install the VS Code extension

1. Download `regkit-0.1.0.vsix` from the [latest release](https://github.com/rodgutie/regkit/releases/latest)
2. In VS Code: Extensions panel → "..." menu → **Install from VSIX...** → select the file
3. Open any `.js`/`.ts` file with an AI call and watch RegKit flag compliance issues inline, with the actual legal citation

## Why RegKit exists

Every AI compliance tool today either watches your AI *after* it ships (observability platforms) or manages paperwork manually (GRC platforms). Nobody enforces compliance at the moment a developer writes the code. That gap is what RegKit fills.

- EU AI Act Art. 50 transparency obligations are enforceable starting **August 2, 2026**.
- Texas TRAIGA carries fines up to **$200,000 per violation** — and NIST AI RMF compliance is an affirmative legal defense.
- HIPAA's Security Rule is being overhauled for the first time since 2003.
- Colorado's AI Act takes effect **June 30, 2026**.

Most engineering teams building AI features have no idea any of this applies to their code until an auditor, a regulator, or a lawsuit tells them.

## What RegKit does

- **Scans your code as you write it** — VS Code extension shows inline violations, same feel as a linter
- **Explains the law in plain English** — no legal degree required to understand why something is flagged
- **Generates compliance documents** — EU AI Act Annex IV, HIPAA Security Risk Assessments, GDPR DPIAs, SOC 2 evidence, and more, drafted automatically from your codebase (see [`packages/scanner/example-evidence/`](./packages/scanner))
- **Blocks non-compliant merges** — GitHub Action gate stops violations before they reach production
- **Jurisdiction-aware** — the same code can be legal in one US state and illegal in another; RegKit knows the difference

## How it's built

- **Engine:** Node.js + tree-sitter AST analysis
- **Legal reasoning:** Anthropic Claude API (bring-your-own-key — your code goes directly to Anthropic under your own key, never through RegKit's servers)
- **Rules:** open YAML definitions so anyone can inspect exactly what RegKit checks for and why

## Why open source

The rule definitions are open so developers and compliance teams can inspect exactly what RegKit checks for and why. Trust requires transparency — especially for a tool that tells you what the law requires.

## License

MIT — see [LICENSE](./LICENSE)

---

*RegKit is a compliance intelligence tool, not a law firm. Always consult qualified legal counsel for final compliance decisions.*
