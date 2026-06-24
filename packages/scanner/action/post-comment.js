#!/usr/bin/env node
/**
 * RegKit GitHub Action — PR comment poster
 *
 * Reads RegKit's JSON scan output (from stdin or a file) and posts a
 * formatted compliance report as a comment on the pull request, then sets
 * the action's exit code so the PR gate blocks on BLOCK findings.
 *
 * Uses only the GitHub REST API via the token GitHub injects automatically
 * (GITHUB_TOKEN) — no extra dependencies, no third-party action needed.
 *
 * Environment (all provided automatically by GitHub Actions):
 *   GITHUB_TOKEN        - auth token for posting the comment
 *   GITHUB_REPOSITORY   - "owner/repo"
 *   GITHUB_EVENT_PATH   - path to the event payload (contains PR number)
 *   REGKIT_RESULT_FILE  - path to the JSON output file (set by the workflow)
 */

const fs = require('fs');
const https = require('https');

function readResult() {
  const file = process.env.REGKIT_RESULT_FILE;
  if (file && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  // Fallback: read from stdin
  const stdin = fs.readFileSync(0, 'utf8');
  return JSON.parse(stdin);
}

const SEVERITY_EMOJI = { BLOCK: '🔴', WARN: '🟡', INFO: '🔵' };

function buildComment(result) {
  const { summary, findings, agent3Mode } = result;
  const lines = [];

  lines.push('## 🛡️ RegKit Compliance Scan');
  lines.push('');

  if (summary.passed) {
    lines.push('✅ **No blocking compliance violations found.**');
    if (summary.warn > 0) {
      lines.push('');
      lines.push(`There ${summary.warn === 1 ? 'is' : 'are'} ${summary.warn} warning${summary.warn === 1 ? '' : 's'} worth reviewing below, but none block this merge.`);
    }
  } else {
    lines.push(`🔴 **${summary.block} blocking violation${summary.block === 1 ? '' : 's'} must be resolved before merge.**`);
  }
  lines.push('');
  lines.push(`| 🔴 BLOCK | 🟡 WARN | 🔵 INFO |`);
  lines.push(`|---|---|---|`);
  lines.push(`| ${summary.block} | ${summary.warn} | ${summary.info} |`);
  lines.push('');

  if (findings.length > 0) {
    lines.push('### Findings');
    lines.push('');
    for (const f of findings) {
      const emoji = SEVERITY_EMOJI[f.severity] || '';
      lines.push(`#### ${emoji} ${f.severity} — \`${f.ruleId}\``);
      lines.push('');
      lines.push(`**${f.ruleName}**`);
      lines.push('');
      lines.push(`- **Where:** \`${f.file}\`:${f.line} in \`${f.function}()\``);
      if (f.detail) lines.push(`- **Why:** ${f.detail}`);
      if (f.citation) lines.push(`- **Citation:** ${f.citation}`);
      if (f.agent3) {
        const verdictEmoji = f.agent3.verdict === 'CONFIRMED' ? '✅'
                           : f.agent3.verdict === 'DISMISSED' ? '⬜'
                           : '⚠️';
        lines.push(`- **AGENT-3 legal reasoning:** ${verdictEmoji} ${f.agent3.verdict} (${Math.round((f.agent3.confidence || 0) * 100)}% confidence) — ${f.agent3.reasoning}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  const modeNote = agent3Mode === 'live'
    ? '_Legal reasoning by Claude (AGENT-3, live)._'
    : agent3Mode === 'mock'
    ? '_Legal reasoning in mock mode — set `ANTHROPIC_API_KEY` as a repo secret for live Claude reasoning._'
    : '_Pattern detection only — add `--reason` to enable AGENT-3 legal reasoning._';
  lines.push(modeNote);
  lines.push('');
  lines.push('_RegKit is a compliance-intelligence tool, not legal advice. [Learn more](https://github.com/rodgutie/regkit)._');

  return lines.join('\n');
}

function getPrNumber() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  return (event.pull_request && event.pull_request.number) ||
         (event.issue && event.issue.number) || null;
}

function postComment(body) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = getPrNumber();

    if (!token || !repo || !prNumber) {
      // Not in a PR context (e.g. push to main, or local run) — just print and skip posting
      console.log('\n[RegKit] Not in a PR context or missing token — printing report instead of posting:\n');
      console.log(body);
      return resolve({ posted: false });
    }

    const payload = JSON.stringify({ body });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues/${prNumber}/comments`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'regkit-action',
        'Accept': 'application/vnd.github+json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[RegKit] Posted compliance report to PR #' + prNumber);
          resolve({ posted: true });
        } else {
          console.error('[RegKit] Failed to post comment: ' + res.statusCode + ' ' + data.slice(0, 200));
          // Don't fail the whole action just because commenting failed
          resolve({ posted: false });
        }
      });
    });
    req.on('error', (err) => {
      console.error('[RegKit] Comment post error: ' + err.message);
      resolve({ posted: false });
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  let result;
  try {
    result = readResult();
  } catch (err) {
    console.error('[RegKit] Could not read scan result JSON: ' + err.message);
    process.exit(2);
  }

  const comment = buildComment(result);
  await postComment(comment);

  // The gate: exit 1 if there are BLOCK findings so the check fails and merge is blocked
  process.exit(result.summary.block > 0 ? 1 : 0);
}

main();
