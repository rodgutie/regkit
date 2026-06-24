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

13 rules loaded from `rules/`, **all 13 with active AST detectors wired**
(HIPAA, EU AI Act Art. 14, GDPR Art. 22, Colorado, Texas, NYC LL144,
Illinois HB3773, Illinois BIPA, California ADMT, California SB942,
Washington HB1170, multi-state chatbot, federal FCRA/ECOA).

## AGENT-3 — the legal reasoning second pass

The detectors above are deterministic pattern matchers: fast, free, no API
calls. They find *candidates*. AGENT-3 is the reasoning layer that reviews
each candidate and decides whether it's a genuine violation or a false
positive the pattern matcher couldn't resolve.

Run it with `--reason`:

```bash
node cli.js scan test-fixtures/patient-risk-assessment-compliant.js --config test-fixtures/regkit.yaml --reason
```

AGENT-3 annotates each finding with a verdict:
- **CONFIRMED** — genuine violation, high confidence
- **NEEDS_HUMAN** — structural pattern present, but final determination
  depends on a fact not visible in code (e.g. whether human review is
  "meaningful", or whether a pending law is yet enforceable)
- **DISMISSED** — false positive, filtered out

### Run modes (automatic)

- **No API key** → deterministic mock reasoning. Runs free, anywhere,
  produces the same output shape. This is the default so the scanner works
  for anyone who clones the repo with zero setup.
- **`ANTHROPIC_API_KEY` set** → genuine Claude legal reasoning per finding,
  grounded in each rule's own statutory research (citation, summary,
  false-positive guards from the YAML become the legal context).
- **API error / rate limit / bad key** → graceful automatic fallback to
  mock, so a scan never crashes mid-run (critical for CI pipelines).

Flags: `--reason` (enable AGENT-3), `--mock` (force mock even with a key),
`--all` (keep DISMISSED findings in output).

## AGENT-5 — the compliance document generator

Run with `--evidence`:

```bash
node cli.js scan <path> --config <regkit.yaml> --evidence
```

AGENT-5 takes the scan findings and auto-generates the compliance
documents regulators and auditors demand, writing them to a
`regkit-evidence/` folder. MVP generates the two documents fed by the most
rules:

- **AI System Data Flow Diagram** (fed by 10 of 13 rules, 100% auto) — a
  GitHub-native Mermaid diagram plus a data-flow inventory table plus the
  attached compliance obligations with real statutory citations. Answers
  the first question every auditor asks: what data goes into your AI and
  where does the output go.
- **Algorithmic Impact Assessment** (fed by 5 rules, ~60% auto) —
  auto-fills system description, detected proxy variables, and a
  jurisdiction-by-jurisdiction obligations table, then explicitly marks the
  bias-testing-results, mitigation, and sign-off sections as
  `[HUMAN COMPLETION REQUIRED]`. RegKit cannot run a statistical bias audit
  from source code (and for NYC LL144 the law requires an *independent*
  auditor), so it generates the scaffold and is honest about the boundary.

A compliance officer producing either document manually spends days to
weeks. AGENT-5 generates the draft as a byproduct of a scan that already
ran. This is RegKit's commercial engine — the feature that converts a free
install into a paying compliance-officer champion.

## GitHub Action — the PR compliance gate

RegKit ships as a GitHub Action that runs on every pull request, posts a
compliance report as a PR comment, and **blocks the merge** if any BLOCK
findings are present.

To enable it in any repo, drop this into `.github/workflows/regkit.yml`
(full example in `.github-workflow-example/regkit.yml`):

```yaml
name: RegKit Compliance
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
jobs:
  compliance-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rodgutie/regkit@main
        with:
          reason: 'true'
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}  # optional BYOK
```

How it works:
- `cli.js ... --format json` emits machine-readable findings.
- `action/post-comment.js` formats them into a PR comment and posts via the
  GitHub token GitHub injects automatically (no third-party action, no extra
  dependency).
- The scanner exits 1 on BLOCK findings → the check fails → the merge is
  blocked. Clean code exits 0 → merge proceeds.

The Anthropic key (for live AGENT-3 reasoning) is provided as a repo secret
and passed straight to Anthropic — BYOK, never through RegKit's servers.
Without it, the gate still runs with AGENT-3 in mock mode.

### JSON output mode

For any CI integration beyond the bundled Action:

```bash
node cli.js scan <path> --config <regkit.yaml> --format json
```

Emits `{ summary: {block,warn,info,passed}, agent3Mode, findings: [...] }`
with no console noise, suitable for piping into other tools.

## A note on API keys (BYOK)

RegKit uses **bring-your-own-key** for AGENT-3's Claude reasoning. Set
`ANTHROPIC_API_KEY` and the code snippet goes directly from your machine to
Anthropic under your own agreement — RegKit's servers are never in the path
of your proprietary code. For a compliance/security tool, "your code never
passes through our servers" is a feature, not friction. Without a key, the
scanner runs fully in mock mode.

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
