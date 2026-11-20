export interface CapacitorConfig {
  appId: string;
  appName: string;
  webDir: string;
  server?: {
    androidScheme?: string;
    cleartext?: boolean;
    url?: string;
  };
  android?: {
    allowMixedContent?: boolean;
    webContentsDebuggingEnabled?: boolean;
  };
  [key: string]: any;
}

const config: CapacitorConfig = {
  appId: 'com.zoni.jarvis.assistant',
  appName: 'Zoni AI',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
