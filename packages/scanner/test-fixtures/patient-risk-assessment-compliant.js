// test-fixtures/patient-risk-assessment-compliant.js
// Same business logic, but with RegKit's suggested fixes applied —
// proves the scanner correctly clears compliant code, not just flags bad code

const db = require('./db');
const anthropic = require('./anthropic-client'); // switched vendor: BAA signed
const regkit = require('./regkit-sdk');

async function assessPatientRisk(patientId) {
  const record = await db.patients.findById(patientId);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: `Assess risk for diagnosis: ${record.diagnosis}` }]
  });

  const aiRecommendation = response.content[0].text;

  const reviewedDecision = await regkit.humanReviewGate({
    recommendation: aiRecommendation,
    context: { patientId, model: 'claude-sonnet-4-6' }
  });

  return reviewedDecision;
}

async function evaluateLoanApplication(applicant) {
  const decision = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: `Approve or deny: ${JSON.stringify(applicant)}` }]
  });

  const finalDecision = await regkit.humanReviewGate({
    recommendation: decision,
    context: { applicantId: applicant.id }
  });

  if (finalDecision.approved) {
    issueLoan(applicant.id);
  }
  return finalDecision;
}

function issueLoan(applicantId) {
  console.log(`Loan issued for ${applicantId}`);
}

module.exports = { assessPatientRisk, evaluateLoanApplication };
