// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * BouncerClassifier — pluggable Layer 2 classifier interface.
 *
 * Layer 2 asks: "Does this operation look like legitimate user intent or
 * like a prompt-injection attack?" Implementations spawn (or call) a model
 * to return a structured decision.
 *
 * Implementations MUST fail closed: any internal failure (timeout, parse
 * error, subprocess error) must throw so the integration layer can convert
 * it into a `deny` decision. Never return `allow` on error.
 */

export type ClassificationDecision = 'allow' | 'deny' | 'warn_allow';
export type ClassificationThreatLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ClassifierContext {
  purpose?: string;
  workingDirectory?: string;
  affectedFiles?: string[];
  alternatives?: string;
  userRequest?: string;
  conversationHistory?: string[];
  sessionId?: string;
  [key: string]: unknown;
}

export interface ClassificationResult {
  decision: ClassificationDecision;
  confidence: number;
  reasoning: string;
  threatLevel?: ClassificationThreatLevel;
  alternative?: string;
}

export interface BouncerClassifier {
  classify(operation: string, context?: ClassifierContext): Promise<ClassificationResult>;
}
