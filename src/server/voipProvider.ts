/**
 * VoIP / SIP Provider Abstraction for Zoni AI Hybrid Calling.
 *
 * Supports Twilio Programmable Voice / SIP Media Streams when configured via
 * server environment variables. When credentials are missing, it NEVER
 * fabricates a completed external call — it returns a clear, verifiable
 * `provider_not_configured` status with setup requirements.
 */

export type VoipProviderKind = 'twilio' | 'sip_webhook' | 'unconfigured';

export interface VoipProviderStatus {
  provider: VoipProviderKind;
  configured: boolean;
  callerId?: string;
  sipTrunkUri?: string;
  missingEnvVars: string[];
  legalDisclosureRequired: boolean;
}

export interface OutboundVoipCallRequest {
  sessionId: string;
  toNumber: string;
  purpose: string;
  disclosureScript: string;
  callbackBaseUrl: string;
  language: string;
}

export interface VoipCallStartResult {
  started: boolean;
  provider: VoipProviderKind;
  providerCallSid?: string;
  errorCode?: 'provider_not_configured' | 'provider_request_failed' | 'invalid_number';
  errorMessage?: string;
  missingEnvVars?: string[];
}

export interface VoipCallActionResult {
  success: boolean;
  provider: VoipProviderKind;
  message: string;
}

export interface VoipProviderAdapter {
  getStatus(): VoipProviderStatus;
  startOutboundCall(req: OutboundVoipCallRequest): Promise<VoipCallStartResult>;
  transferToHuman(providerCallSid: string, humanNumber: string): Promise<VoipCallActionResult>;
  endCall(providerCallSid: string): Promise<VoipCallActionResult>;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class TwilioVoipProvider implements VoipProviderAdapter {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly streamWssUrl?: string
  ) {}

  getStatus(): VoipProviderStatus {
    return {
      provider: 'twilio',
      configured: true,
      callerId: this.fromNumber,
      missingEnvVars: [],
      legalDisclosureRequired: true,
    };
  }

  async startOutboundCall(req: OutboundVoipCallRequest): Promise<VoipCallStartResult> {
    if (!req.toNumber || !/^\+?\d{7,15}$/.test(req.toNumber.replace(/\s+/g, ''))) {
      return {
        started: false,
        provider: 'twilio',
        errorCode: 'invalid_number',
        errorMessage: 'A valid E.164 destination phone number is required.',
      };
    }

    const sayText = escapeXml(req.disclosureScript);
    const streamSection = this.streamWssUrl
      ? `<Connect><Stream url="${escapeXml(this.streamWssUrl)}"><Parameter name="sessionId" value="${escapeXml(req.sessionId)}" /></Stream></Connect>`
      : '';
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${sayText}</Say>${streamSection}</Response>`;

    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls.json`;
    const authHeader = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const params = new URLSearchParams({
      To: req.toNumber,
      From: this.fromNumber,
      Twiml: twiml,
    });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.sid) {
        return {
          started: false,
          provider: 'twilio',
          errorCode: 'provider_request_failed',
          errorMessage: payload?.message || `Twilio API returned HTTP ${response.status}`,
        };
      }

      return {
        started: true,
        provider: 'twilio',
        providerCallSid: String(payload.sid),
      };
    } catch (err: any) {
      return {
        started: false,
        provider: 'twilio',
        errorCode: 'provider_request_failed',
        errorMessage: err?.message || 'Failed to contact Twilio Programmable Voice API.',
      };
    }
  }

  async transferToHuman(providerCallSid: string, humanNumber: string): Promise<VoipCallActionResult> {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(providerCallSid)}.json`;
    const authHeader = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Transferring you now to the user.</Say><Dial>${escapeXml(humanNumber)}</Dial></Response>`;
    const params = new URLSearchParams({ Twiml: twiml });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      if (!response.ok) {
        return {
          success: false,
          provider: 'twilio',
          message: `Transfer failed with HTTP ${response.status}`,
        };
      }
      return {
        success: true,
        provider: 'twilio',
        message: 'Call transferred to human user via Twilio.',
      };
    } catch (err: any) {
      return {
        success: false,
        provider: 'twilio',
        message: err?.message || 'Twilio transfer request failed.',
      };
    }
  }

  async endCall(providerCallSid: string): Promise<VoipCallActionResult> {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(providerCallSid)}.json`;
    const authHeader = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const params = new URLSearchParams({ Status: 'completed' });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      if (!response.ok) {
        return {
          success: false,
          provider: 'twilio',
          message: `Call termination returned HTTP ${response.status}`,
        };
      }
      return {
        success: true,
        provider: 'twilio',
        message: 'Twilio VoIP call terminated.',
      };
    } catch (err: any) {
      return {
        success: false,
        provider: 'twilio',
        message: err?.message || 'Twilio termination request failed.',
      };
    }
  }
}

export class SipWebhookVoipProvider implements VoipProviderAdapter {
  constructor(
    private readonly sipTrunkUri: string,
    private readonly sipWebhookUrl: string,
    private readonly sipBearerToken?: string
  ) {}

  getStatus(): VoipProviderStatus {
    return {
      provider: 'sip_webhook',
      configured: true,
      sipTrunkUri: this.sipTrunkUri,
      missingEnvVars: [],
      legalDisclosureRequired: true,
    };
  }

  async startOutboundCall(req: OutboundVoipCallRequest): Promise<VoipCallStartResult> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.sipBearerToken) {
        headers.Authorization = `Bearer ${this.sipBearerToken}`;
      }
      const response = await fetch(this.sipWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'start_call',
          sipTrunkUri: this.sipTrunkUri,
          ...req,
        }),
      });
      const data: any = await response.json().catch(() => ({}));
      if (!response.ok || !data?.callId) {
        return {
          started: false,
          provider: 'sip_webhook',
          errorCode: 'provider_request_failed',
          errorMessage: data?.error || `SIP bridge returned HTTP ${response.status}`,
        };
      }
      return {
        started: true,
        provider: 'sip_webhook',
        providerCallSid: String(data.callId),
      };
    } catch (err: any) {
      return {
        started: false,
        provider: 'sip_webhook',
        errorCode: 'provider_request_failed',
        errorMessage: err?.message || 'Failed to contact SIP gateway webhook.',
      };
    }
  }

  async transferToHuman(providerCallSid: string, humanNumber: string): Promise<VoipCallActionResult> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.sipBearerToken) headers.Authorization = `Bearer ${this.sipBearerToken}`;
      const response = await fetch(this.sipWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'transfer', callId: providerCallSid, humanNumber }),
      });
      return {
        success: response.ok,
        provider: 'sip_webhook',
        message: response.ok ? 'SIP transfer signal sent.' : `SIP transfer failed (HTTP ${response.status})`,
      };
    } catch (err: any) {
      return { success: false, provider: 'sip_webhook', message: err?.message || 'SIP transfer error.' };
    }
  }

  async endCall(providerCallSid: string): Promise<VoipCallActionResult> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.sipBearerToken) headers.Authorization = `Bearer ${this.sipBearerToken}`;
      const response = await fetch(this.sipWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'end_call', callId: providerCallSid }),
      });
      return {
        success: response.ok,
        provider: 'sip_webhook',
        message: response.ok ? 'SIP call ended.' : `SIP end failed (HTTP ${response.status})`,
      };
    } catch (err: any) {
      return { success: false, provider: 'sip_webhook', message: err?.message || 'SIP hangup error.' };
    }
  }
}

export class UnconfiguredVoipProvider implements VoipProviderAdapter {
  private readonly missing = [
    'VOIP_PROVIDER (twilio | sip_webhook)',
    'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER (or SIP_TRUNK_URI + SIP_GATEWAY_WEBHOOK_URL)',
  ];

  getStatus(): VoipProviderStatus {
    return {
      provider: 'unconfigured',
      configured: false,
      missingEnvVars: this.missing,
      legalDisclosureRequired: true,
    };
  }

  async startOutboundCall(): Promise<VoipCallStartResult> {
    return {
      started: false,
      provider: 'unconfigured',
      errorCode: 'provider_not_configured',
      errorMessage:
        'External AI VoIP calling is not configured on the backend. Configure Twilio or a SIP gateway in server environment variables. Zoni AI never fabricates external PSTN/VoIP calls.',
      missingEnvVars: this.missing,
    };
  }

  async transferToHuman(): Promise<VoipCallActionResult> {
    return {
      success: false,
      provider: 'unconfigured',
      message: 'No external VoIP provider configured to transfer an active call.',
    };
  }

  async endCall(): Promise<VoipCallActionResult> {
    return {
      success: true,
      provider: 'unconfigured',
      message: 'Local call session marked ended.',
    };
  }
}

export function createVoipProviderFromEnv(env: NodeJS.ProcessEnv = process.env): VoipProviderAdapter {
  const mode = (env.VOIP_PROVIDER || '').trim().toLowerCase();

  if (mode === 'twilio' || (!mode && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER)) {
    if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER) {
      return new TwilioVoipProvider(
        env.TWILIO_ACCOUNT_SID.trim(),
        env.TWILIO_AUTH_TOKEN.trim(),
        env.TWILIO_PHONE_NUMBER.trim(),
        env.TWILIO_MEDIA_STREAM_WSS?.trim()
      );
    }
  }

  if (mode === 'sip_webhook' || (!mode && env.SIP_TRUNK_URI && env.SIP_GATEWAY_WEBHOOK_URL)) {
    if (env.SIP_TRUNK_URI && env.SIP_GATEWAY_WEBHOOK_URL) {
      return new SipWebhookVoipProvider(
        env.SIP_TRUNK_URI.trim(),
        env.SIP_GATEWAY_WEBHOOK_URL.trim(),
        env.SIP_GATEWAY_BEARER_TOKEN?.trim()
      );
    }
  }

  return new UnconfiguredVoipProvider();
}
