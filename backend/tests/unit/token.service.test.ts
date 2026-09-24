import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/modules/auth/token.service";

describe("token.service", () => {
  it("round-trips a valid access token", () => {
    const token = signAccessToken({ userId: "user-123" });
    const payload = verifyAccessToken(token);
    expect(payload.userId).toBe("user-123");
  });

  it("throws for a tampered token", () => {
    const token = signAccessToken({ userId: "user-123" });
    expect(() => verifyAccessToken(`${token}tampered`)).toThrow();
  });
});
