/**
 * RegKit Scanner — Core Engine
 *
 * Loads RegKit YAML rule definitions and scans JavaScript/TypeScript
 * source files using tree-sitter AST analysis to detect AI compliance
 * violations.
 *
 * This is the MVP scanner — it implements the AGENT-1 (context) +
 * AGENT-2 (regulation match) + a simplified AGENT-3 (pattern detection)
 * pipeline as deterministic AST pattern matching. The full agentic
 * reasoning layer (real legal interpretation via Claude) gets wired in
 * as a second pass — this scanner's job is to find CANDIDATE locations
 * worth flagging, fast and free, before any LLM call happens.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript').typescript;

// ─── RULE LOADING ────────────────────────────────────────────────────────────

/**
 * Loads all RegKit rule YAML files from a directory.
 * Each rule file is expected to have: id, name, severity, detection, message
 */
function loadRules(rulesDir) {
  const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const rules = [];

  for (const file of files) {
    const fullPath = path.join(rulesDir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = yaml.load(content);
      if (parsed && parsed.id) {
        rules.push({ ...parsed, _sourceFile: file });
      }
    } catch (err) {
      console.error(`Failed to parse rule file ${file}: ${err.message}`);
    }
  }

  return rules;
}

// ─── AST PARSING ─────────────────────────────────────────────────────────────

function parseSource(sourceCode, filePath) {
  const parser = new Parser();
  const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
  parser.setLanguage(isTS ? TypeScript : JavaScript);
  return parser.parse(sourceCode);
}

// ─── DETECTION HELPERS ───────────────────────────────────────────────────────

/**
 * Known AI/ML vendor SDK call patterns RegKit recognizes across rules.
 * Extend this list as new vendors/SDKs are added to rule definitions.
 */
const AI_SDK_CALL_PATTERNS = [
  { vendor: 'openai', patterns: ['openai.chat.completions.create', 'openai.responses.create'] },
  { vendor: 'anthropic', patterns: ['anthropic.messages.create'] },
  { vendor: 'google', patterns: ['genAI.generateContent', 'google.generativeai'] },
  { vendor: 'cohere', patterns: ['cohere.chat'] },
  { vendor: 'generic_ml', patterns: ['mlModel.predict', 'mlModel.score', 'model.predict', 'llm.complete'] },
];

/** Variable-name heuristics for sensitive data categories, reused across rules */
const SENSITIVE_VARIABLE_PATTERNS = {
  phi: /patient|diagnosis|medical_?record|health_?record|treatment|prescription|mrn/i,
  biometric: /fingerprint|face_?geometry|iris_?scan|retina|voiceprint|biometric/i,
  financial_proxy: /zip_?code|zipcode|postal_?code/i,
  credit: /credit_?score|creditscore|consumer_?report/i,
};

/** Walks the AST collecting every call_expression node with its full text */
function collectCallExpressions(node, results = []) {
  if (node.type === 'call_expression') {
    results.push(node);
  }
  for (let i = 0; i < node.childCount; i++) {
    collectCallExpressions(node.child(i), results);
  }
  return results;
}

/** Gets the textual representation of a node from the original source */
function nodeText(node, sourceCode) {
  return sourceCode.slice(node.startIndex, node.endIndex);
}

/** Checks if a call expression matches any known AI SDK pattern */
function matchesAISDKCall(callNode, sourceCode) {
  const text = nodeText(callNode, sourceCode);
  for (const { vendor, patterns } of AI_SDK_CALL_PATTERNS) {
    for (const pattern of patterns) {
      if (text.includes(pattern.split('(')[0])) {
        return { vendor, pattern, matched: true };
      }
    }
  }
  return { matched: false };
}

/** Scans a function's full text for sensitive variable name patterns */
function findSensitiveDataSignals(functionText) {
  const signals = [];
  for (const [category, regex] of Object.entries(SENSITIVE_VARIABLE_PATTERNS)) {
    if (regex.test(functionText)) {
      signals.push(category);
    }
  }
  return signals;
}

/** Finds the enclosing function for a given node, returns its full text + name */
function findEnclosingFunction(node, sourceCode) {
  let current = node;
  while (current) {
    if (
      current.type === 'function_declaration' ||
      current.type === 'arrow_function' ||
      current.type === 'function_expression' ||
      current.type === 'method_definition'
    ) {
      return {
        node: current,
        text: nodeText(current, sourceCode),
        name: extractFunctionName(current, sourceCode),
      };
    }
    current = current.parent;
  }
  return null;
}

function extractFunctionName(funcNode, sourceCode) {
  // Try common patterns: function_declaration has a 'name' field
  const nameNode = funcNode.childForFieldName && funcNode.childForFieldName('name');
  if (nameNode) return nodeText(nameNode, sourceCode);

  // For arrow functions assigned to a variable: const foo = async () => {...}
  if (funcNode.parent && funcNode.parent.type === 'variable_declarator') {
    const idNode = funcNode.parent.childForFieldName('name');
    if (idNode) return nodeText(idNode, sourceCode);
  }
  return '<anonymous>';
}

/** Checks whether specific scaffold calls (e.g. regkit.humanReviewGate) exist anywhere in given text */
function hasScaffoldCall(text, scaffoldPatterns) {
  return scaffoldPatterns.some(p => text.includes(p));
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  loadRules,
  parseSource,
  collectCallExpressions,
  nodeText,
  matchesAISDKCall,
  findSensitiveDataSignals,
  findEnclosingFunction,
  hasScaffoldCall,
  AI_SDK_CALL_PATTERNS,
  SENSITIVE_VARIABLE_PATTERNS,
};
