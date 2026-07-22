// TODO: Update this module to use the new IndexedDB storage.

/**
 * Draft an outreach email based on given settings and parameters.
 * 
 * @param {Object} settings - App/email settings object
 * @param {Object} params - Parameter object; expects at minimum:
 *    {
 *      job,           // job object/info to target email to
 *      resumeText,    // string: resume text to reference
 *      ...otherFields // any additional user or context data
 *    }
 * @returns {Object} { subject, body }
 */

export function draftEmail(settings, params) {
  // This is a placeholder for the actual LLM API call or templating
  const jobTitle = params?.job?.title || "the position";
  const company = params?.job?.company || "the company";
  const applicantName = settings?.profile?.name || "Applicant";
  const resumeSummary = (params?.resumeText || "").slice(0, 200);

  return {
    subject: `Application for ${jobTitle} at ${company}`,
    body: `Hi,

I'm reaching out to express my interest in the ${jobTitle} role at ${company}. My relevant experience is highlighted in my resume below:

"${resumeSummary}..."

Thank you for your time and consideration.

Best,
${applicantName}`
  };
}