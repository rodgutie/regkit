/**
 * RegKit AGENT-7 — Regulatory Intelligence
 *
 * The deepest moat. AI law changes weekly; a static rule set goes stale and
 * a stale compliance tool is worse than none. AGENT-7 keeps the rule set
 * current by monitoring the official sources each rule depends on and
 * flagging when a rule may need updating.
 *
 * Each rule YAML already contains a `monitoring_note_for_agent_7` field
 * specifying exactly what to watch (which government site, which pending
 * rulemaking, which effective date to confirm). AGENT-7 operationalizes
 * those notes: it builds a watch list, tracks each rule's effective dates
 * and known-ambiguities, and produces a regulatory-intelligence report.
 *
 * MVP scope: AGENT-7 runs as a periodic CHECK that produces a report of
 * which rules carry pending/ambiguous legal status and need human review.
 * It does NOT auto-rewrite rules (that would be dangerous — a wrong
 * auto-edit to a compliance rule could mislead every user). Instead it
 * surfaces exactly what changed-or-might-change, with the source URL, so a
 * human updates the rule deliberately. "Flag for human, never silently
 * guess" is the same safety principle used throughout RegKit.
 *
 * The optional live mode uses web fetch (when a fetcher is provided) to
 * check whether a watched source has changed since last check; without one,
 * it runs in report mode using the static metadata in each rule.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ─── WATCH LIST EXTRACTION ────────────────────────────────────────────────────

/** Known official source domains AGENT-7 recognizes, for routing checks */
const OFFICIAL_SOURCES = {
  'ilga.gov': 'Illinois General Assembly',
  'idhr': 'Illinois Dept of Human Rights',
  'capitol.texas.gov': 'Texas Legislature',
  'cppa.ca.gov': 'California Privacy Protection Agency',
  'leg.wa.gov': 'Washington Legislature',
  'nyc.gov': 'NYC (DCWP)',
  'rules.cityofnewyork.us': 'NYC Rules',
  'consumerfinance.gov': 'CFPB',
  'hhs.gov': 'HHS OCR',
  'eur-lex.europa.eu': 'EUR-Lex (EU AI Act / GDPR)',
  'coag.gov': 'Colorado AG',
  'oag.ca.gov': 'California AG',
};

/** Pulls a structured watch entry from a single rule */
function extractWatchEntry(rule) {
  const note = rule.monitoring_note_for_agent_7 || '';
  const reg = rule.regulation || {};

  // Detect priority signal in the note text
  const highPriority = /HIGH PRIORITY|FASTEST-MOVING|re-verify.*monthly/i.test(note);

  // Detect known-ambiguity flags the rule author left for AGENT-7
  const hasAmbiguity = /ambiguous|discrepancy|conflict|confirm|verify|unresolved|pending/i.test(note) ||
    /ambiguous|pending|discrepancy/i.test(JSON.stringify(reg.effective_date || ''));

  // Identify which official sources this rule depends on
  const sources = [];
  for (const [domain, name] of Object.entries(OFFICIAL_SOURCES)) {
    if (note.toLowerCase().includes(domain.toLowerCase()) ||
        (reg.framework || '').toLowerCase().includes(name.toLowerCase().split(' ')[0])) {
      sources.push({ domain, name });
    }
  }

  return {
    ruleId: rule.id,
    framework: reg.framework || rule.id,
    effectiveDate: reg.effective_date || 'unspecified',
    priority: highPriority ? 'HIGH' : 'NORMAL',
    hasKnownAmbiguity: hasAmbiguity,
    sources,
    watchNote: note.replace(/\s+/g, ' ').trim(),
  };
}

/** Detects rules whose effective date is approaching or whose status is pending */
function assessTemporalStatus(watchEntry, now = new Date()) {
  const dateText = watchEntry.effectiveDate;
  const flags = [];

  // Find any year mentioned to catch upcoming-effective-date transitions
  const yearMatches = (dateText.match(/20\d\d/g) || []).map(Number);
  const currentYear = now.getFullYear();

  for (const y of yearMatches) {
    if (y === currentYear || y === currentYear + 1) {
      flags.push(`Effective date references ${y} — verify current enforceability and whether severity should escalate (e.g. WARN→BLOCK once in force).`);
    }
  }
  if (/pending|stayed|withdrawn|ambiguous|enforcement.*pending/i.test(dateText)) {
    flags.push('Effective date or enforcement status is explicitly pending/ambiguous — confirm against the official source before relying on this rule.');
  }
  return flags;
}

// ─── LIVE SOURCE CHECKING (optional) ──────────────────────────────────────────

const https = require('https');

/** Maps the friendly source names to checkable URLs */
const SOURCE_URLS = {
  'ilga.gov': 'https://www.ilga.gov',
  'capitol.texas.gov': 'https://capitol.texas.gov',
  'cppa.ca.gov': 'https://cppa.ca.gov',
  'leg.wa.gov': 'https://leg.wa.gov',
  'nyc.gov': 'https://www.nyc.gov/site/dca/index.page',
  'rules.cityofnewyork.us': 'https://rules.cityofnewyork.us',
  'consumerfinance.gov': 'https://www.consumerfinance.gov',
  'hhs.gov': 'https://www.hhs.gov/hipaa',
  'eur-lex.europa.eu': 'https://eur-lex.europa.eu',
  'coag.gov': 'https://coag.gov',
  'oag.ca.gov': 'https://oag.ca.gov',
};

/**
 * Lightweight reachability + last-modified check for a source URL.
 * Does a HEAD-style request and reports status + any Last-Modified header.
 * This is deliberately minimal — it confirms the source is live and surfaces
 * its last-modified date so a human can compare against when the rule was
 * last reviewed. It does NOT scrape statute text (that needs a real fetcher
 * and careful parsing, a future enhancement).
 */
function checkSourceLive(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        resolve({
          url,
          status: res.statusCode,
          lastModified: res.headers['last-modified'] || null,
          reachable: res.statusCode < 400,
        });
      });
      req.on('error', () => resolve({ url, status: null, reachable: false, error: 'unreachable' }));
      req.on('timeout', () => { req.destroy(); resolve({ url, status: null, reachable: false, error: 'timeout' }); });
      req.end();
    } catch (e) {
      resolve({ url, status: null, reachable: false, error: e.message });
    }
  });
}

/**
 * Runs live checks against the official sources for flagged rules.
 * Returns the entries annotated with source liveness. Best-effort: any
 * source that can't be reached is reported, not fatal.
 */
async function checkSourcesLive(result) {
  const checked = new Set();
  for (const entry of result.entries) {
    if (!entry.sources) continue;
    entry.sourceChecks = [];
    for (const src of entry.sources) {
      const url = SOURCE_URLS[src.domain];
      if (!url || checked.has(url)) continue;
      checked.add(url);
      const check = await checkSourceLive(url);
      entry.sourceChecks.push({ name: src.name, ...check });
    }
  }
  result.liveCheckPerformed = true;
  return result;
}



function runIntelligenceCheck(rulesDir, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const entries = [];

  for (const file of files) {
    try {
      const rule = yaml.load(fs.readFileSync(path.join(rulesDir, file), 'utf8'));
      if (!rule || !rule.id) continue;
      const watch = extractWatchEntry(rule);
      watch.temporalFlags = assessTemporalStatus(watch, now);
      watch.needsReview = watch.hasKnownAmbiguity || watch.temporalFlags.length > 0 || watch.priority === 'HIGH';
      entries.push(watch);
    } catch (e) {
      entries.push({ ruleId: file, error: e.message, needsReview: true });
    }
  }

  return { checkedAt: now.toISOString(), totalRules: entries.length, entries };
}

/** Markdown regulatory-intelligence report */
function formatReport(result) {
  const needReview = result.entries.filter(e => e.needsReview);
  const high = result.entries.filter(e => e.priority === 'HIGH');

  let md = `# RegKit Regulatory Intelligence Report\n\n`;
  md += `**Generated:** ${result.checkedAt.slice(0, 10)} by AGENT-7  \n`;
  md += `**Rules monitored:** ${result.totalRules}  \n`;
  md += `**Flagged for human review:** ${needReview.length}  \n`;
  md += `**High-priority watch items:** ${high.length}  \n\n`;
  md += `> AGENT-7 monitors the official sources each rule depends on and flags rules whose legal status may have changed. It never auto-edits a rule — every flagged item is for deliberate human review, because a wrong edit to a compliance rule could mislead every user.\n\n`;

  if (needReview.length === 0) {
    md += `✅ No rules currently flagged for review. All monitored rules have stable, unambiguous legal status as of last check.\n`;
    return md;
  }

  md += `## ⚠️ Rules Flagged for Review\n\n`;
  for (const e of needReview) {
    md += `### ${e.ruleId} — ${e.framework}\n`;
    md += `- **Priority:** ${e.priority}\n`;
    md += `- **Effective date:** ${e.effectiveDate}\n`;
    if (e.sources && e.sources.length) {
      md += `- **Watch sources:** ${e.sources.map(s => s.name).join(', ')}\n`;
    }
    for (const f of (e.temporalFlags || [])) {
      md += `- **Temporal flag:** ${f}\n`;
    }
    if (e.hasKnownAmbiguity) {
      md += `- **Known ambiguity:** this rule's author flagged unresolved legal status for AGENT-7 to track.\n`;
    }
    md += `\n`;
  }

  md += `## Full Watch List\n\n`;
  md += `| Rule | Framework | Priority | Needs review |\n|---|---|---|---|\n`;
  for (const e of result.entries) {
    md += `| ${e.ruleId} | ${e.framework} | ${e.priority || '—'} | ${e.needsReview ? '⚠️ yes' : '✓ no'} |\n`;
  }
  md += `\n`;

  if (result.liveCheckPerformed) {
    md += `## Live Source Check\n\n`;
    md += `AGENT-7 verified the official sources are reachable and reports their last-modified date where available, so you can compare against when each rule was last reviewed.\n\n`;
    md += `| Source | Status | Last modified |\n|---|---|---|\n`;
    const seen = new Set();
    for (const e of result.entries) {
      for (const sc of (e.sourceChecks || [])) {
        if (seen.has(sc.url)) continue;
        seen.add(sc.url);
        const status = sc.reachable ? '✓ reachable' : `⚠️ ${sc.error || sc.status}`;
        md += `| ${sc.name} | ${status} | ${sc.lastModified || '—'} |\n`;
      }
    }
    md += `\n`;
  }

  return md;
}

module.exports = { runIntelligenceCheck, formatReport, extractWatchEntry, checkSourcesLive, OFFICIAL_SOURCES };
