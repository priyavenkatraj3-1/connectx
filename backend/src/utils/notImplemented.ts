import type { Request, Response } from "express";

/**
 * Returns a route handler that honestly reports "not implemented yet"
 * instead of faking a response. Used by module scaffolds in Phase 1 so the
 * route shape exists without pretending the feature works.
 */
export function notImplemented(featureName: string) {
  return (_req: Request, res: Response): void => {
    res.status(501).json({
      error: {
        message: `${featureName} is not implemented yet (planned for a later phase).`,
      },
    });
  };
}
