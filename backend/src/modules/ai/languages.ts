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
