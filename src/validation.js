const { z } = require('zod');

const phoneRegex = /^\+?\d{7,15}$/;

function parseSchedulingConfig(val) {
  if (val === null || val === undefined) return val;
  let parsed = val;
  if (typeof val === 'string') {
    try {
      parsed = JSON.parse(val);
    } catch (_) {
      return { _invalid_json: true };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { _invalid_json: true };
  }
  return parsed;
}

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
const dateRegex = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function validateInternalConfig(val) {
  if (!val || (val.provider !== 'internal' && val.provider !== 'google-calendar')) return true;

  // Validate services
  if (!Array.isArray(val.services) || val.services.length === 0) return false;
  for (const s of val.services) {
    if (!s.id || !s.name || typeof s.duration !== 'number' || s.duration <= 0) return false;
  }

  // Validate working_hours
  if (!val.working_hours || typeof val.working_hours !== 'object') return false;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let hasWindows = false;
  for (const day of days) {
    const windows = val.working_hours[day];
    if (!windows) continue;
    if (!Array.isArray(windows)) return false;
    for (const w of windows) {
      if (!w.start || !w.end) return false;
      if (!timeRegex.test(w.start) || !timeRegex.test(w.end)) return false;
      if (w.start >= w.end) return false;
      hasWindows = true;
    }
  }
  if (!hasWindows) return false;

  // Validate optional numeric fields
  if (val.slot_interval !== undefined && (typeof val.slot_interval !== 'number' || val.slot_interval <= 0)) return false;
  if (val.buffer_minutes !== undefined && (typeof val.buffer_minutes !== 'number' || val.buffer_minutes < 0)) return false;

  // Validate blocked_dates format
  if (val.blocked_dates !== undefined) {
    if (!Array.isArray(val.blocked_dates)) return false;
    for (const d of val.blocked_dates) {
      if (typeof d !== 'string' || !dateRegex.test(d)) return false;
    }
  }

  return true;
}

const schedulingConfigSchema = z
  .union([z.string(), z.object({}).passthrough()])
  .transform(parseSchedulingConfig)
  .refine((val) => !val?._invalid_json, { message: 'scheduling_config must be valid JSON' })
  .refine((val) => val?._invalid_json || val?.provider, { message: 'scheduling_config must include a provider field' })
  .refine(validateInternalConfig, { message: 'Internal provider requires valid services array and working_hours with at least one day with time windows' });

const createBusinessSchema = z.object({
  name: z.preprocess((v) => v ?? '', z.string().min(1, 'name is required').max(200)),
  phone_number_id: z.string().max(100).optional().nullable(),
  whatsapp_access_token: z.string().max(500).optional().nullable(),
  system_prompt: z.string().max(10000).optional().nullable(),
  website_url: z.string().url().max(2000).optional().nullable().or(z.literal('')),
  gemini_model: z.string().max(100).optional().nullable(),
  boss_language: z.enum(['he', 'ar', 'en']).optional().nullable(),
  boss_telegram_chat_id: z.string().max(100).optional().nullable().or(z.literal('')),
  scheduling_config: schedulingConfigSchema.optional().nullable(),
});

const updateBusinessSchema = z.object({
  name: z.string().min(1).max(200).optional().nullable(),
  phone_number_id: z.string().max(100).optional().nullable(),
  whatsapp_access_token: z.string().max(500).optional().nullable(),
  system_prompt: z.string().max(10000).optional().nullable(),
  website_url: z.string().url().max(2000).optional().nullable().or(z.literal('')),
  gemini_model: z.string().max(100).optional().nullable(),
  boss_language: z.enum(['he', 'ar', 'en']).optional().nullable(),
  boss_telegram_chat_id: z.string().max(100).optional().nullable().or(z.literal('')),
  scheduling_config: schedulingConfigSchema.optional().nullable(),
  waba_id: z.string().max(100).optional().nullable(),
  subscription_plan: z.enum(['trial', 'starter', 'business', 'expired']).optional(),
});

const chatSchema = z.object({
  message: z.preprocess((v) => v ?? '', z.string().min(1, 'message is required').max(5000)),
  phone: z.string().max(50).optional(),
});

const updateCustomerMemorySchema = z.object({
  facts: z.preprocess(
    (v) => (v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) ? v : '__invalid__',
    z.union([
      z.object({
        name: z.string().max(200).optional().nullable(),
        language: z.string().max(50).optional().nullable(),
        notes: z.array(z.string().max(500)).max(20).optional(),
      }).passthrough(),
      z.literal('__invalid__').refine(() => false, { message: 'facts object is required' }),
    ])
  ),
});

const updateKnowledgeGapSchema = z.object({
  status: z.enum(['pending', 'answered', 'dismissed']).optional(),
  answer: z.string().min(1).max(2000).optional(),
}).refine(data => {
  if (data.status === 'answered' && !data.answer) return false;
  return true;
}, { message: 'Answer is required when status is "answered"' });

const whatsappSignupSchema = z.object({
  code: z.string().min(1, 'code is required').max(1000),
  waba_id: z.string().min(1, 'waba_id is required').max(100),
  phone_number_id: z.string().min(1, 'phone_number_id is required').max(100),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues || [];
      const firstError = issues[0];
      if (!firstError) return res.status(400).json({ error: 'Invalid request body' });
      return res.status(400).json({ error: firstError.message });
    }
    req.validated = result.data;
    next();
  };
}

module.exports = {
  validate,
  createBusinessSchema,
  updateBusinessSchema,
  chatSchema,
  updateCustomerMemorySchema,
  updateKnowledgeGapSchema,
  whatsappSignupSchema,
};
