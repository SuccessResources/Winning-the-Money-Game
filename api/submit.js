/**
 * /api/submit.js
 * Vercel Serverless Function
 *
 * Receives quiz completion data → saves to Airtable → tags in ActiveCampaign
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    firstName,
    lastName,
    email,
    pattern,
    patternName,
    secondary,
    scores,
    dims,
    answers,
    completedAt,
  } = req.body;

  // ── Validation ──────────────────────────────────
  if (!email || !firstName || !pattern) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const results = await Promise.allSettled([
    saveToAirtable({ firstName, lastName, email, pattern, patternName, secondary, scores, dims, answers, completedAt }),
    addToActiveCampaign({ firstName, lastName, email, pattern, patternName }),
  ]);

  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason?.message);

  if (errors.length === 2) {
    // Both failed
    console.error("Both integrations failed:", errors);
    return res.status(500).json({ error: "Submission failed", details: errors });
  }

  return res.status(200).json({ success: true, pattern, patternName });
}

/* ══════════════════════════════════════════════════
   AIRTABLE
   Required env vars:
     AIRTABLE_API_KEY   — your personal access token
     AIRTABLE_BASE_ID   — starts with "app..."
     AIRTABLE_TABLE_ID  — starts with "tbl..." or table name
══════════════════════════════════════════════════ */
async function saveToAirtable(data) {
  const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID } = process.env;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) {
    console.warn("Airtable env vars not set — skipping");
    return;
  }

  const fields = {
    "First Name":    data.firstName,
    "Last Name":     data.lastName,
    "Email":         data.email,
    "Pattern":       data.patternName,
    "Pattern Key":   data.pattern,
    "Secondary Pattern": data.secondary,
    "Awareness Score":      data.dims?.aw ?? "",
    "Planning Score":       data.dims?.pl ?? "",
    "Action Score":         data.dims?.ac ?? "",
    "Wealth Build Score":   data.dims?.wb ?? "",
    "Control Score":        data.dims?.ct ?? "",
    "Resilience Score":     data.dims?.rs ?? "",
    "Avoider Votes":        data.scores?.A ?? 0,
    "Guardian Votes":       data.scores?.G ?? 0,
    "Pleasure Seeker Votes": data.scores?.P ?? 0,
    "Builder Votes":        data.scores?.B ?? 0,
    "Completed At":  data.completedAt,
  };

  const response = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_ID)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Airtable error: ${JSON.stringify(err)}`);
  }

  return response.json();
}

/* ══════════════════════════════════════════════════
   ACTIVECAMPAIGN
   Required env vars:
     AC_BASE_URL   — e.g. https://youraccountname.api-us1.com
     AC_API_KEY    — your AC API key

   This function:
   1. Creates or updates the contact
   2. Adds a tag matching their pattern (e.g. "pattern-avoider")
   3. Adds them to the correct automation (map pattern → automation ID below)
══════════════════════════════════════════════════ */

// Map pattern keys to your ActiveCampaign automation IDs
// Update these IDs after you create the automations in AC
const AUTOMATION_IDS = {
  avoider:       process.env.AC_AUTOMATION_AVOIDER       || null,
  guardian:      process.env.AC_AUTOMATION_GUARDIAN      || null,
  pleasureseeker: process.env.AC_AUTOMATION_PLEASURE     || null,
  builder:       process.env.AC_AUTOMATION_BUILDER       || null,
};

async function addToActiveCampaign({ firstName, lastName, email, pattern, patternName }) {
  const { AC_BASE_URL, AC_API_KEY } = process.env;

  if (!AC_BASE_URL || !AC_API_KEY) {
    console.warn("ActiveCampaign env vars not set — skipping");
    return;
  }

  const headers = {
    "Api-Token": AC_API_KEY,
    "Content-Type": "application/json",
  };

  // 1. Create or update contact
  const contactRes = await fetch(`${AC_BASE_URL}/api/3/contacts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contact: {
        email,
        firstName,
        lastName,
        fieldValues: [
          // Custom field: money pattern (create this field in AC first)
          // { field: "YOUR_FIELD_ID", value: patternName }
        ],
      },
    }),
  });

  if (!contactRes.ok) {
    const err = await contactRes.json();
    throw new Error(`AC contact error: ${JSON.stringify(err)}`);
  }

  const { contact } = await contactRes.json();
  const contactId = contact.id;

  // 2. Add pattern tag
  const tagName = `pattern-${pattern}`;

  // First, get or create the tag
  const tagRes = await fetch(`${AC_BASE_URL}/api/3/tags`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tag: { tag: tagName, tagType: "contact", description: `Money Pattern: ${patternName}` } }),
  });

  let tagId;
  if (tagRes.ok) {
    const tagData = await tagRes.json();
    tagId = tagData.tag?.id;
  }

  // Apply tag to contact
  if (tagId) {
    await fetch(`${AC_BASE_URL}/api/3/contactTags`, {
      method: "POST",
      headers,
      body: JSON.stringify({ contactTag: { contact: contactId, tag: tagId } }),
    });
  }

  // 3. Enrol in pattern-specific automation
  const automationId = AUTOMATION_IDS[pattern];
  if (automationId) {
    await fetch(`${AC_BASE_URL}/api/3/contactAutomations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contactAutomation: {
          contact: contactId,
          automation: automationId,
        },
      }),
    });
  }

  return { contactId, tagId };
}
