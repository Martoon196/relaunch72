export interface Theme {
  colors: { primary: string; background: string; surface: string; text: string; muted: string; accent: string };
  font_family: string;
  font_url?: string;
  radius: string;
  button_style: 'solid' | 'outline' | 'pill';
  logo_light?: string;
  logo_dark?: string;
}

export interface FormField { name: string; label: string; type: 'text' | 'email' | 'tel' | 'select' | 'textarea' | 'checkbox'; required?: boolean; options?: string[] }

export interface PublicConfig {
  brand: { id: string; slug: string; name: string };
  theme: Theme;
  registration: { fields: FormField[]; consent_text: string; consent_version: string; privacy_url: string | null; thank_you_redirect_url: string | null };
  ctas: { default?: { label: string; url: string } };
  compliance: { risk_warning: string | null; recording_notice: string | null };
  defaults: { timezone: string; locale: string; chat_enabled: boolean; room_opens_min_before: number };
}

export interface Presenter { name: string; title?: string; bio?: string; photo_url?: string }

export interface WebinarDetail {
  id: string;
  slug: string;
  type: 'live' | 'on_demand' | 'evergreen';
  label: string;
  title: string;
  description: string;
  presenters: Presenter[];
  duration_s: number | null;
  hosted_url?: string;
  agenda?: { time?: string; title: string }[];
  sessions: { id: string; starts_at: string; ends_at: string; status: string }[];
  slots: string[];
  config: PublicConfig;
  server_now: string;
  next_start?: string | null;
  live_now?: boolean;
}

export interface Playback { hls: string; webrtc: string | null; expires_at: string; offset_s: number | null; seekable: boolean; low_latency: boolean }

export interface Cta { id: string; label: string; url: string; style: 'button' | 'card'; body: string | null; image_url: string | null; show_at_s?: number | null; hide_at_s?: number | null; push_mode?: string }
export interface Poll { id: string; question: string; options: string[]; show_at_s?: number | null; show_results?: boolean }

export interface RoomState {
  state: 'scheduled' | 'waiting' | 'live' | 'replay' | 'on_demand' | 'ended' | 'expired' | 'processing';
  label: string;
  opens_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  seekable: boolean;
  access_expires_at: string | null;
}

export interface JoinPayload {
  session_token: string;
  registrant: { id: string; name: string; email: string };
  webinar: WebinarDetail & { handouts: { label: string; url: string }[] };
  session: { id: string; kind: string; starts_at: string | null; ends_at: string | null; status: string };
  room: RoomState;
  playback: Playback | null;
  ws_url: string;
  ctas: Cta[];
  polls: Poll[];
  config: PublicConfig;
  server_now: string;
}

export interface ChatMessage {
  id: string;
  registrant_id: string | null;
  host_id: string | null;
  author_name: string;
  kind: 'chat' | 'question' | 'answer';
  parent_id: string | null;
  body: string;
  status: 'visible' | 'hidden' | 'pinned' | 'pending';
  done_at: string | null;
  created_at: string;
}
