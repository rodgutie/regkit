/**
 * RegKit Engine — in-memory scan API
 *
 * The CLI scans files on disk. The VS Code extension needs to scan the
 * buffer the developer is currently editing — which may be unsaved — and
 * get back findings with precise line/column positions to draw squiggles.
 *
 * This module exposes that single-source scan path, reusing the exact same
 * detectors and rules as the CLI. No detection logic is duplicated: the
 * extension is a thin presentation layer over this engine.
 */

const path = require('path');
const { loadRules, parseSource } = require('./core');
const { runDetector } = require('./detectors');
const { runAgent3 } = require('./agent3');

let cachedRules = null;
let cachedRulesDir = null;

function getRules(rulesDir) {
  if (cachedRules && cachedRulesDir === rulesDir) return cachedRules;
  cachedRules = loadRules(rulesDir);
  cachedRulesDir = rulesDir;
  return cachedRules;
}

/**
 * Scans a single in-memory source string.
 * @param {string} sourceCode  - the (possibly unsaved) buffer contents
 * @param {string} filePath    - the file's path (used for language detection + reporting)
 * @param {object} projectConfig - parsed regkit.yaml (or {})
 * @param {string} rulesDir    - directory of rule YAMLs
 * @returns {Array} findings with {ruleId, severity, line, column, endColumn, message, ...}
 */
function scanSource(sourceCode, filePath, projectConfig, rulesDir) {
  const rules = getRules(rulesDir);
  let ast;
  try {
    ast = parseSource(sourceCode, filePath);
  } catch (err) {
    return [];
  }

  const findings = [];
  for (const rule of rules) {
    const result = runDetector(rule, ast, sourceCode, filePath, projectConfig);
    if (result.status === 'OK') {
      findings.push(...result.findings);
    }
  }
  return findings;
}

/**
 * Optional AGENT-3 second pass over findings from a single buffer.
 * Used by the extension's "explain this finding" command (on demand,
 * not on every keystroke, since it may call the API).
 */
async function reasonOverFindings(findings, rulesDir, sourceCode, options = {}) {
  const rules = getRules(rulesDir);
  const ruleMap = {};
  for (const r of rules) ruleMap[r.id] = r;

  const codeContextFor = (finding) => {
    const lines = sourceCode.split('\n');
    const start = Math.max(0, finding.line - 3);
    const end = Math.min(lines.length, finding.line + 6);
    return lines.slice(start, end).join('\n');
  };

  const { results, mode } = await runAgent3(findings, ruleMap, codeContextFor, options);
  return { results, mode };
}

function invalidateRuleCache() {
  cachedRules = null;
  cachedRulesDir = null;
}

module.exports = { scanSource, reasonOverFindings, invalidateRuleCache };
