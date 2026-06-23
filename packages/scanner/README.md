# RegKit Scanner — MVP

The working core of RegKit: a tree-sitter based AST scanner that reads
JavaScript/TypeScript source code, matches it against RegKit's YAML rule
definitions, and reports compliance violations with citations to the
actual law.

## What this is

This is the deterministic AST-pattern layer — the fast, free, no-API-call
part of RegKit's pipeline. It finds candidate violations by recognizing
code patterns described in each rule file (AI SDK calls, sensitive
variable names, missing scaffold calls like `regkit.humanReviewGate()`).

The full agentic reasoning layer (Claude-powered legal interpretation,
AGENT-3 through AGENT-7 from RegKit's architecture) is the next phase —
this scanner's job is to surface the candidates worth that deeper,
costlier analysis.

## Setup

```bash
npm install
```

## Usage

```bash
node cli.js scan <file-or-directory> --config <path-to-regkit.yaml>
```

## Try it now — proven test case

```bash
npm test
```

This runs the scanner against `test-fixtures/patient-risk-assessment.js`,
a deliberately non-compliant healthtech/fintech code sample, using
`test-fixtures/regkit.yaml` as the project config (OpenAI has no BAA,
Anthropic does).

**Expected output: 4 BLOCK findings** across HIPAA, EU AI Act Art. 14,
GDPR Art. 22, and federal FCRA/ECOA — each with the real legal citation.

Then compare against the "fixed" version:

```bash
node cli.js scan test-fixtures/patient-risk-assessment-compliant.js --config test-fixtures/regkit.yaml
```

**Expected output: 1 BLOCK, 1 WARN** — HIPAA and EU AI Act Art. 14 clear
completely (vendor switched, human review gate added). GDPR Art. 22
downgrades to WARN rather than clearing entirely (a human review function
satisfies the law's requirement on its face, but "meaningful" involvement
is a fact RegKit can't verify from code alone — it flags for confirmation
rather than auto-clearing). **FCRA/ECOA still BLOCKS** — because adding a
human review gate doesn't satisfy the federal requirement for model
*explainability*, which is a genuinely different obligation. This is the
clearest proof point in the whole MVP: satisfying one law does not
automatically satisfy another.

## Current rule coverage

13 rules loaded from `rules/`. 5 have active AST detectors wired
(HIPAA, EU AI Act Art. 14, GDPR Art. 22, Illinois BIPA, FCRA/ECOA). The
remaining 8 are loaded and validated but not yet wired to detector logic
— next build phase.

## Architecture

- `core.js` — tree-sitter parsing, rule loading, shared AST helper functions
- `detectors.js` — one detector function per rule, implementing the AST
  patterns described in each rule's YAML `detection` block
- `cli.js` — command-line entry point, file discovery, report formatting

## Next steps (post-MVP)

1. Wire detectors for the remaining 8 rules
2. Add the Claude-powered AGENT-3 second pass for genuine legal reasoning
   on ambiguous candidates (not just deterministic pattern matching)
3. Package as a VS Code extension (LSP wrapper around this same engine)
4. Package as a GitHub Action for the PR gate
5. Build the evidence/document generator (AGENT-5) consuming these findings
