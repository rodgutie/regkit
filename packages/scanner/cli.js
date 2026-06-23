#!/usr/bin/env node
/**
 * RegKit CLI — `regkit scan <path>`
 *
 * The actual working MVP scanner. Reads regkit.yaml project config,
 * loads rules from rules/, parses target source files with tree-sitter,
 * and reports findings.
 *
 * Usage:
 *   node cli.js scan <file-or-directory> [--rules <rules-dir>] [--config <regkit.yaml>]
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');

const { loadRules, parseSource, findEnclosingFunction } = require('./core');
const { runDetector } = require('./detectors');
const { runAgent3 } = require('./agent3');

function loadProjectConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.warn(chalk.yellow(`No regkit.yaml found at ${configPath} — using empty config (all vendor BAAs assumed unsigned, no industry context)`));
    return {};
  }
  const content = fs.readFileSync(configPath, 'utf8');
  return yaml.load(content) || {};
}

function findSourceFiles(targetPath, extensions = ['.js', '.ts', '.jsx', '.tsx']) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return extensions.some(ext => targetPath.endsWith(ext)) ? [targetPath] : [];
  }

  const results = [];
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(...findSourceFiles(fullPath, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

const SEVERITY_COLOR = {
  BLOCK: chalk.bgRed.white.bold,
  WARN: chalk.bgYellow.black.bold,
  INFO: chalk.bgBlue.white.bold,
};

function printFinding(finding) {
  const colorFn = SEVERITY_COLOR[finding.severity] || chalk.white;
  console.log('');
  console.log(`${colorFn(' ' + finding.severity + ' ')} ${chalk.bold(finding.ruleId)} — ${finding.ruleName}`);
  console.log(`  ${chalk.gray(finding.file)}:${chalk.cyan(finding.line)} in function ${chalk.magenta(finding.functionName)}`);
  if (finding.detail) console.log(`  ${chalk.white(finding.detail)}`);
  if (finding.citation) console.log(`  ${chalk.gray('Citation: ' + finding.citation)}`);
  console.log(`  ${chalk.dim(finding.codeSnippet.split('\n')[0].slice(0, 80))}`);
  if (finding.agent3) {
    const a = finding.agent3;
    const verdictColor = a.verdict === 'CONFIRMED' ? chalk.red
                       : a.verdict === 'DISMISSED' ? chalk.green
                       : chalk.yellow;
    const tag = a._mock ? chalk.dim('[mock]') : chalk.cyan('[Claude]');
    console.log(`  ${chalk.bold('AGENT-3')} ${tag} ${verdictColor(a.verdict)} ${chalk.gray('(confidence ' + Math.round((a.confidence || 0) * 100) + '%)')}`);
    console.log(`    ${chalk.italic.gray(a.reasoning)}`);
  }
}

async function scan(targetPath, rulesDir, configPath, options = {}) {
  console.log(chalk.bold.cyan('\n  RegKit Scan\n'));

  const rules = loadRules(rulesDir);
  console.log(chalk.gray(`Loaded ${rules.length} rules from ${rulesDir}`));

  const ruleMap = {};
  for (const r of rules) ruleMap[r.id] = r;

  const projectConfig = loadProjectConfig(configPath);
  const files = findSourceFiles(targetPath);
  console.log(chalk.gray(`Scanning ${files.length} source file(s) in ${targetPath}\n`));

  const allFindings = [];
  const detectorStats = { OK: 0, NO_DETECTOR_WIRED: 0, ERROR: 0 };
  const wiredRuleIds = new Set();
  const unwiredRuleIds = new Set();
  const fileSources = {}; // path -> { sourceCode, ast } for AGENT-3 context retrieval

  for (const file of files) {
    const sourceCode = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parseSource(sourceCode, file);
    } catch (err) {
      console.error(chalk.red(`Failed to parse ${file}: ${err.message}`));
      continue;
    }
    fileSources[file] = { sourceCode, ast };

    for (const rule of rules) {
      const result = runDetector(rule, ast, sourceCode, file, projectConfig);
      detectorStats[result.status] = (detectorStats[result.status] || 0) + 1;
      if (result.status === 'OK') wiredRuleIds.add(rule.id);
      if (result.status === 'NO_DETECTOR_WIRED') unwiredRuleIds.add(rule.id);
      allFindings.push(...result.findings);
    }
  }

  // ─── AGENT-3 SECOND PASS (optional, only on flagged candidates) ───
  let agent3Mode = null;
  if (options.reason && allFindings.length > 0) {
    console.log(chalk.cyan(`\nAGENT-3: reasoning over ${allFindings.length} candidate finding(s)...\n`));

    // Provides the enclosing-function source as context for each finding
    const codeContextFor = (finding) => {
      const fileData = fileSources[finding.file];
      if (!fileData) return finding.codeSnippet || '';
      // Find the line's node and walk up to its function for fuller context
      const lines = fileData.sourceCode.split('\n');
      const start = Math.max(0, finding.line - 3);
      const end = Math.min(lines.length, finding.line + 6);
      return lines.slice(start, end).join('\n');
    };

    const agent3Result = await runAgent3(allFindings, ruleMap, codeContextFor, options);
    // Replace findings with AGENT-3-annotated versions (dismissed ones filtered out)
    allFindings.length = 0;
    allFindings.push(...agent3Result.results);
    agent3Mode = agent3Result.mode;
  }

  // Sort: BLOCK first, then WARN, then INFO
  const severityOrder = { BLOCK: 0, WARN: 1, INFO: 2 };
  allFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  for (const finding of allFindings) {
    printFinding(finding);
  }

  const blockCount = allFindings.filter(f => f.severity === 'BLOCK').length;
  const warnCount = allFindings.filter(f => f.severity === 'WARN').length;
  const infoCount = allFindings.filter(f => f.severity === 'INFO').length;

  console.log('\n' + chalk.bold('─'.repeat(60)));
  console.log(chalk.bold(`\n  Summary: ${chalk.red(blockCount + ' BLOCK')}  ${chalk.yellow(warnCount + ' WARN')}  ${chalk.blue(infoCount + ' INFO')}\n`));

  if (agent3Mode) {
    const modeLabel = agent3Mode === 'live'
      ? chalk.cyan('live Claude reasoning')
      : chalk.dim('mock reasoning (set ANTHROPIC_API_KEY for live Claude)');
    console.log(chalk.gray(`AGENT-3 ran in: `) + modeLabel + '\n');
  }

  console.log(chalk.gray(`Rules with active detectors: ${wiredRuleIds.size} (${Array.from(wiredRuleIds).join(', ')})`));
  if (unwiredRuleIds.size > 0) {
    console.log(chalk.gray(`Rules loaded but not yet wired to a detector (MVP scope): ${unwiredRuleIds.size}`));
    console.log(chalk.dim(`  ${Array.from(unwiredRuleIds).join(', ')}`));
  }
  console.log('');

  return { findings: allFindings, blockCount, warnCount, infoCount, agent3Mode };
}

// ─── CLI ENTRY ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'scan') {
    console.log('Usage: regkit scan <path> [--rules <dir>] [--config <file>]');
    process.exit(1);
  }

  const targetPath = args[1];
  if (!targetPath) {
    console.error(chalk.red('Error: provide a file or directory to scan'));
    process.exit(1);
  }

  const rulesIdx = args.indexOf('--rules');
  const configIdx = args.indexOf('--config');
  const rulesDir = rulesIdx > -1 ? args[rulesIdx + 1] : path.join(__dirname, 'rules');
  const configPath = configIdx > -1 ? args[configIdx + 1] : path.join(path.dirname(targetPath), 'regkit.yaml');

  const options = {
    reason: args.includes('--reason'),       // run AGENT-3 second pass
    forceMock: args.includes('--mock'),      // force mock even if a key exists
    includeAll: args.includes('--all'),      // keep DISMISSED findings in output
  };

  const result = await scan(targetPath, rulesDir, configPath, options);

  // Exit code 1 if any BLOCK findings — this is what makes the PR gate work later
  process.exit(result.blockCount > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error(chalk.red('Fatal: ' + err.message));
    process.exit(2);
  });
}

module.exports = { scan, findSourceFiles, loadProjectConfig };
