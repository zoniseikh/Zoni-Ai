/**
 * Optional, Consent-Based, Strictly On-Device Speaker Verification Engine (TypeScript mirror).
 *
 * Mirrors `SpeakerVerificationEngine.kt` 1:1 for web/WebView runtime and automated unit testing.
 *
 * Privacy & Safety Guarantees:
 * - Disabled by default until explicit user consent + enrollment (>= 3 voice samples).
 * - Strictly local: voiceprint features are NEVER transmitted to Gemini or any cloud API.
 * - Single primary user only: never identifies, tags, or tracks nearby people.
 * - Safe fallback: uncertain scores NEVER silently discard legitimate user commands.
 */

export type SpeakerVerificationOutcome =
  | 'DISABLED'
  | 'NOT_ENROLLED'
  | 'INSUFFICIENT_SPEECH'
  | 'VERIFIED_PRIMARY'
  | 'UNCERTAIN_FALLBACK_ALLOW'
  | 'REJECTED_NON_PRIMARY';

export interface SpeakerVerificationConfig {
  enabled: boolean;
  strictMode: boolean;
  acceptThreshold: number;
  uncertainThreshold: number;
  minVoicedMs: number;
  requiredEnrollmentSamples: number;
}

export const DEFAULT_SPEAKER_VERIFICATION_CONFIG: SpeakerVerificationConfig = {
  enabled: false,
  strictMode: false,
  acceptThreshold: 0.78,
  uncertainThreshold: 0.56,
  minVoicedMs: 220,
  requiredEnrollmentSamples: 3,
};

export interface SpeakerVoiceprint {
  version: number;
  sampleCount: number;
  meanFeatures: number[];
  stdFeatures: number[];
  meanPitchHz: number;
  pitchStdHz: number;
  enrolledAtMs: number;
}

export interface AcousticEmbedding {
  features: number[];
  estimatedPitchHz: number;
  voicedMs: number;
  averageRms: number;
}

export interface SpeakerVerificationResult {
  outcome: SpeakerVerificationOutcome;
  similarityScore: number;
  shouldAllowCommand: boolean;
  usedSafeFallback: boolean;
  voicedMs: number;
  reason: string;
}

export const SPEAKER_SAMPLE_RATE = 16000;
const FRAME_SIZE = 320; // 20ms at 16kHz
const NUM_BANDS = 12;
const FEATURE_DIM = 16;

// 12 Mel-spaced center frequencies from 130 Hz to 3550 Hz capturing vocal tract formants (F1..F4)
const MEL_BAND_CENTERS_HZ = [
  130, 210, 310, 430, 580, 770, 1010, 1310, 1690, 2170, 2790, 3550,
];

const HANN_WINDOW = Float32Array.from({ length: FRAME_SIZE }, (_, i) =>
  0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1)))
);

function computeGoertzelPower(frame: Float32Array, targetFreqHz: number): number {
  const omega = (2 * Math.PI * targetFreqHz) / SPEAKER_SAMPLE_RATE;
  const coeff = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < frame.length; i++) {
    const windowed = frame[i] * HANN_WINDOW[i];
    q0 = coeff * q1 - q2 + windowed;
    q2 = q1;
    q1 = q0;
  }
  const power = q1 * q1 + q2 * q2 - q1 * q2 * coeff;
  return Math.max(0, power);
}

function estimatePitchHz(frame: Float32Array): number {
  const minLag = Math.max(20, Math.floor(SPEAKER_SAMPLE_RATE / 380)); // ~42
  const maxLag = Math.min(frame.length - 1, Math.floor(SPEAKER_SAMPLE_RATE / 75)); // ~213
  let zeroLagEnergy = 0;
  for (let i = 0; i < frame.length; i++) {
    zeroLagEnergy += frame[i] * frame[i];
  }
  if (zeroLagEnergy < 1e-6) return 0;

  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = frame.length - lag;
    for (let idx = 0; idx < limit; idx++) {
      corr += frame[idx] * frame[idx + lag];
    }
    const normalized = corr / zeroLagEnergy;
    if (normalized > bestCorr) {
      bestCorr = normalized;
      bestLag = lag;
    }
  }
  return bestLag > 0 && bestCorr >= 0.25 ? SPEAKER_SAMPLE_RATE / bestLag : 0;
}

/**
 * Extracts a 16-D vocal-tract + prosodic acoustic embedding from 16kHz Float32 or Int16 PCM.
 */
export function extractSpeakerEmbedding(
  samples: Float32Array | Int16Array
): AcousticEmbedding | null {
  const isInt16 = samples instanceof Int16Array;
  const totalLen = samples.length;
  if (totalLen < FRAME_SIZE) return null;

  const bandAccum = new Float64Array(NUM_BANDS);
  let weightSum = 0;
  let pitchSum = 0;
  let pitchWeight = 0;
  let centroidSum = 0;
  let rolloffSum = 0;
  let zcrSum = 0;
  let rmsSum = 0;
  let voicedFrames = 0;

  const frameFloats = new Float32Array(FRAME_SIZE);

  for (let offset = 0; offset + FRAME_SIZE <= totalLen; offset += FRAME_SIZE) {
    let sumSq = 0;
    let zeroCrossings = 0;
    let prev = isInt16 ? samples[offset] / 32768 : samples[offset];

    for (let i = 0; i < FRAME_SIZE; i++) {
      const f = isInt16 ? samples[offset + i] / 32768 : samples[offset + i];
      frameFloats[i] = f;
      sumSq += f * f;
      if ((f >= 0 && prev < 0) || (f < 0 && prev >= 0)) {
        zeroCrossings++;
      }
      prev = f;
    }

    const rms = Math.sqrt(sumSq / FRAME_SIZE);
    const zcr = zeroCrossings / FRAME_SIZE;

    if (rms >= 0.012 && zcr >= 0.008 && zcr <= 0.42) {
      voicedFrames++;
      rmsSum += rms;
      const frameWeight = rms;
      weightSum += frameWeight;

      const bandEnergies = new Float64Array(NUM_BANDS);
      let totalBandEnergy = 1e-12;
      for (let b = 0; b < NUM_BANDS; b++) {
        const e = computeGoertzelPower(frameFloats, MEL_BAND_CENTERS_HZ[b]);
        bandEnergies[b] = e;
        totalBandEnergy += e;
      }

      let weightedFreqSum = 0;
      let cumulative = 0;
      let rolloffHz = MEL_BAND_CENTERS_HZ[NUM_BANDS - 1];
      let rolloffFound = false;
      for (let b = 0; b < NUM_BANDS; b++) {
        const rel = bandEnergies[b] / totalBandEnergy;
        const logRel = Math.log(rel + 1e-6);
        bandAccum[b] += logRel * frameWeight;
        weightedFreqSum += rel * MEL_BAND_CENTERS_HZ[b];
        cumulative += rel;
        if (!rolloffFound && cumulative >= 0.85) {
          rolloffHz = MEL_BAND_CENTERS_HZ[b];
          rolloffFound = true;
        }
      }

      centroidSum += (weightedFreqSum / 4000) * frameWeight;
      rolloffSum += (rolloffHz / 4000) * frameWeight;
      zcrSum += (zcr / 0.5) * frameWeight;

      const pitchHz = estimatePitchHz(frameFloats);
      if (pitchHz >= 75 && pitchHz <= 380) {
        pitchSum += pitchHz * frameWeight;
        pitchWeight += frameWeight;
      }
    }
  }

  const voicedMs = Math.floor((voicedFrames * FRAME_SIZE * 1000) / SPEAKER_SAMPLE_RATE);
  if (voicedFrames < 3 || weightSum <= 0) {
    return null;
  }

  const features = new Array<number>(FEATURE_DIM).fill(0);
  const avgBands = new Array<number>(NUM_BANDS);
  let bandMean = 0;
  for (let b = 0; b < NUM_BANDS; b++) {
    avgBands[b] = bandAccum[b] / weightSum;
    bandMean += avgBands[b];
  }
  bandMean /= NUM_BANDS;

  let bandVar = 1e-6;
  for (let b = 0; b < NUM_BANDS; b++) {
    const d = avgBands[b] - bandMean;
    bandVar += d * d;
  }
  const bandStd = Math.max(0.25, Math.sqrt(bandVar / NUM_BANDS));
  for (let b = 0; b < NUM_BANDS; b++) {
    features[b] = (avgBands[b] - bandMean) / bandStd;
  }

  const estPitch = pitchWeight > 0 ? pitchSum / pitchWeight : 160;
  features[12] = Math.max(0, Math.min(1, (estPitch - 75) / 305));
  features[13] = Math.max(0, Math.min(1, centroidSum / weightSum));
  features[14] = Math.max(0, Math.min(1, rolloffSum / weightSum));
  features[15] = Math.max(0, Math.min(1, zcrSum / weightSum));

  return {
    features,
    estimatedPitchHz: estPitch,
    voicedMs,
    averageRms: rmsSum / voicedFrames,
  };
}

export function buildSpeakerVoiceprint(
  embeddings: AcousticEmbedding[],
  minSamples: number = 3
): SpeakerVoiceprint | null {
  if (embeddings.length < minSamples) return null;
  const mean = new Array<number>(FEATURE_DIM).fill(0);
  const std = new Array<number>(FEATURE_DIM).fill(0);
  let pitchMean = 0;

  for (const emb of embeddings) {
    for (let i = 0; i < FEATURE_DIM; i++) {
      mean[i] += emb.features[i];
    }
    pitchMean += emb.estimatedPitchHz;
  }
  const n = embeddings.length;
  for (let i = 0; i < FEATURE_DIM; i++) mean[i] /= n;
  pitchMean /= n;

  let pitchVar = 0;
  for (const emb of embeddings) {
    for (let i = 0; i < FEATURE_DIM; i++) {
      const diff = emb.features[i] - mean[i];
      std[i] += diff * diff;
    }
    const pDiff = emb.estimatedPitchHz - pitchMean;
    pitchVar += pDiff * pDiff;
  }
  for (let i = 0; i < FEATURE_DIM; i++) {
    std[i] = Math.max(0.18, Math.sqrt(std[i] / n));
  }
  const pitchStd = Math.max(18, Math.min(65, Math.sqrt(pitchVar / n)));

  return {
    version: 1,
    sampleCount: embeddings.length,
    meanFeatures: mean,
    stdFeatures: std,
    meanPitchHz: pitchMean,
    pitchStdHz: pitchStd,
    enrolledAtMs: Date.now(),
  };
}

export function computeSpeakerSimilarity(
  profile: SpeakerVoiceprint,
  candidate: AcousticEmbedding
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < NUM_BANDS; i++) {
    const a = profile.meanFeatures[i];
    const b = candidate.features[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const cosine =
    normA > 1e-9 && normB > 1e-9
      ? Math.max(-1, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))))
      : 0;
  const spectralCosineScore = Math.max(0, Math.min(1, (cosine + 1) * 0.5));

  let sqDist = 0;
  for (let i = 13; i < FEATURE_DIM; i++) {
    const denom = Math.max(profile.stdFeatures[i], 0.14);
    const z = (candidate.features[i] - profile.meanFeatures[i]) / denom;
    sqDist += z * z;
  }
  const timbreProximity = Math.exp(-sqDist / 6.0);

  const pitchDiff = Math.abs(candidate.estimatedPitchHz - profile.meanPitchHz);
  const pitchScale = Math.max(profile.pitchStdHz * 1.6, 38.0);
  const pitchScore = Math.exp(-Math.pow(pitchDiff / pitchScale, 2));

  const combined = 0.55 * spectralCosineScore + 0.25 * pitchScore + 0.2 * timbreProximity;
  return Math.max(0, Math.min(1, combined));
}

export function verifySpeakerUtterance(
  samples: Float32Array | Int16Array,
  profile: SpeakerVoiceprint | null,
  config: SpeakerVerificationConfig = DEFAULT_SPEAKER_VERIFICATION_CONFIG
): SpeakerVerificationResult {
  if (!config.enabled) {
    return {
      outcome: 'DISABLED',
      similarityScore: 1,
      shouldAllowCommand: true,
      usedSafeFallback: false,
      voicedMs: 0,
      reason: 'speaker_verification_disabled',
    };
  }
  if (!profile || profile.sampleCount < config.requiredEnrollmentSamples) {
    return {
      outcome: 'NOT_ENROLLED',
      similarityScore: 1,
      shouldAllowCommand: true,
      usedSafeFallback: true,
      voicedMs: 0,
      reason: 'primary_speaker_not_enrolled',
    };
  }

  const embedding = extractSpeakerEmbedding(samples);
  if (!embedding || embedding.voicedMs < config.minVoicedMs) {
    return {
      outcome: 'INSUFFICIENT_SPEECH',
      similarityScore: 0,
      shouldAllowCommand: true,
      usedSafeFallback: true,
      voicedMs: embedding?.voicedMs ?? 0,
      reason: 'insufficient_voiced_duration_fallback_allow',
    };
  }

  const score = computeSpeakerSimilarity(profile, embedding);
  if (score >= config.acceptThreshold) {
    return {
      outcome: 'VERIFIED_PRIMARY',
      similarityScore: score,
      shouldAllowCommand: true,
      usedSafeFallback: false,
      voicedMs: embedding.voicedMs,
      reason: 'verified_primary_speaker',
    };
  }
  if (score >= config.uncertainThreshold) {
    return {
      outcome: 'UNCERTAIN_FALLBACK_ALLOW',
      similarityScore: score,
      shouldAllowCommand: true,
      usedSafeFallback: true,
      voicedMs: embedding.voicedMs,
      reason: 'uncertain_similarity_safe_fallback_allow',
    };
  }
  return {
    outcome: 'REJECTED_NON_PRIMARY',
    similarityScore: score,
    shouldAllowCommand: !config.strictMode,
    usedSafeFallback: !config.strictMode,
    voicedMs: embedding.voicedMs,
    reason: config.strictMode
      ? 'non_primary_speaker_rejected'
      : 'non_primary_speaker_soft_fallback',
  };
}
