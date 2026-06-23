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

/** Media-generation SDK call patterns (image/video/audio) for provenance rules */
const MEDIA_GEN_SDK_PATTERNS = [
  'imageGenModel.generate', 'videoGenModel.generate', 'audioGenModel.generate',
  'dalle', 'dall-e', 'stableDiffusion', 'stable_diffusion', 'runway',
  'elevenlabs', 'voiceSynthesis', 'generateImage', 'generateVideo', 'generateAudio',
];

/** Basic non-generative image ops that must NOT trigger provenance rules (material-alteration carve-out) */
const NON_GENERATIVE_IMAGE_OPS = [
  'resize', 'crop', 'compress', 'colorCorrect', 'brightness', 'rotate', 'denoise', 'upscale',
];

/** Detects a media-generation call, returns {matched, mediaType, isNonGen} */
function matchesMediaGenCall(callNode, sourceCode) {
  const text = nodeText(callNode, sourceCode);
  const isNonGen = NON_GENERATIVE_IMAGE_OPS.some(op => text.toLowerCase().includes(op.toLowerCase()));
  for (const pattern of MEDIA_GEN_SDK_PATTERNS) {
    if (text.toLowerCase().includes(pattern.toLowerCase().split('.')[0])) {
      let mediaType = 'media';
      if (/image|dalle|dall-e|diffusion/i.test(text)) mediaType = 'image';
      else if (/video|runway/i.test(text)) mediaType = 'video';
      else if (/audio|voice|elevenlabs/i.test(text)) mediaType = 'audio';
      return { matched: true, mediaType, isNonGen };
    }
  }
  return { matched: false };
}

/** Chatbot interface signals — function names suggesting a conversational endpoint */
const CHATBOT_FUNCTION_SIGNALS = /chat|conversation|companion|assistant|message|dialogue|reply/i;

/** Cross-session memory signals (distinguishes companion AI from transactional bots) */
const COMPANION_MEMORY_SIGNALS = /getConversationHistory|conversationHistory|getMemory|userHistory|persona|relationship/i;

/** Checks if any jurisdiction in config matches a target set (unspecified = conservative include) */
function jurisdictionApplies(projectConfig, targetStates) {
  const jurisdictions = projectConfig.jurisdictions ||
    (projectConfig.project && projectConfig.project.jurisdictions) || [];
  if (jurisdictions.length === 0) return true;
  const upper = jurisdictions.map(j => String(j).toUpperCase());
  if (upper.includes('US') || upper.includes('ALL')) return true;
  return targetStates.some(s => upper.includes(s.toUpperCase()));
}

/** Reads a value from project config, tolerating flat or nested-under-project shapes */
function configValue(projectConfig, key) {
  if (projectConfig[key] !== undefined) return projectConfig[key];
  if (projectConfig.project && projectConfig.project[key] !== undefined) return projectConfig.project[key];
  return undefined;
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
  matchesMediaGenCall,
  jurisdictionApplies,
  configValue,
  AI_SDK_CALL_PATTERNS,
  SENSITIVE_VARIABLE_PATTERNS,
  MEDIA_GEN_SDK_PATTERNS,
  CHATBOT_FUNCTION_SIGNALS,
  COMPANION_MEMORY_SIGNALS,
};
