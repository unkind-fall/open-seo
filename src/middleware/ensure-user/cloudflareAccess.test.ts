import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  jwtVerify: vi.fn(),
  resolveSharedWorkspaceContext: vi.fn(),
  resolveServiceIdentityContext: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.env }));

vi.mock("jose", () => ({
  createRemoteJWKSet: () => "jwks",
  jwtVerify: mocks.jwtVerify,
}));

vi.mock("./delegated", () => ({
  resolveSharedWorkspaceContext: mocks.resolveSharedWorkspaceContext,
  resolveServiceIdentityContext: mocks.resolveServiceIdentityContext,
}));

const headers = new Headers({ "cf-access-jwt-assertion": "token" });

function verifiedPayload(payload: Record<string, unknown>) {
  mocks.jwtVerify.mockResolvedValue({ payload });
}

beforeEach(() => {
  mocks.env.TEAM_DOMAIN = "https://team.cloudflareaccess.com";
  mocks.env.POLICY_AUD = "aud";
  mocks.env.ACCESS_SERVICE_IDENTITIES = JSON.stringify({
    "abc.access": "someone@example.com",
  });
});

describe("resolveCloudflareAccessContext", () => {
  it("resolves user JWTs by sub and email", async () => {
    verifiedPayload({ sub: "user-1", email: "person@example.com" });

    await resolveCloudflareAccessContext(headers);

    expect(mocks.resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "user-1",
      "person@example.com",
    );
    expect(mocks.resolveServiceIdentityContext).not.toHaveBeenCalled();
  });

  it("resolves a mapped service token by common_name", async () => {
    verifiedPayload({ sub: "", common_name: "abc.access" });

    await resolveCloudflareAccessContext(headers);

    expect(mocks.resolveServiceIdentityContext).toHaveBeenCalledWith(
      "abc.access",
      "someone@example.com",
    );
  });

  it("rejects an unmapped service token", async () => {
    verifiedPayload({ common_name: "other.access" });

    await expect(resolveCloudflareAccessContext(headers)).rejects.toMatchObject(
      { code: "UNAUTHENTICATED" },
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not JSON", "abc.access"],
    ["not an object", '"someone@example.com"'],
    ["a non-string value", '{"abc.access": 42}'],
  ])(
    "rejects service tokens when ACCESS_SERVICE_IDENTITIES is %s",
    async (_label, value) => {
      mocks.env.ACCESS_SERVICE_IDENTITIES = value;
      verifiedPayload({ common_name: "abc.access" });

      await expect(
        resolveCloudflareAccessContext(headers),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(mocks.resolveServiceIdentityContext).not.toHaveBeenCalled();
    },
  );
});
