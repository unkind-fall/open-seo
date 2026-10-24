import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { user } from "@/db/better-auth-schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as DelegatedModule from "./delegated";

// Real in-memory SQLite: the point is that user.email's UNIQUE constraint is
// never hit when a service token maps to an existing user's email.

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

vi.mock("@/server/auth/delegated-organization", () => ({
  ensureSharedWorkspaceOrganization: async () => "shared-workspace",
}));

let client: Client;
let resolveServiceIdentityContext: typeof DelegatedModule.resolveServiceIdentityContext;

async function userRows() {
  return (await client.execute("SELECT id, email FROM user ORDER BY id")).rows;
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client, { schema: { user } });
  // testDb only exists at runtime, so the module under test must load after
  // these mocks.
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/d1/client", () => ({ d1Db: testDb }));
  vi.doMock("@/db/pg/client", () => ({ pgDb: null }));

  await client.execute(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      analytics_opted_out INTEGER,
      last_active_organization_id TEXT
    )
  `);

  ({ resolveServiceIdentityContext } = await import("./delegated"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM user");
});

describe("resolveServiceIdentityContext", () => {
  it("acts as the existing user that owns the mapped email", async () => {
    await client.execute(
      "INSERT INTO user (id, name, email) VALUES ('browser-user', 'someone', 'someone@example.com')",
    );

    const context = await resolveServiceIdentityContext(
      "abc.access",
      "someone@example.com",
    );

    expect(context).toMatchObject({
      userId: "browser-user",
      userEmail: "someone@example.com",
      organizationId: "shared-workspace",
    });
    expect(await userRows()).toEqual([
      expect.objectContaining({ id: "browser-user" }),
    ]);
  });

  it("creates a svc:<client id> user when the email is unknown", async () => {
    const context = await resolveServiceIdentityContext(
      "abc.access",
      "bot@example.com",
    );

    expect(context.userId).toBe("svc:abc.access");
    expect(await userRows()).toEqual([
      expect.objectContaining({
        id: "svc:abc.access",
        email: "bot@example.com",
      }),
    ]);
  });
});
