/** Target languages offered for translation and as the preferred AI language. Codes are BCP-47 primary tags. */
export const SUPPORTED_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "sv", name: "Swedish" },
  { code: "pl", name: "Polish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ru", name: "Russian" },
  { code: "tr", name: "Turkish" },
  { code: "el", name: "Greek" },
  { code: "ar", name: "Arabic" },
  { code: "he", name: "Hebrew" },
  { code: "fa", name: "Persian" },
  { code: "hi", name: "Hindi" },
  { code: "bn", name: "Bengali" },
  { code: "ur", name: "Urdu" },
  { code: "pa", name: "Punjabi" },
  { code: "gu", name: "Gujarati" },
  { code: "mr", name: "Marathi" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "zh", name: "Chinese (Simplified)" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "id", name: "Indonesian" },
  { code: "ms", name: "Malay" },
  { code: "fil", name: "Filipino" },
  { code: "sw", name: "Swahili" },
];

const CODES = new Set(SUPPORTED_LANGUAGES.map((language) => language.code));

export function isSupportedLanguage(code: string): boolean {
  return CODES.has(code);
}

export function languageName(code: string): string {
  return SUPPORTED_LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

/**
 * Target languages for voice message translation, with the writing system
 * each translation must use. Models sometimes answer Indic languages in
 * Latin transliteration ("romanized"); naming the script in the prompt
 * keeps the output in the language's native script.
 */
export const VOICE_TRANSLATION_LANGUAGES: ReadonlyArray<{ code: string; name: string; script: string }> = [
  { code: "ta", name: "Tamil", script: "Tamil script (தமிழ்)" },
  { code: "en", name: "English", script: "Latin script" },
  { code: "hi", name: "Hindi", script: "Devanagari script (देवनागरी)" },
  { code: "te", name: "Telugu", script: "Telugu script (తెలుగు)" },
  { code: "ml", name: "Malayalam", script: "Malayalam script (മലയാളം)" },
];

const VOICE_CODES = new Set(VOICE_TRANSLATION_LANGUAGES.map((language) => language.code));

export function isVoiceTranslationLanguage(code: string): boolean {
  return VOICE_CODES.has(code);
}

/** The writing system translations into `code` must use, if ConnectX names one. */
export function languageScript(code: string): string | null {
  return VOICE_TRANSLATION_LANGUAGES.find((language) => language.code === code)?.script ?? null;
}
