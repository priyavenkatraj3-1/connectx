/**
 * Live/automatic translation. Detects the source language and translates
 * on request or when a user enables per-conversation auto-translate.
 */
export interface TranslationRequest {
  text: string;
  targetLanguage: string; // BCP-47 code, e.g. "es", "hi", "fr"
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage: string;
}

export interface TranslationService {
  detectLanguage(text: string): Promise<string>;
  translate(request: TranslationRequest): Promise<TranslationResult>;
}
