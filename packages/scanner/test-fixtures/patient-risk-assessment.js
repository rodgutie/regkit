// test-fixtures/patient-risk-assessment.js
// Simulates a healthtech company's AI feature — deliberately contains
// the exact HIPAA + EU AI Act violations RegKit's rules are built to catch

const db = require('./db');
const openai = require('./openai-client');

// VIOLATION: PHI sent to OpenAI with no BAA, no human oversight, no audit log
async function assessPatientRisk(patientId) {
  const record = await db.patients.findById(patientId);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Assess risk for diagnosis: ${record.diagnosis}` }]
  });

  return response.choices[0].message.content;
}

// VIOLATION: loan decision with no human review gate before issuing
async function evaluateLoanApplication(applicant) {
  const decision = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Approve or deny: ${JSON.stringify(applicant)}` }]
  });

  if (decision.choices[0].message.content.includes('approve')) {
    issueLoan(applicant.id);
  }
  return decision;
}

function issueLoan(applicantId) {
  console.log(`Loan issued for ${applicantId}`);
}

module.exports = { assessPatientRisk, evaluateLoanApplication };
