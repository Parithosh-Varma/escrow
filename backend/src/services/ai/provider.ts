/**
 * AI verification pipeline (spec §5). Three checks per submission:
 *   requirement_match | plagiarism | ai_generation
 * Flags are a SIGNAL, never a verdict — any flag auto-triggers a dispute and
 * jurors weigh the raw confidence alongside proof-of-work.
 *
 * Phase-1 strategy: third-party APIs behind this interface. With no keys
 * configured the NullProvider runs so local dev/tests stay deterministic.
 */
import { config } from "../../config.js";

export type CheckType = "requirement_match" | "plagiarism" | "ai_generation";

export interface CheckInput {
  checkType: CheckType;
  milestoneSpec: string;
  deliverableText?: string;
  mime?: string;
}

export interface CheckResult {
  provider: string;
  confidence: number; // raw score 0..1 — logged, not just the boolean flag
  flagged: boolean;
  raw: Record<string, unknown>;
}

export interface AiCheckProvider {
  readonly name: string;
  run(input: CheckInput): Promise<CheckResult>;
}

class NullProvider implements AiCheckProvider {
  name = "null";
  async run(input: CheckInput): Promise<CheckResult> {
    return {
      provider: this.name,
      confidence: 0,
      flagged: false,
      raw: { note: `no provider configured for ${input.checkType}` }
    };
  }
}

/** GPTZero-style text AI-detection stub. Wire real endpoint when key present. */
class GptZeroStyleProvider implements AiCheckProvider {
  name = "gptzero-style";
  constructor(private apiKey: string) {}
  async run(input: CheckInput): Promise<CheckResult> {
    // TODO(phase-integration): POST text to detector API, map response to confidence.
    return {
      provider: this.name,
      confidence: 0,
      flagged: false,
      raw: { note: "provider wired but remote call not implemented", hasKey: true }
    };
  }
}

/** Hive-style image/video AI-detection + Originality-style plagiarism stub. */
class HiveStyleProvider implements AiCheckProvider {
  name = "hive-style";
  constructor(private apiKey: string) {}
  async run(input: CheckInput): Promise<CheckResult> {
    return {
      provider: this.name,
      confidence: 0,
      flagged: false,
      raw: { note: "provider wired but remote call not implemented", hasKey: true }
    };
  }
}

function providerFor(checkType: CheckType): AiCheckProvider {
  if (checkType === "ai_generation") {
    if (config.GPTZERO_API_KEY) return new GptZeroStyleProvider(config.GPTZERO_API_KEY);
  }
  if ((checkType === "plagiarism" || checkType === "requirement_match")
      && config.HIVE_API_KEY) {
    return new HiveStyleProvider(config.HIVE_API_KEY);
  }
  return new NullProvider();
}

export async function runAllChecks(
  input: Omit<CheckInput, "checkType">
): Promise<CheckResult[]> {
  const types: CheckType[] = ["requirement_match", "plagiarism", "ai_generation"];
  const results: CheckResult[] = [];
  for (const t of types) {
    results.push(await providerFor(t).run({ ...input, checkType: t }));
  }
  return results;
}
