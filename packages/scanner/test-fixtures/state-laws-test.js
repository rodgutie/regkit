// test-fixtures/state-laws-test.js
// Exercises the 8 newly-wired detectors: IL-HB3773, NYC-LL144, TX-TRAIGA,
// CO-ADMT, CA-ADMT, CA-SB942, WA-HB1170, US-CHATBOT

const mlModel = require('./ml');
const openai = require('./openai-client');
const imageGenModel = require('./imagegen');
const regkit = require('./regkit-sdk');

// ── IL-HB3773 + NYC-LL144 + TX-TRAIGA: hiring AI with zip code ──
// Should: BLOCK in IL (zip proxy + no notice), BLOCK in NYC (no audit/notice),
//         WARN in TX (proxy alone insufficient — intent needed)
async function screenJobApplicant(applicant) {
  const features = [applicant.zipCode, applicant.experience];
  const score = await mlModel.predict(features);
  return score > 0.5 ? 'advance' : 'reject';
}

// ── CA-SB942 + WA-HB1170: image generation with no provenance ──
// Should: BLOCK in CA (no latent disclosure + no detection tool), BLOCK in WA
async function generateMarketingImage(prompt) {
  const image = await imageGenModel.generate(prompt);
  await uploadToCDN(image);
  return image;
}

// ── CA-SB942 false-positive guard: basic resize must NOT trigger ──
async function resizeProfilePhoto(photo, size) {
  return await imageProcessor.resize(photo, size);
}

// ── US-CHATBOT Branch A: support bot, no disclosure ──
// Should: BLOCK (no AI disclosure). Should NOT trigger Branch B (transactional).
async function handleSupportChat(userMessage) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: userMessage }]
  });
  return response.choices[0].message.content;
}

// ── US-CHATBOT Branch A + B: companion bot, no disclosure, no crisis detection ──
// Should: BLOCK (no disclosure) + WARN (companion, no crisis detection)
async function companionChat(userId, message) {
  const history = await db.getConversationHistory(userId);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'system', content: 'You are a caring companion' }, ...history, { role: 'user', content: message }]
  });
  return response.choices[0].message.content;
}

// ── CA-ADMT false-positive guard: advertising is EXCLUDED ──
// Should NOT trigger CA-ADMT (advertising explicitly excluded from "significant decision")
async function personalizeAdContent(userId) {
  const adPreferences = await mlModel.predict(userId);
  return selectAd(adPreferences);
}

module.exports = { screenJobApplicant, generateMarketingImage, resizeProfilePhoto, handleSupportChat, companionChat, personalizeAdContent };
