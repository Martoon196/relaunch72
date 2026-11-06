/**
 * Brand configuration. Everything a visitor sees comes from here, so brand #9 is a settings
 * change, not a code change. A webinar's overrides_json deep-merges over its brand's config.
 */
import { deepMerge, parseJson } from './util.js';

export interface FormField {
  name: string;               // answers_json key; name/email/phone are first-class columns
  label: string;
  type: 'text' | 'email' | 'tel' | 'select' | 'textarea' | 'checkbox';
  required?: boolean;
  options?: string[];
}

export interface Theme {
  colors: { primary: string; background: string; surface: string; text: string; muted: string; accent: string };
  font_family: string;
  font_url?: string;
  radius: string;             // CSS length
  button_style: 'solid' | 'outline' | 'pill';
  logo_light?: string;
  logo_dark?: string;
  favicon?: string;
}

export interface BrandSettings {
  identity: { legal_entity?: string };
  domains: { allowed_origins: string[]; hosted_hostname?: string };
  registration: {
    fields: FormField[];
    consent_text: string;
    consent_version: string;
    privacy_url?: string;
    thank_you_redirect_url?: string;
  };
  messaging: { sender_name?: string; sender_email?: string; reminders_min: number[]; templates: Record<string, string> };
  ctas: { default?: { label: string; url: string }; offer_cards?: { title: string; body?: string; url: string; image_url?: string }[] };
  compliance: { risk_warning?: string; recording_notice?: string; financial_promotion?: boolean };
  crm: {
    account_id?: string;
    pipeline_id?: string;
    stage_id?: string;
    tag_prefix: string;
    engaged_threshold_pct: number;
    lead_score: { attended: number; engaged: number; cta_clicked: number; question_asked: number };
  };
  defaults: {
    timezone: string;
    locale: string;
    chat_enabled: boolean;
    qa_moderation: boolean;
    replay_expiry_days: number | null;
    one_device_per_registrant: boolean;
    retention_months: number;
    room_opens_min_before: number;
  };
}

export const DEFAULT_THEME: Theme = {
  colors: { primary: '#1f2937', background: '#ffffff', surface: '#f5f6f8', text: '#111827', muted: '#6b7280', accent: '#2563eb' },
  font_family: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  radius: '10px',
  button_style: 'solid',
};

export const DEFAULT_SETTINGS: BrandSettings = {
  identity: {},
  domains: { allowed_origins: [] },
  registration: {
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'phone', label: 'Phone', type: 'tel', required: false },
    ],
    consent_text: 'I agree to receive emails about this webinar and related content. I can unsubscribe at any time.',
    consent_version: '1',
  },
  messaging: { reminders_min: [1440, 60, 10], templates: {} },
  ctas: {},
  compliance: {},
  crm: {
    tag_prefix: 'webinar',
    engaged_threshold_pct: 50,
    lead_score: { attended: 5, engaged: 20, cta_clicked: 30, question_asked: 10 },
  },
  defaults: {
    timezone: 'Europe/London',
    locale: 'en-GB',
    chat_enabled: true,
    qa_moderation: true,
    replay_expiry_days: null,
    one_device_per_registrant: false,
    retention_months: 24,
    room_opens_min_before: 15,
  },
};

export interface BrandRow {
  id: string;
  slug: string;
  name: string;
  theme_json: string;
  settings_json: string;
  ghq_account_id: string | null;
  created_at: string;
}

export interface ResolvedConfig {
  brand: { id: string; slug: string; name: string };
  theme: Theme;
  settings: BrandSettings;
}

export interface WebinarOverrides {
  theme?: Partial<Theme>;
  settings?: Partial<BrandSettings>;
}

/** Brand config with defaults filled, then the webinar's overrides on top. */
export function resolveConfig(brand: BrandRow, overridesJson?: string | null): ResolvedConfig {
  const theme = deepMerge(DEFAULT_THEME, parseJson(brand.theme_json, {}));
  const settings = deepMerge(DEFAULT_SETTINGS, parseJson(brand.settings_json, {}));
  const ov = parseJson<WebinarOverrides>(overridesJson ?? '', {});
  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name },
    theme: deepMerge(theme, ov.theme ?? {}),
    settings: deepMerge(settings, ov.settings ?? {}),
  };
}

/** What the browser is allowed to see of a brand's config (no CRM ids). */
export function publicConfig(cfg: ResolvedConfig) {
  const s = cfg.settings;
  return {
    brand: cfg.brand,
    theme: cfg.theme,
    registration: {
      fields: s.registration.fields,
      consent_text: s.registration.consent_text,
      consent_version: s.registration.consent_version,
      privacy_url: s.registration.privacy_url ?? null,
      thank_you_redirect_url: s.registration.thank_you_redirect_url ?? null,
    },
    ctas: s.ctas,
    compliance: {
      risk_warning: s.compliance.risk_warning ?? null,
      recording_notice: s.compliance.recording_notice ?? null,
    },
    defaults: {
      timezone: s.defaults.timezone,
      locale: s.defaults.locale,
      chat_enabled: s.defaults.chat_enabled,
      room_opens_min_before: s.defaults.room_opens_min_before,
    },
  };
}
