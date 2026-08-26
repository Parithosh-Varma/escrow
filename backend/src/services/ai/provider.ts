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

const FLAG_THRESHOLD = 0.7;

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

/** GPTZero-style text AI-detection via their v2 predict endpoint. */
class GptZeroStyleProvider implements AiCheckProvider {
  name = "gptzero-style";
  constructor(private apiKey: string) {}

  async run(input: CheckInput): Promise<CheckResult> {
    if (!input.deliverableText) {
      return {
        provider: this.name,
        confidence: 0,
        flagged: false,
        raw: { note: "no text content provided for AI detection" }
      };
    }

    try {
      const res = await fetch("https://api.gptzero.me/v2/predict/text", {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ document: input.deliverableText }),
        signal: AbortSignal.timeout(30_000)
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[ai] gptzero HTTP %d: %s", res.status, body.slice(0, 200));
        return {
          provider: this.name,
          confidence: 0,
          flagged: false,
          raw: { error: `HTTP ${res.status}`, body: body.slice(0, 500) }
        };
      }

      const data = await res.json() as {
        documents?: Array<{
          confidence?: { ai_generated?: number; human_generated?: number };
          overall_exported_category_result?: string;
        }>;
      };

      const doc = data.documents?.[0];
      const aiConf = doc?.confidence?.ai_generated ?? 0;
      const confidence = typeof aiConf === "number" ? Math.min(1, Math.max(0, aiConf)) : 0;

      return {
        provider: this.name,
        confidence,
        flagged: confidence >= FLAG_THRESHOLD,
        raw: {
          category: doc?.overall_exported_category_result,
          confidence: doc?.confidence
        }
      };
    } catch (err) {
      console.error("[ai] gptzero call failed:", err);
      return {
        provider: this.name,
        confidence: 0,
        flagged: false,
        raw: { error: String(err) }
      };
    }
  }
}

/** Hive-style image/video AI-detection + Originality-style plagiarism via Hive classify endpoint. */
class HiveStyleProvider implements AiCheckProvider {
  name = "hive-style";
  constructor(private apiKey: string) {}

  async run(input: CheckInput): Promise<CheckResult> {
    if (!input.deliverableText) {
      return {
        provider: this.name,
        confidence: 0,
        flagged: false,
        raw: { note: "no text content provided for plagiarism/requirement check" }
      };
    }

    const classMap: Record<CheckType, string> = {
      plagiarism: "plagiarism",
      requirement_match: "relevance",
      ai_generation: "ai_generated"
    };
    const className = classMap[input.checkType] ?? "plagiarism";

    try {
      const res = await fetch("https://api.thehive.ai/v2/classify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: { text: input.deliverableText },
          config: { classes: [className] }
        }),
        signal: AbortSignal.timeout(30_000)
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[ai] hive HTTP %d: %s", res.status, body.slice(0, 200));
        return {
          provider: this.name,
          confidence: 0,
          flagged: false,
          raw: { error: `HTTP ${res.status}`, body: body.slice(0, 500) }
        };
      }

      const data = await res.json() as {
        status?: string;
        response?: {
          classes?: Record<string, number>;
        };
      };

      const classes = data.response?.classes ?? {};
      const rawScore = classes[className] ?? 0;
      const confidence = typeof rawScore === "number" ? Math.min(1, Math.max(0, rawScore)) : 0;

      return {
        provider: this.name,
        confidence,
        flagged: confidence >= FLAG_THRESHOLD,
        raw: {
          class: className,
          scores: classes,
          status: data.status
        }
      };
    } catch (err) {
      console.error("[ai] hive call failed:", err);
      return {
        provider: this.name,
        confidence: 0,
        flagged: false,
        raw: { error: String(err) }
      };
    }
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
