/**
 * RegKit AGENT-1 (Context Classifier) + AGENT-2 (Regulation Mapper)
 *
 * These run FIRST in the pipeline, before any detector. Until now their
 * logic lived scattered inside the detectors (each detector re-checking
 * jurisdiction, industry, etc.). This module makes them explicit pipeline
 * stages, matching RegKit's 7-agent architecture:
 *
 *   AGENT-1 classifies the project: industry, jurisdictions, risk tier,
 *           which AI vendors, whether PHI/financial/biometric data is in play.
 *   AGENT-2 maps that context to the SUBSET of rules that actually apply,
 *           so detectors only run for relevant law (faster, fewer false
 *           positives, and an auditable "why this rule applied" trail).
 *
 * The detectors still carry their own fine-grained guards, but AGENT-2's
 * pre-filter means a CA-only project never even evaluates Texas rules,
 * and the classification is surfaced to the user so they can see the
 * reasoning ("we scanned for these 6 frameworks because your project is
 * healthcare + US + handles PHI").
 */

// ─── AGENT-1: CONTEXT CLASSIFIER ──────────────────────────────────────────────

/**
 * Classifies a project from its regkit.yaml config (and optionally signals
 * detected in code). Returns a structured context object.
 */
function classifyContext(projectConfig, codeSignals = {}) {
  const proj = projectConfig.project || projectConfig;
  const industry = (proj.industry || 'general').toLowerCase();
  const jurisdictions = (proj.jurisdictions || []).map(j => String(j).toUpperCase());
  const vendors = projectConfig.ai_vendors || [];

  // Risk tier inference: high if consequential domains are in play
  const highRiskIndustries = ['healthcare', 'fintech', 'finance', 'lending', 'insurance', 'hr', 'hiring', 'employment'];
  const riskTier = highRiskIndustries.includes(industry) ? 'high' : 'standard';

  // Data categories in play (from config + any code signals passed in)
  const dataCategories = [];
  if (industry === 'healthcare' || codeSignals.phi) dataCategories.push('PHI');
  if (['fintech', 'finance', 'lending'].includes(industry) || codeSignals.credit) dataCategories.push('financial');
  if (codeSignals.biometric) dataCategories.push('biometric');
  if (proj.entity_type === 'financial_institution_glba_covered') dataCategories.push('glba_covered');

  return {
    industry,
    jurisdictions: jurisdictions.length ? jurisdictions : ['UNSPECIFIED'],
    riskTier,
    dataCategories,
    vendors: vendors.map(v => v.vendor),
    entityType: proj.entity_type || null,
    // Whether jurisdiction is unspecified → conservative inclusive scanning
    conservativeMode: jurisdictions.length === 0,
  };
}

// ─── AGENT-2: REGULATION MAPPER ───────────────────────────────────────────────

/**
 * Maps each rule to the jurisdictions/contexts it applies to. This metadata
 * lets AGENT-2 decide whether a rule is even relevant before running its
 * detector. Derived from each rule's id + regulation framework.
 */
const RULE_APPLICABILITY = {
  'RK-HIPAA-001':      { jurisdictions: ['US'], federal: true, industries: ['healthcare'], dataCategories: ['PHI'] },
  'RK-EUAI-014':       { jurisdictions: ['EU', 'US'], federal: true, industries: ['*'], note: 'applies to any high-risk AI with EU exposure' },
  'RK-GDPR-022':       { jurisdictions: ['EU', 'US'], federal: true, industries: ['*'], note: 'applies if any EU data subjects' },
  'RK-CO-ADMT-001':    { jurisdictions: ['CO'], industries: ['*'] },
  'RK-TX-TRAIGA-001':  { jurisdictions: ['TX'], industries: ['*'] },
  'RK-NYC-LL144-001':  { jurisdictions: ['NY', 'NYC'], industries: ['hr', 'hiring', 'employment', '*'] },
  'RK-IL-HB3773-001':  { jurisdictions: ['IL'], industries: ['hr', 'hiring', 'employment', '*'] },
  'RK-CA-ADMT-001':    { jurisdictions: ['CA'], industries: ['*'] },
  'RK-CA-SB942-001':   { jurisdictions: ['CA'], industries: ['*'], note: 'media generation' },
  'RK-US-CHATBOT-001': { jurisdictions: ['CA', 'WA', 'OR', 'NE', 'ID', 'IA', 'GA'], industries: ['*'] },
  'RK-IL-BIPA-001':    { jurisdictions: ['IL'], industries: ['*'], dataCategories: ['biometric'] },
  'RK-US-FCRA-ECOA-001': { jurisdictions: ['US'], federal: true, industries: ['fintech', 'finance', 'lending', '*'], dataCategories: ['financial'] },
  'RK-WA-HB1170-001':  { jurisdictions: ['WA'], industries: ['*'], note: 'media generation' },
};

/**
 * Given the classified context and the loaded rules, returns the subset of
 * rules that apply, each annotated with WHY it applies (for the audit trail).
 */
function mapApplicableRules(context, rules) {
  const applicable = [];
  const excluded = [];

  for (const rule of rules) {
    const appl = RULE_APPLICABILITY[rule.id];
    if (!appl) {
      // Unknown rule → include conservatively
      applicable.push({ rule, reason: 'no applicability metadata — included conservatively' });
      continue;
    }

    // Jurisdiction check
    let jurisdictionMatch = context.conservativeMode; // unspecified → include all
    let matchReason = '';
    if (!jurisdictionMatch) {
      // Federal rules apply to any US jurisdiction (including any US state)
      const usStates = ['CA', 'TX', 'IL', 'NY', 'NYC', 'CO', 'WA', 'OR', 'NE', 'ID', 'IA', 'GA'];
      const projectIsUS = context.jurisdictions.includes('US') ||
                          context.jurisdictions.some(j => usStates.includes(j));
      const projectIsWholeUS = context.jurisdictions.includes('US'); // "US" = nationwide = all states

      if (appl.federal && projectIsUS) {
        jurisdictionMatch = true;
        matchReason = 'federal/cross-border rule, project has US jurisdiction';
      } else if (projectIsWholeUS && appl.jurisdictions.some(j => usStates.includes(j))) {
        // Project declares nationwide US → all US state rules apply (a US-wide
        // product serves residents of every state, so every state law is in play)
        jurisdictionMatch = true;
        matchReason = 'project is nationwide US — this state rule applies to your users there';
      } else {
        // Specific-state project: must explicitly include that state (or EU)
        const hit = appl.jurisdictions.find(j => context.jurisdictions.includes(j));
        if (hit) {
          jurisdictionMatch = true;
          matchReason = `applies in ${hit}`;
        }
      }
    } else {
      matchReason = 'jurisdiction unspecified — included conservatively';
    }

    // GLBA exemption: BIPA doesn't apply to GLBA-covered financial institutions
    if (rule.id === 'RK-IL-BIPA-001' && context.dataCategories.includes('glba_covered')) {
      excluded.push({ ruleId: rule.id, reason: 'GLBA-covered financial institution — BIPA exempt' });
      continue;
    }

    if (jurisdictionMatch) {
      applicable.push({ rule, reason: matchReason });
    } else {
      excluded.push({ ruleId: rule.id, reason: `not applicable to jurisdictions: ${context.jurisdictions.join(', ')}` });
    }
  }

  return { applicable, excluded };
}

/** Produces a human-readable summary of the classification + mapping */
function summarize(context, mapping) {
  const lines = [];
  lines.push(`Context: ${context.industry} industry, jurisdictions: ${context.jurisdictions.join(', ')}, risk tier: ${context.riskTier}`);
  if (context.dataCategories.length) lines.push(`Data in play: ${context.dataCategories.join(', ')}`);
  lines.push(`Applicable rules: ${mapping.applicable.length} of ${mapping.applicable.length + mapping.excluded.length}`);
  if (context.conservativeMode) {
    lines.push('(Jurisdiction unspecified — scanning conservatively against all rules. Set jurisdictions in regkit.yaml to narrow.)');
  }
  return lines.join('\n');
}

module.exports = {
  classifyContext,
  mapApplicableRules,
  summarize,
  RULE_APPLICABILITY,
};
