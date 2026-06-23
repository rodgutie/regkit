const mlModel = require('./ml');
// Texas credit decision with zip code proxy — should be WARN (intent-based)
async function evaluateCreditApplication(applicant) {
  const score = await mlModel.predict([applicant.zipCode, applicant.income]);
  return score > 0.5;
}
module.exports = { evaluateCreditApplication };
