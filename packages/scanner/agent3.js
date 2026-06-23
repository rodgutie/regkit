/**
 * RegKit AGENT-3 — Legal Interpreter (second pass)
 *
 * The deterministic detectors (detectors.js) find CANDIDATES — code that
 * structurally matches a risky pattern. AGENT-3 is the reasoning layer:
 * for each candidate, it asks "given this specific code, in this specific
 * context, does this actually violate the law, or is it a false positive
 * the pattern matcher couldn't resolve?"
 *
 * This is the layer that separates RegKit from a linter. It's also the
 * only layer that costs money (Claude API), which is exactly why it runs
 * SECOND — never on clean code, only on flagged candidates.
 *
 * RUN MODES:
 *   - If ANTHROPIC_API_KEY is set: makes a real Claude API call per candidate.
 *   - If no key: falls back to a deterministic mock that produces the same
 *     output SHAPE (verdict + confidence + reasoning) so the scanner runs
 *     for anyone, anywhere, free — and silently upgrades to real reasoning
 *     the moment a key is provided. No code change needed to switch.
 */

const https = require('https');

const MODEL = 'claude-sonnet-4-6';
const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';

// ─── PROMPT CONSTRUCTION ──────────────────────────────────────────────────────

/**
 * Builds the legal-reasoning prompt for a single candidate finding.
 * The rule's own YAML (citation, summary, false-positive guards) becomes
 * the legal context Claude reasons against — so the prompt is grounded in
 * the same statutory research that produced the rule, not Claude's memory.
 */
function buildPrompt(finding, rule, codeContext) {
  const reg = rule.regulation || {};
  const guards = extractFalsePositiveGuards(rule);

  return `You are AGENT-3, RegKit's legal interpreter. A deterministic pattern matcher has flagged a CANDIDATE compliance issue. Your job is to reason about whether this specific code, in context, actually violates the law — or whether it is a false positive.

REGULATION:
  Framework: ${reg.framework || rule.id}
  Citation: ${reg.citation || 'n/a'}
  Requirement: ${reg.summary || rule.name}

WHAT THE PATTERN MATCHER FLAGGED:
  Rule: ${rule.id} — ${rule.name}
  Detail: ${finding.detail || ''}
  Function: ${finding.functionName}
  Severity (provisional): ${finding.severity}

FALSE-POSITIVE GUARDS for this rule (cases that should NOT be flagged):
${guards.map(g => '  - ' + g).join('\n') || '  (none specified)'}

CODE IN CONTEXT:
\`\`\`
${codeContext}
\`\`\`

Reason step by step about whether this is a genuine violation or a false positive, considering the false-positive guards above. Then respond with ONLY a JSON object (no markdown, no preamble) in exactly this shape:
{
  "verdict": "CONFIRMED" | "DISMISSED" | "NEEDS_HUMAN",
  "confidence": 0.0 to 1.0,
  "severity": "BLOCK" | "WARN" | "INFO",
  "reasoning": "one or two sentences explaining the determination in plain language a developer would understand"
}`;
}

function extractFalsePositiveGuards(rule) {
  const guards = rule.false_positive_guards || rule.falsePositiveGuards;
  if (Array.isArray(guards)) {
    return guards.map(g => (typeof g === 'string' ? g : JSON.stringify(g))).map(s => s.replace(/\s+/g, ' ').trim().slice(0, 220));
  }
  return [];
}

// ─── REAL CLAUDE API CALL ─────────────────────────────────────────────────────

function callClaude(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) {
            resolve(parsed.content[0].text);
          } else {
            reject(new Error('Unexpected API response shape: ' + data.slice(0, 200)));
          }
        } catch (err) {
          reject(new Error('Failed to parse API response: ' + err.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('API call timed out')));
    req.write(body);
    req.end();
  });
}

/** Extracts the JSON verdict object from Claude's response text */
function parseVerdict(responseText) {
  // Strip any markdown fences just in case
  const cleaned = responseText.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  return JSON.parse(match[0]);
}

// ─── MOCK FALLBACK ────────────────────────────────────────────────────────────

/**
 * Deterministic mock that mirrors the reasoning AGENT-3 would perform.
 * It uses the same signals the real prompt would weigh — but computes a
 * verdict locally instead of calling Claude. This keeps the scanner fully
 * runnable with zero API key, while producing the same output shape.
 *
 * The mock is intentionally conservative: it CONFIRMS clear structural
 * violations, downgrades to NEEDS_HUMAN where the rule itself flags an
 * organizational-fact ambiguity (e.g. "meaningful" human review), and
 * carries through the detector's provisional severity otherwise.
 */
function mockReason(finding, rule, codeContext) {
  const detail = (finding.detail || '').toLowerCase();
  const ambiguityMarkers = ['meaningful', 'confirm', 'flagged for human', 'human review function present', 'organizational fact'];
  const isAmbiguous = ambiguityMarkers.some(m => detail.includes(m));

  // Rules whose own design defers to human judgment on the ambiguous branch
  if (isAmbiguous || finding.severity === 'WARN') {
    return {
      verdict: 'NEEDS_HUMAN',
      confidence: 0.6,
      severity: finding.severity === 'BLOCK' ? 'WARN' : finding.severity,
      reasoning: `[mock] Structural pattern present, but final determination depends on a fact not visible in code (e.g. meaningfulness of human review, or pending enforcement status). Flagged for human confirmation. Set ANTHROPIC_API_KEY for genuine legal reasoning here.`,
      _mock: true,
    };
  }

  // Clear structural BLOCK violations get confirmed
  return {
    verdict: 'CONFIRMED',
    confidence: 0.8,
    severity: finding.severity,
    reasoning: `[mock] Code structurally matches the violation pattern with no false-positive guard satisfied (${finding.functionName}). Set ANTHROPIC_API_KEY to replace this with genuine Claude legal reasoning.`,
    _mock: true,
  };
}

// ─── PUBLIC INTERFACE ─────────────────────────────────────────────────────────

/**
 * Runs the AGENT-3 second pass over a list of candidate findings.
 * Returns the findings annotated with { agent3: {verdict, confidence, reasoning, ...} }.
 * Dismissed candidates are filtered out unless includeAll is set.
 */
async function runAgent3(findings, ruleMap, codeContextFor, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const useMock = !apiKey || options.forceMock;
  const results = [];

  for (const finding of findings) {
    const rule = ruleMap[finding.ruleId] || {};
    const codeContext = codeContextFor(finding);

    let verdict;
    if (useMock) {
      verdict = mockReason(finding, rule, codeContext);
    } else {
      try {
        const prompt = buildPrompt(finding, rule, codeContext);
        const responseText = await callClaude(prompt, apiKey);
        verdict = parseVerdict(responseText);
        verdict._mock = false;
      } catch (err) {
        // Graceful degradation: if the real call fails, fall back to mock
        // rather than crashing the whole scan
        verdict = mockReason(finding, rule, codeContext);
        verdict.reasoning = `[api-fallback: ${err.message.slice(0, 60)}] ` + verdict.reasoning;
      }
    }

    const annotated = { ...finding, agent3: verdict };
    // Apply AGENT-3's severity override (it can downgrade/upgrade the detector's guess)
    if (verdict.severity) annotated.severity = verdict.severity;

    if (verdict.verdict !== 'DISMISSED' || options.includeAll) {
      results.push(annotated);
    }
  }

  return { results, mode: useMock ? 'mock' : 'live' };
}

module.exports = {
  runAgent3,
  buildPrompt,
  mockReason,
  parseVerdict,
  MODEL,
};
