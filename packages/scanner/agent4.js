/**
 * RegKit AGENT-4 — Remediation Agent
 *
 * Takes a confirmed finding and generates the actual replacement code that
 * resolves the violation — plus the RegKit scaffold calls (regkit.trace(),
 * regkit.humanReviewGate(), regkit.disclose(), etc.) that both satisfy the
 * legal requirement AND begin generating the audit trail AGENT-5 compiles
 * into compliance documents.
 *
 * This is what turns RegKit from a tool that FINDS problems into one that
 * FIXES them. The developer reviews a diff and accepts with one click.
 *
 * Two generation modes (same pattern as AGENT-3):
 *   - With ANTHROPIC_API_KEY: Claude generates a context-aware fix tailored
 *     to the actual surrounding code.
 *   - Without a key: deterministic template-based fix from the rule's known
 *     remediation strategy. Always runnable, free, no key required.
 *
 * Each remediation returns a unified-diff-style before/after so the editor
 * or CLI can show a side-by-side and the developer can accept or reject.
 */

const https = require('https');

const MODEL = 'claude-sonnet-4-6';

// ─── REMEDIATION STRATEGIES PER RULE ──────────────────────────────────────────
// Each strategy knows how to transform the flagged code. The scaffold calls
// are the same primitives the detectors look for, so applying a fix makes the
// next scan pass.

const STRATEGIES = {
  'RK-HIPAA-001': {
    scaffold: 'BAA configuration',
    autoFixable: true,
    strategy: 'vendor_swap_or_baa',
    explain: 'Either switch to an AI vendor with a signed BAA, or record the signed BAA in regkit.yaml. RegKit cannot sign a BAA for you — this is a contractual action — but it can wire the config check.',
    generate: (finding) => ({
      kind: 'config',
      note: 'Add to regkit.yaml under ai_vendors:',
      patch: `ai_vendors:\n  - vendor: ${finding.vendor || 'openai'}\n    baa_signed: true   # <-- only set true once a BAA is actually signed`,
    }),
  },

  'RK-EUAI-014': {
    scaffold: 'regkit.humanReviewGate()',
    autoFixable: true,
    strategy: 'wrap_human_oversight',
    explain: 'Wrap the AI output in a human-oversight gate before any action is taken on it, satisfying EU AI Act Art. 14.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Wrap the AI decision in a human review gate before acting on it:',
      patch: scaffoldHumanReviewWrap(finding),
    }),
  },

  'RK-GDPR-022': {
    scaffold: 'regkit.humanReviewGate() + appeal endpoint',
    autoFixable: true,
    strategy: 'human_involvement_plus_appeal',
    explain: 'Add meaningful human involvement and a contest/appeal path so the decision is not solely automated under GDPR Art. 22.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add human involvement and an appeal path:',
      patch: scaffoldHumanReviewWrap(finding) + '\n\n// Also expose a contest endpoint:\n// app.post("/decisions/:id/appeal", regkit.appealHandler);',
    }),
  },

  'RK-IL-BIPA-001': {
    scaffold: 'regkit.verifyConsent()',
    autoFixable: true,
    strategy: 'consent_gate_before_capture',
    explain: 'Add a written-consent verification gate BEFORE any biometric capture, satisfying BIPA Section 15(b).',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add a consent gate before the biometric capture:',
      patch: scaffoldConsentGate(finding),
    }),
  },

  'RK-US-FCRA-ECOA-001': {
    scaffold: 'feature attribution + specific reasons',
    autoFixable: false,
    strategy: 'explainability_required',
    explain: 'NO auto-fix. The CFPB requires specific principal reasons drawn from a real feature-attribution mechanism. Adding genuine explainability is an architecture decision (SHAP/LIME or an interpretable model) RegKit cannot safely auto-generate. RegKit scaffolds the notice structure but the attribution must be wired by a human.',
    generate: (finding) => ({
      kind: 'guidance',
      note: 'Architecture change required (not auto-applicable):',
      patch: '// 1. Add a feature-attribution layer (e.g. SHAP) between the model and the decision.\n// 2. Extract the top 2-4 contributing factors for THIS applicant.\n// 3. Populate the adverse-action notice with those specific reasons + score disclosure.\n// RegKit will scaffold the notice template once an attribution source exists.',
    }),
  },

  'RK-IL-HB3773-001': {
    scaffold: 'regkit.disclose() + feature removal',
    autoFixable: true,
    strategy: 'remove_proxy_and_notice',
    explain: 'Remove the zip-code proxy feature (flag for human confirmation before retraining) and add the required AI-use notice.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add AI-use notice; flag zip-code feature for removal:',
      patch: scaffoldDisclose(finding, 'il_aedt') + '\n\n// ⚠️ Remove zip-code (or zip-derived) feature from model inputs — Illinois HB 3773\n// names zip code as a prohibited proxy. Confirm safe to retrain without it.',
    }),
  },

  'RK-NYC-LL144-001': {
    scaffold: 'regkit.disclose() + audit tracking',
    autoFixable: true,
    strategy: 'notice_and_audit_tracking',
    explain: 'Add candidate notice dispatch and audit-tracking config. The bias audit itself requires an independent auditor RegKit cannot replace.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add candidate notice (10-day lead) and track the audit in regkit.yaml:',
      patch: scaffoldDisclose(finding, 'aedt', '{ leadDays: 10 }') + '\n\n// In regkit.yaml:\n// aedt_bias_audit:\n//   last_completed_date: "YYYY-MM-DD"   # from your independent auditor\n//   public_summary_url: "https://..."',
    }),
  },

  'RK-CA-ADMT-001': {
    scaffold: 'regkit.disclose() + opt-out path + humanReviewGate()',
    autoFixable: true,
    strategy: 'notice_optout_appeal',
    explain: 'Add pre-use notice, a genuine non-ADMT alternative path for opt-out, and an appeal gate.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add notice, a real opt-out alternative, and an appeal gate:',
      patch: scaffoldCaAdmt(finding),
    }),
  },

  'RK-CA-SB942-001': {
    scaffold: 'regkit.embedProvenance()',
    autoFixable: true,
    strategy: 'embed_provenance',
    explain: 'Embed latent provenance metadata on every generated media output (mandatory by default), and offer a manifest label option.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Embed provenance on the generated media before it is stored/returned:',
      patch: scaffoldProvenance(finding),
    }),
  },

  'RK-WA-HB1170-001': {
    scaffold: 'regkit.embedProvenance()',
    autoFixable: true,
    strategy: 'embed_provenance',
    explain: 'Same provenance-embedding fix as CA SB 942 — Washington requires watermarking/metadata on generated media.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Embed provenance on the generated media:',
      patch: scaffoldProvenance(finding),
    }),
  },

  'RK-US-CHATBOT-001': {
    scaffold: 'regkit.disclose() + crisis detection',
    autoFixable: true,
    strategy: 'disclosure_and_crisis',
    explain: 'Add AI disclosure at session start (with recurring reminders for the strictest applicable state), and for companion AI, add crisis detection + referral.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add chatbot disclosure (and crisis handling if this is a companion bot):',
      patch: scaffoldChatbot(finding),
    }),
  },

  'RK-CO-ADMT-001': {
    scaffold: 'regkit.disclose() + humanReviewGate()',
    autoFixable: true,
    strategy: 'notice_and_review',
    explain: 'Add consumer notice and a human review pathway for the consequential automated decision.',
    generate: (finding) => ({
      kind: 'code',
      note: 'Add notice and a human review pathway:',
      patch: scaffoldDisclose(finding, 'co_admt') + '\n' + scaffoldHumanReviewWrap(finding),
    }),
  },

  'RK-TX-TRAIGA-001': {
    scaffold: 'NIST documentation',
    autoFixable: true,
    strategy: 'nist_safe_harbor',
    explain: 'Build the NIST AI RMF documentation that establishes the Texas TRAIGA §552.105 affirmative defense. The proxy finding itself is intent-based and requires human/legal review.',
    generate: (finding) => ({
      kind: 'guidance',
      note: 'Build NIST safe-harbor documentation (RegKit AGENT-5 can scaffold this):',
      patch: '// Run: regkit scan <path> --evidence\n// to generate the NIST AI RMF Conformance Report that establishes your\n// TRAIGA §552.105 affirmative defense. The proxy-variable finding requires\n// human/legal review of intent (disparate impact alone is insufficient in TX).',
    }),
  },
};

// ─── SCAFFOLD GENERATORS ──────────────────────────────────────────────────────

function scaffoldHumanReviewWrap(finding) {
  const fn = finding.functionName || 'decision';
  return `// Before acting on the AI output, route it through a human review gate:
const aiRecommendation = /* existing AI call result */;
const reviewedDecision = await regkit.humanReviewGate({
  recommendation: aiRecommendation,
  context: { source: '${fn}' },
  // reviewer must have genuine authority to override, not just rubber-stamp
});
// Use reviewedDecision (not the raw AI output) for any consequential action.`;
}

function scaffoldConsentGate(finding) {
  const fn = finding.functionName || 'capture';
  return `// Verify written consent BEFORE the biometric capture call:
const consentValid = await regkit.verifyConsent({
  subjectId: /* the person's id */,
  type: 'biometric',
  method: /* e.g. 'fingerprint_scan' */,
});
if (!consentValid) {
  throw new Error('BIPA: written biometric consent required before capture');
}
// ...then proceed with the existing capture in ${fn}().`;
}

function scaffoldDisclose(finding, noticeType, opts) {
  if (opts) {
    const inner = opts.replace(/^\{|\}$/g, '').trim();
    return `await regkit.disclose({ type: '${noticeType}', ${inner} });`;
  }
  return `await regkit.disclose({ type: '${noticeType}' });`;
}

function scaffoldProvenance(finding) {
  return `// Embed latent provenance (mandatory by default) before storing/returning:
const withProvenance = await regkit.embedProvenance(generatedMedia, {
  provider: /* your org name */,
  system: /* your model name + version */,
  timestamp: Date.now(),
});
// Offer (do not force) a visible manifest label as a user option:
const finalMedia = userWantsVisibleLabel
  ? applyVisibleAILabel(withProvenance)
  : withProvenance;`;
}

function scaffoldCaAdmt(finding) {
  return `await regkit.disclose({ type: 'ca_admt_notice', purpose: /* describe */ });
// Provide a GENUINE non-ADMT alternative for opt-out (not just a flag):
if (consumer.optedOutOfADMT) {
  return await manualReviewProcess(/* inputs */);  // real alternative path
}
const decision = /* existing ADMT result */;
const finalDecision = await regkit.humanReviewGate({ recommendation: decision });`;
}

function scaffoldChatbot(finding) {
  return `// Disclose at session start (recurring reminder for strictest applicable state):
await regkit.disclose({ type: 'chatbot_ai_notice', recurring: '3h' });

// If this is a COMPANION bot (sustained relationship), add crisis handling:
const crisisSignal = await regkit.crisisCheck(userMessage);
if (crisisSignal.detected) {
  return craftCrisisReferralResponse(crisisSignal); // surfaces 988, halts companion persona
}`;
}

// ─── CLAUDE-POWERED CONTEXT-AWARE FIX (optional) ──────────────────────────────

function callClaude(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.content && p.content[0] && p.content[0].text) resolve(p.content[0].text);
          else reject(new Error('Unexpected API shape'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

function buildFixPrompt(finding, rule, codeContext) {
  const strat = STRATEGIES[finding.ruleId];
  return `You are RegKit AGENT-4, a code remediation agent. Generate a minimal, correct fix for this compliance violation.

VIOLATION: ${finding.ruleId} — ${finding.ruleName}
DETAIL: ${finding.detail || ''}
REQUIRED FIX STRATEGY: ${strat ? strat.explain : 'apply the rule\'s remediation'}
SCAFFOLD TO USE: ${strat ? strat.scaffold : 'n/a'}

CODE TO FIX:
\`\`\`
${codeContext}
\`\`\`

Return ONLY the corrected code block (no explanation, no markdown fences). Keep changes minimal — preserve the existing logic, insert the required compliance scaffold in the right place.`;
}

// ─── PUBLIC INTERFACE ─────────────────────────────────────────────────────────

/**
 * Generates a remediation for a single finding.
 * Returns { ruleId, autoFixable, strategy, explanation, fix: {kind, note, patch}, mode }
 */
async function remediate(finding, rule, codeContext, options = {}) {
  const strat = STRATEGIES[finding.ruleId];
  if (!strat) {
    return {
      ruleId: finding.ruleId,
      autoFixable: false,
      explanation: 'No remediation strategy defined for this rule yet.',
      fix: null,
      mode: 'none',
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const useTemplate = !apiKey || options.forceTemplate || !strat.autoFixable;

  let fix, mode;
  if (useTemplate) {
    fix = strat.generate(finding);
    mode = 'template';
  } else {
    try {
      const prompt = buildFixPrompt(finding, rule, codeContext);
      const generated = await callClaude(prompt, apiKey);
      fix = { kind: 'code', note: 'AI-generated context-aware fix:', patch: generated.replace(/```[a-z]*|```/g, '').trim() };
      mode = 'live';
    } catch (err) {
      fix = strat.generate(finding);
      mode = 'template-fallback';
    }
  }

  return {
    ruleId: finding.ruleId,
    autoFixable: strat.autoFixable,
    strategy: strat.strategy,
    explanation: strat.explain,
    fix,
    mode,
  };
}

/** Generates remediations for a list of findings */
async function remediateAll(findings, ruleMap, codeContextFor, options = {}) {
  const out = [];
  for (const f of findings) {
    const rule = ruleMap[f.ruleId] || {};
    const codeContext = codeContextFor ? codeContextFor(f) : (f.codeSnippet || '');
    out.push({ finding: f, remediation: await remediate(f, rule, codeContext, options) });
  }
  return out;
}

module.exports = { remediate, remediateAll, STRATEGIES };
