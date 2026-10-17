// Decision-model client. The wire format follows the Jev / SystemOne
// decisions API, which Clef (via Ollama, vLLM or SGLang) also implements.

import { normalizeBase, request } from "@/lib/transport";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** Ordered lowest → highest. */
  criteria: string[];
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionRequest {
  model?: string;
  state: Record<string, unknown>;
  questions: Record<string, Question>;
}

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResponse {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
}

export interface DecisionProvider {
  readonly name: string;
  /** Max options in one `choice` question (Jev 255, Ollama 26). */
  readonly maxChoiceOptions: number;
  decide(req: DecisionRequest): Promise<DecisionResponse>;
}

export interface HttpDecisionConfig {
  /** Base URL without /v1, e.g. https://api.typesafe.ai or http://localhost:11434 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxChoiceOptions?: number;
}

/** Any SystemOne-compatible server: Jev, Ollama, or Clef behind vLLM/SGLang. */
export class HttpDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly maxChoiceOptions: number;
  constructor(private cfg: HttpDecisionConfig) {
    this.name = cfg.model || "decision-http";
    this.maxChoiceOptions = cfg.maxChoiceOptions ?? 255;
  }

  decide(req: DecisionRequest): Promise<DecisionResponse> {
    return request<DecisionResponse>("POST", `${normalizeBase(this.cfg.baseUrl)}/v1/systemone`, {
      headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
      body: { ...req, model: req.model ?? this.cfg.model },
    });
  }
}

// ---- helpers ---------------------------------------------------------------

export function softmax(scores: Record<string, number>): Record<string, number> {
  const max = Math.max(...Object.values(scores));
  const exps = Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, Math.exp(v - max)]),
  );
  const sum = Object.values(exps).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(exps).map(([k, v]) => [k, v / sum]));
}

export function choiceFrom(scores: Record<string, number>): ChoiceAnswer {
  const probabilities = softmax(scores);
  const [choice, confidence] = Object.entries(probabilities).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return { type: "choice", choice, confidence, probabilities };
}

export function scoreFrom(levels: number, raw: number[]): ScoreAnswer {
  const probs = softmax(Object.fromEntries(raw.map((v, i) => [String(i), v])));
  const score = Object.entries(probs).reduce(
    (acc, [i, p]) => acc + Number(i) * p,
    0,
  );
  const confidence = Math.max(...Object.values(probs));
  return { type: "score", score: score / (levels - 1), confidence, probabilities: probs };
}
