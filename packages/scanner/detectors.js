/**
 * RegKit Scanner — Detectors
 *
 * One detector function per rule family, implementing the AST patterns
 * described in each rule's YAML file as actual executable logic. This is
 * the deterministic-pattern layer (fast, free, no API calls) that finds
 * CANDIDATES — the full AGENT-3 legal reasoning layer (Claude-powered)
 * reviews these candidates in a second pass to confirm/dismiss/explain.
 */

const {
  collectCallExpressions,
  nodeText,
  matchesAISDKCall,
  findSensitiveDataSignals,
  findEnclosingFunction,
  hasScaffoldCall,
} = require('./core');

// Scaffold calls RegKit recognizes as satisfying various obligations
const SCAFFOLDS = {
  humanReview: ['regkit.humanReviewGate', 'humanReviewGate', 'manualReview', 'manualOverride'],
  trace: ['regkit.trace', '.trace(', 'auditLog', 'audit_log'],
  disclose: ['regkit.disclose', '.disclose('],
  consentVerify: ['regkit.verifyConsent', 'verifyConsent'],
  provenanceEmbed: ['regkit.embedProvenance', 'embedProvenance'],
  baaCheck: ['baa_signed', 'baaSigned'],
};

function makeFinding(rule, filePath, callNode, sourceCode, extra = {}) {
  const line = callNode.startPosition.row + 1;
  const func = findEnclosingFunction(callNode, sourceCode);
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: extra.severity || rule.severity,
    file: filePath,
    line,
    functionName: func ? func.name : '<module scope>',
    codeSnippet: nodeText(callNode, sourceCode),
    message: extra.message || (rule.message && rule.message.developer_facing) || rule.name,
    citation: rule.regulation ? rule.regulation.citation : null,
    ...extra,
  };
}

// ─── RK-HIPAA-001 ─────────────────────────────────────────────────────────────
// PHI sent to AI vendor without BAA

function detectHipaaBaaViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  const calls = collectCallExpressions(ast.rootNode);

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    if (!sdkMatch.matched) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;

    const signals = findSensitiveDataSignals(func.text);
    if (!signals.includes('phi')) continue;

    // Check project config for BAA status on this vendor
    const vendorConfig = (projectConfig.ai_vendors || []).find(v => v.vendor === sdkMatch.vendor);
    const baaSigned = vendorConfig ? vendorConfig.baa_signed : false;

    if (!baaSigned) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        vendor: sdkMatch.vendor,
        detail: `PHI-related data flows into ${sdkMatch.vendor} call with no signed BAA in regkit.yaml`,
      }));
    }
  }
  return findings;
}

// ─── RK-EUAI-014 ──────────────────────────────────────────────────────────────
// EU AI Act Art. 14 — human oversight

const HIGH_RISK_FUNCTION_NAME_SIGNALS = /loan|credit|hiring|hire|applicant|medical|diagnos|biometric|admission/i;
const ACTION_TAKING_PATTERNS = ['issueLoan', 'approve(', 'deny(', 'reject(', 'issue(', 'hire(', 'terminate('];

function detectEuAiActArt14Violation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  const calls = collectCallExpressions(ast.rootNode);

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    if (!sdkMatch.matched) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;

    // Risk gate: only fires if function name/content suggests high-risk domain
    if (!HIGH_RISK_FUNCTION_NAME_SIGNALS.test(func.name) && !HIGH_RISK_FUNCTION_NAME_SIGNALS.test(func.text)) {
      continue;
    }

    const hasOversight = hasScaffoldCall(func.text, SCAFFOLDS.humanReview);
    const hasActionWithNoOversight = ACTION_TAKING_PATTERNS.some(p => func.text.includes(p)) && !hasOversight;

    if (hasActionWithNoOversight) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        detail: `High-risk AI decision in '${func.name}' reaches an action-taking function with no human oversight gate detected`,
      }));
    }
  }
  return findings;
}

// ─── RK-GDPR-022 ──────────────────────────────────────────────────────────────
// GDPR Art. 22 — automated decision-making

const SIGNIFICANT_EFFECT_DOMAIN_SIGNALS = /loan|credit|hir|employ|insur|housing|legal_?status/i;

function detectGdprArt22Violation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  const calls = collectCallExpressions(ast.rootNode);

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    if (!sdkMatch.matched) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;

    if (!SIGNIFICANT_EFFECT_DOMAIN_SIGNALS.test(func.name)) continue;

    const hasHumanInvolvement = hasScaffoldCall(func.text, SCAFFOLDS.humanReview);
    const actionTaken = ACTION_TAKING_PATTERNS.some(p => func.text.includes(p));

    if (actionTaken && !hasHumanInvolvement) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'BLOCK',
        detail: `Solely automated decision with likely significant effect in '${func.name}', no human intervention path detected`,
      }));
    } else if (actionTaken && hasHumanInvolvement) {
      // Downgrade per the rule's own false-positive guard: presence of
      // review function downgrades to WARN, doesn't auto-clear
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'WARN',
        detail: `Human review function present in '${func.name}' — confirm reviewer has genuine authority to override (meaningful involvement), not just sign-off ritual`,
      }));
    }
  }
  return findings;
}

// ─── RK-IL-BIPA-001 ───────────────────────────────────────────────────────────
// Illinois biometric consent

const BIOMETRIC_CAPTURE_PATTERNS = [
  'fingerprintScanner.capture', 'faceRecognition.scan', 'irisScan', 'voiceBiometric', 'handGeometry',
];

function detectBipaViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (projectConfig.entity_type === 'financial_institution_glba_covered') return findings; // exemption
  const calls = collectCallExpressions(ast.rootNode);

  for (const call of calls) {
    const text = nodeText(call, sourceCode);
    const isBiometricCapture = BIOMETRIC_CAPTURE_PATTERNS.some(p => text.includes(p.split('.')[0]));
    if (!isBiometricCapture) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;

    const hasConsent = hasScaffoldCall(func.text, SCAFFOLDS.consentVerify);
    if (!hasConsent) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        detail: `Biometric capture in '${func.name}' with no consent verification gate detected before the capture call`,
      }));
    }
  }
  return findings;
}

// ─── RK-US-FCRA-ECOA-001 ──────────────────────────────────────────────────────
// Federal credit adverse action

const CREDIT_DECISION_SIGNALS = /credit|loan|underwrit|lending/i;

function detectFcraEcoaViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  const calls = collectCallExpressions(ast.rootNode);

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    if (!sdkMatch.matched) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (!CREDIT_DECISION_SIGNALS.test(func.name)) continue;

    // Explainability gate check — is there any attribution mechanism?
    const hasAttribution = func.text.includes('extractFeatureAttribution') ||
                            func.text.includes('topFactors') ||
                            func.text.includes('SHAP') || func.text.includes('shap');

    const isOpaqueLLM = sdkMatch.vendor === 'generic_ml' || ['openai', 'anthropic'].includes(sdkMatch.vendor);

    if (isOpaqueLLM && !hasAttribution) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        detail: `Credit decision in '${func.name}' uses an opaque AI model with no feature-attribution mechanism detected — CFPB guidance states inability to explain is not a defense`,
      }));
    }
  }
  return findings;
}

// ─── DETECTOR REGISTRY ────────────────────────────────────────────────────────
// Maps rule ID prefixes to their detector functions. Rules not yet wired
// to a detector fall through to a generic AI-call presence flag (better
// than silently skipping them).

const DETECTOR_REGISTRY = {
  'RK-HIPAA-001': detectHipaaBaaViolation,
  'RK-EUAI-014': detectEuAiActArt14Violation,
  'RK-GDPR-022': detectGdprArt22Violation,
  'RK-IL-BIPA-001': detectBipaViolation,
  'RK-US-FCRA-ECOA-001': detectFcraEcoaViolation,
};

function runDetector(rule, ast, sourceCode, filePath, projectConfig) {
  const detector = DETECTOR_REGISTRY[rule.id];
  if (!detector) {
    return { findings: [], status: 'NO_DETECTOR_WIRED' };
  }
  try {
    const findings = detector(rule, ast, sourceCode, filePath, projectConfig);
    return { findings, status: 'OK' };
  } catch (err) {
    return { findings: [], status: 'ERROR', error: err.message };
  }
}

module.exports = {
  runDetector,
  DETECTOR_REGISTRY,
  makeFinding,
};
