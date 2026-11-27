export type AssistantState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type CompanionMode = 'romantic' | 'jarvis_gf' | 'playful' | 'late_night';

export type SupportedLanguage = 'bn-BD' | 'hi-IN' | 'en-US';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
  audioData?: string;
  mood?: string;
  lang?: SupportedLanguage;
  conversationId?: string;
  inputType?: 'voice' | 'text';
  commandName?: string;
  executionStatus?: string;
}

export interface SystemVitals {
  heartRate: number; // e.g. 74 bpm
  affectionLevel: number; // 0 - 100%
  syncRate: number; // 99.4%
  batteryCore: number; // 98%
  activeMode: CompanionMode;
  selectedAffectionName: string; // Global "Zoni Calls You" selection (default: "Boss")
  userNickname: string; // Compatibility alias
  selectedVoice: string;
  soundFxEnabled: boolean;
  totalInteractions: number;
  loveUnlockedPoints: number;
  activeLanguage: SupportedLanguage;
  voiceAutoPlay: boolean;
  voiceMuted: boolean;
}
