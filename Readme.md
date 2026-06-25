RegKit

Compliance-native AI development. RegKit catches EU AI Act, HIPAA, GDPR, and other AI compliance violations in your code — before it ships. 13 regulations across federal, European Union, and 7 US jurisdictions, each grounded in actual statutory text — including cases where the same code is legal in one US state and illegal in another.

Think spell-check, but for the law.

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

Why RegKit exists

Every AI compliance tool today either watches your AI after it ships (observability platforms) or manages paperwork manually (GRC platforms). Nobody enforces compliance at the moment a developer writes the code. That gap is what RegKit fills.


EU AI Act Art. 50 transparency obligations are enforceable starting August 2, 2026.
Texas TRAIGA carries fines up to $200,000 per violation — and NIST AI RMF compliance is an affirmative legal defense.
HIPAA's Security Rule is being overhauled for the first time since 2003.
Colorado's AI Act takes effect June 30, 2026.


Most engineering teams building AI features have no idea any of this applies to their code until an auditor, a regulator, or a lawsuit tells them.

What RegKit does


Scans your code as you write it — VS Code extension shows inline violations, same feel as a linter
Explains the law in plain English — no legal degree required to understand why something is flagged
Generates the fix — not just a warning, the actual replacement code
Blocks non-compliant merges — GitHub Action gate stops violations before they reach production
Auto-generates compliance documents — EU AI Act Annex IV, HIPAA Security Risk Assessments, GDPR DPIAs, and more, drafted automatically from your codebase


Status

🚧 Early development. This repository will fill in over the coming weeks with the rule engine, VS Code extension, and CLI. Follow along or star the repo to track progress.

Roadmap


 Core rule engine (tree-sitter based AST analysis)
 First 30 rules: EU AI Act, HIPAA, GDPR core requirements
 VS Code extension (alpha)
 CLI: regkit scan, regkit gate
 GitHub Action for PR gating
 Evidence document generator
 Public launch on VS Code Marketplace


Why open source

The rule definitions are open so developers and compliance teams can inspect exactly what RegKit checks for and why. Trust requires transparency — especially for a tool that tells you what the law requires.

Get involved

This is being built in public. Follow progress on X: @regkit (or your handle)

Found a regulation RegKit should cover? Open an issue.

License

MIT — see LICENSE


RegKit is a compliance intelligence tool, not a law firm. Always consult qualified legal counsel for final compliance decisions.
