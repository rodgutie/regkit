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

const { loadRules, parseSource } = require('./core');
const { runDetector } = require('./detectors');

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
}

function scan(targetPath, rulesDir, configPath) {
  console.log(chalk.bold.cyan('\n  RegKit Scan\n'));

  const rules = loadRules(rulesDir);
  console.log(chalk.gray(`Loaded ${rules.length} rules from ${rulesDir}`));

  const projectConfig = loadProjectConfig(configPath);
  const files = findSourceFiles(targetPath);
  console.log(chalk.gray(`Scanning ${files.length} source file(s) in ${targetPath}\n`));

  const allFindings = [];
  const detectorStats = { OK: 0, NO_DETECTOR_WIRED: 0, ERROR: 0 };
  const wiredRuleIds = new Set();
  const unwiredRuleIds = new Set();

  for (const file of files) {
    const sourceCode = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parseSource(sourceCode, file);
    } catch (err) {
      console.error(chalk.red(`Failed to parse ${file}: ${err.message}`));
      continue;
    }

    for (const rule of rules) {
      const result = runDetector(rule, ast, sourceCode, file, projectConfig);
      detectorStats[result.status] = (detectorStats[result.status] || 0) + 1;
      if (result.status === 'OK') wiredRuleIds.add(rule.id);
      if (result.status === 'NO_DETECTOR_WIRED') unwiredRuleIds.add(rule.id);
      allFindings.push(...result.findings);
    }
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

  console.log(chalk.gray(`Rules with active detectors: ${wiredRuleIds.size} (${Array.from(wiredRuleIds).join(', ')})`));
  if (unwiredRuleIds.size > 0) {
    console.log(chalk.gray(`Rules loaded but not yet wired to a detector (MVP scope): ${unwiredRuleIds.size}`));
    console.log(chalk.dim(`  ${Array.from(unwiredRuleIds).join(', ')}`));
  }
  console.log('');

  return { findings: allFindings, blockCount, warnCount, infoCount };
}

// ─── CLI ENTRY ────────────────────────────────────────────────────────────────

function main() {
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

  const result = scan(targetPath, rulesDir, configPath);

  // Exit code 1 if any BLOCK findings — this is what makes the PR gate work later
  process.exit(result.blockCount > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { scan, findSourceFiles, loadProjectConfig };
