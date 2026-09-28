import { AppError } from "../../middleware/errorHandler";

/**
 * Client-facing AI errors. Each carries a stable `code` so the frontend can
 * show the right state ("not configured" vs "turned off" vs "try again")
 * without parsing messages. Messages are generic on purpose: provider error
 * text is never forwarded to clients.
 */

/** The server has no AI (or transcription) provider configured. */
export class AIUnavailableError extends AppError {
  constructor(message = "AI features aren't configured on this server yet.") {
    super(message, 503, true, "ai_not_configured");
  }
}

/** The user hasn't turned on the AI feature (consent). */
export class AIDisabledError extends AppError {
  constructor(message = "Turn on AI features in Settings → AI Features to use this.") {
    super(message, 403, true, "ai_disabled");
  }
}

export class AIRateLimitError extends AppError {
  constructor(message = "You've reached your AI usage limit. Please try again later.") {
    super(message, 429, true, "ai_rate_limited");
  }
}

export class AITimeoutError extends AppError {
  constructor() {
    super("The AI service took too long to respond. Please try again.", 504, true, "ai_timeout");
  }
}

export class AIProviderFailureError extends AppError {
  constructor() {
    super("The AI service couldn't complete this request. Please try again later.", 502, true, "ai_provider_error");
  }
}

export class AIInvalidOutputError extends AppError {
  constructor() {
    super("The AI service returned a response ConnectX couldn't use. Please try again.", 502, true, "ai_invalid_output");
  }
}

export class AIRefusedError extends AppError {
  constructor() {
    super("The AI service declined this request.", 422, true, "ai_refused");
  }
}
