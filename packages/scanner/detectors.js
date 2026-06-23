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
  matchesMediaGenCall,
  jurisdictionApplies,
  configValue,
  CHATBOT_FUNCTION_SIGNALS,
  COMPANION_MEMORY_SIGNALS,
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

// ─── RK-IL-HB3773-001 ─────────────────────────────────────────────────────────
// Illinois employment AI — outcome-based, zip code proxy BLOCK-on-sight, plus
// universal AI-use notice requirement

const EMPLOYMENT_FUNCTION_SIGNALS = /hir|hiring|recruit|applicant|candidate|promot|terminat|discipline|screen|employ/i;

function detectIlHb3773Violation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, ['IL'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);
  const seenFunctions = new Set();

  for (const call of calls) {
    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (!EMPLOYMENT_FUNCTION_SIGNALS.test(func.name) && !EMPLOYMENT_FUNCTION_SIGNALS.test(func.text)) continue;

    const isAICall = matchesAISDKCall(call, sourceCode).matched ||
                     /\.predict\(|\.score\(|scoreResumes|\.rank\(/.test(nodeText(call, sourceCode));
    if (!isAICall) continue;

    // Branch A: zip code proxy — BLOCK on sight (statute names zip code specifically)
    if (/zip_?code|zipcode|postal_?code/i.test(func.text)) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'BLOCK',
        detail: `Employment AI in '${func.name}' uses a zip code feature — Illinois HB 3773 names zip code as a prohibited proxy; outcome-based liability, intent is not a defense`,
      }));
    }

    // Branch C: universal AI-use notice — required regardless of discrimination.
    // Fire once per function to avoid duplicate notice findings.
    if (!seenFunctions.has(func.name)) {
      seenFunctions.add(func.name);
      const hasNotice = hasScaffoldCall(func.text, SCAFFOLDS.disclose);
      if (!hasNotice) {
        findings.push(makeFinding(rule, filePath, call, sourceCode, {
          severity: 'BLOCK',
          detail: `Employment AI in '${func.name}' has no AI-use notice — Illinois HB 3773 requires notice regardless of whether the AI use is discriminatory`,
        }));
      }
    }
  }
  return findings;
}

// ─── RK-NYC-LL144-001 ─────────────────────────────────────────────────────────
// NYC AEDT — bias audit currency + candidate notice (procedural law)

function detectNycLl144Violation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  // Applies based on candidate residence; conservative default unless explicitly scoped away from NYC/NY
  if (!jurisdictionApplies(projectConfig, ['NY', 'NYC'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);
  const seenFunctions = new Set();

  for (const call of calls) {
    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (!EMPLOYMENT_FUNCTION_SIGNALS.test(func.name) && !EMPLOYMENT_FUNCTION_SIGNALS.test(func.text)) continue;

    const text = nodeText(call, sourceCode);
    const isAEDT = /scoreResumes|\.rank\(|\.score\(|\.predict\(/.test(text) || matchesAISDKCall(call, sourceCode).matched;
    if (!isAEDT) continue;
    if (seenFunctions.has(func.name)) continue;
    seenFunctions.add(func.name);

    const audit = configValue(projectConfig, 'aedt_bias_audit');
    const missing = [];
    if (!audit || !audit.last_completed_date) missing.push('no current bias audit on file');
    if (!audit || !audit.public_summary_url) missing.push('no public audit summary URL');
    const hasNotice = hasScaffoldCall(func.text, SCAFFOLDS.disclose);
    if (!hasNotice) missing.push('no candidate notice dispatch');

    if (missing.length > 0) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'BLOCK',
        detail: `AEDT in '${func.name}': ${missing.join('; ')}. NYC LL144 requires a current independent bias audit, public summary, and 10-day candidate notice`,
      }));
    }
  }
  return findings;
}

// ─── RK-TX-TRAIGA-001 ─────────────────────────────────────────────────────────
// Texas — INTENT-based: proxy/impact alone = WARN only, plus NIST safe-harbor gap

function detectTxTraigaViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, ['TX'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);
  const seenFunctions = new Set();

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    const text = nodeText(call, sourceCode);
    const isAICall = sdkMatch.matched || /\.predict\(|\.score\(/.test(text);
    if (!isAICall) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (seenFunctions.has(func.name)) continue;

    // Proxy presence: WARN only (disparate impact alone insufficient per §552.056(c))
    const consequential = /loan|credit|hir|employ|insur|housing/i.test(func.name);
    const hasProxy = /zip_?code|zipcode|surname|last_?name/i.test(func.text);

    if (consequential && hasProxy) {
      seenFunctions.add(func.name);
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'WARN',
        detail: `Proxy variable in '${func.name}' flagged for human review — under Texas TRAIGA, disparate impact alone is NOT sufficient for liability (§552.056(c)); intent must be shown. Contrast: this same pattern is BLOCK under Illinois HB 3773`,
      }));
    }
  }
  return findings;
}

// ─── RK-CO-ADMT-001 ───────────────────────────────────────────────────────────
// Colorado SB 26-189 — notice/explanation/review for consequential ADMT (WARN, pre-enforcement)

const CO_CONSEQUENTIAL_SIGNALS = /hir|employ|education|enroll|lend|loan|credit|housing|healthcare|insur/i;
const CO_EXCLUDED_SIGNALS = /fraud|cybersecurity|spam|identity_?verif|anti_?money|aml/i;

function detectCoAdmtViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, ['CO'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);
  const seenFunctions = new Set();

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    const text = nodeText(call, sourceCode);
    const isAICall = sdkMatch.matched || /\.predict\(|\.score\(/.test(text);
    if (!isAICall) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (seenFunctions.has(func.name)) continue;
    if (!CO_CONSEQUENTIAL_SIGNALS.test(func.name)) continue;
    if (CO_EXCLUDED_SIGNALS.test(func.name)) continue; // explicit statutory exclusions

    seenFunctions.add(func.name);
    const hasNotice = hasScaffoldCall(func.text, SCAFFOLDS.disclose);
    const hasReview = hasScaffoldCall(func.text, SCAFFOLDS.humanReview);
    if (!hasNotice || !hasReview) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'WARN',
        detail: `Consequential ADMT in '${func.name}' lacks consumer notice and/or human review pathway. Colorado SB 26-189 (eff. Jan 1 2027) — forward-looking gap; enforcement currently pending AG rulemaking`,
      }));
    }
  }
  return findings;
}

// ─── RK-CA-ADMT-001 ───────────────────────────────────────────────────────────
// California CCPA ADMT — significant decisions (advertising EXCLUDED), opt-out path required

const CA_SIGNIFICANT_SIGNALS = /lend|loan|credit|financ|housing|education|enroll|employ|hir|healthcare/i;
const CA_ADVERTISING_SIGNALS = /\bad\b|advertis|adContent|adTargeting|personalizeAd|recommendProduct/i;

function detectCaAdmtViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, ['CA'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);
  const seenFunctions = new Set();

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    const text = nodeText(call, sourceCode);
    const isAICall = sdkMatch.matched || /\.predict\(|\.score\(/.test(text);
    if (!isAICall) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (seenFunctions.has(func.name)) continue;

    // CRITICAL false-positive guard: advertising is EXPLICITLY excluded from "significant decision"
    if (CA_ADVERTISING_SIGNALS.test(func.name)) continue;
    if (!CA_SIGNIFICANT_SIGNALS.test(func.name)) continue;

    seenFunctions.add(func.name);
    const hasNotice = hasScaffoldCall(func.text, SCAFFOLDS.disclose);
    // Opt-out requires a genuine alternative PATH, not just a flag — look for an alternative branch
    const hasAltPath = /optedOut|manualReview|alternativeProcess|manualUnderwriting/.test(func.text);
    const hasReview = hasScaffoldCall(func.text, SCAFFOLDS.humanReview);

    const missing = [];
    if (!hasNotice) missing.push('pre-use notice');
    if (!hasAltPath) missing.push('genuine opt-out alternative path');
    if (!hasReview) missing.push('appeal/human-review');

    if (missing.length > 0) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'WARN',
        detail: `Significant-decision ADMT in '${func.name}' missing: ${missing.join(', ')}. CA CCPA ADMT compliance required by Jan 1 2027 (note: advertising is excluded from this rule)`,
      }));
    }
  }
  return findings;
}

// ─── RK-CA-SB942-001 ──────────────────────────────────────────────────────────
// California content provenance — latent disclosure mandatory, detection tool required

function detectCaSb942Violation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, ['CA'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);

  // Branch: detection tool (project-level, standing obligation)
  const detectionToolUrl = configValue(projectConfig, 'sb942_detection_tool_url') ||
                           configValue(projectConfig, 'provenance_detection_tool_url');

  let foundGenCall = false;
  for (const call of calls) {
    const mediaMatch = matchesMediaGenCall(call, sourceCode);
    if (!mediaMatch.matched || mediaMatch.isNonGen) continue;
    foundGenCall = true;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;

    // Latent disclosure: mandatory by default
    const hasProvenance = hasScaffoldCall(func.text, SCAFFOLDS.provenanceEmbed);
    if (!hasProvenance) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'BLOCK',
        detail: `${mediaMatch.mediaType} generation in '${func.name}' has no provenance/latent disclosure embedded. CA SB 942: latent disclosure is MANDATORY by default (manifest/visible label is the optional one). $5,000/violation/day`,
      }));
    }
  }

  // Detection tool: only relevant if the project actually generates media
  if (foundGenCall && !detectionToolUrl) {
    const firstGenCall = calls.find(c => {
      const m = matchesMediaGenCall(c, sourceCode);
      return m.matched && !m.isNonGen;
    });
    if (firstGenCall) {
      findings.push(makeFinding(rule, filePath, firstGenCall, sourceCode, {
        severity: 'BLOCK',
        detail: `No public provenance detection tool configured (sb942_detection_tool_url). This is a STANDING daily obligation — $5,000/day while absent. Highest-priority fix`,
      }));
    }
  }
  return findings;
}

// ─── RK-WA-HB1170-001 ─────────────────────────────────────────────────────────
// Washington content provenance — reuses SB942 media-gen logic, WA-specific framing

function detectWaHb1170Violation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, ['WA'])) return findings;
  const calls = collectCallExpressions(ast.rootNode);

  for (const call of calls) {
    const mediaMatch = matchesMediaGenCall(call, sourceCode);
    // WA-specific: material-alteration carve-out — skip basic image processing entirely
    if (!mediaMatch.matched || mediaMatch.isNonGen) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;

    const hasProvenance = hasScaffoldCall(func.text, SCAFFOLDS.provenanceEmbed);
    if (!hasProvenance) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'BLOCK',
        detail: `${mediaMatch.mediaType} generation in '${func.name}' lacks provenance data (watermarking/metadata). WA HB 1170 — AG-only enforcement, no private right of action. Effective date flagged ambiguous (Jan 2028 per bill text)`,
      }));
    }
  }
  return findings;
}

// ─── RK-US-CHATBOT-001 ────────────────────────────────────────────────────────
// Multi-state chatbot — Branch A (disclosure) + Branch B (companion safety)

const CHATBOT_STATES = ['CA', 'WA', 'OR', 'NE', 'ID', 'IA', 'GA'];
const TRANSACTIONAL_SIGNALS = /support|faq|orderStatus|ticket|helpdesk/i;

function detectChatbotViolation(rule, ast, sourceCode, filePath, projectConfig) {
  const findings = [];
  if (!jurisdictionApplies(projectConfig, CHATBOT_STATES)) return findings;
  const calls = collectCallExpressions(ast.rootNode);
  const seenFunctions = new Set();

  for (const call of calls) {
    const sdkMatch = matchesAISDKCall(call, sourceCode);
    if (!sdkMatch.matched) continue;

    const func = findEnclosingFunction(call, sourceCode);
    if (!func) continue;
    if (!CHATBOT_FUNCTION_SIGNALS.test(func.name)) continue;
    if (seenFunctions.has(func.name)) continue;
    seenFunctions.add(func.name);

    // Branch A: universal disclosure (applies to nearly all consumer chatbots)
    const hasDisclosure = hasScaffoldCall(func.text, SCAFFOLDS.disclose);
    if (!hasDisclosure) {
      findings.push(makeFinding(rule, filePath, call, sourceCode, {
        severity: 'BLOCK',
        detail: `Chatbot '${func.name}' has no AI-disclosure dispatch. Multi-state laws require disclosing the user is talking to AI (WA: every 3h for adults, 1h for minors)`,
      }));
    }

    // Branch B: companion-AI safety — only if sustained-relationship signals present
    const isCompanion = COMPANION_MEMORY_SIGNALS.test(func.text) && !TRANSACTIONAL_SIGNALS.test(func.name);
    if (isCompanion) {
      const hasCrisisDetection = /crisis|suicid|selfHarm|self_harm|988|crisisClassifier/i.test(func.text);
      if (!hasCrisisDetection) {
        findings.push(makeFinding(rule, filePath, call, sourceCode, {
          severity: 'WARN',
          detail: `Companion AI '${func.name}' (cross-session memory detected) has no crisis-detection/referral. Oregon SB 1546 requires active monitoring + 988 referral + halting companion behavior on crisis signals`,
        }));
      }
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
  'RK-IL-HB3773-001': detectIlHb3773Violation,
  'RK-NYC-LL144-001': detectNycLl144Violation,
  'RK-TX-TRAIGA-001': detectTxTraigaViolation,
  'RK-CO-ADMT-001': detectCoAdmtViolation,
  'RK-CA-ADMT-001': detectCaAdmtViolation,
  'RK-CA-SB942-001': detectCaSb942Violation,
  'RK-WA-HB1170-001': detectWaHb1170Violation,
  'RK-US-CHATBOT-001': detectChatbotViolation,
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
