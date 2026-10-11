import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth";

describe("password storage", () => {
  it("stores distinct Argon2id hashes and verifies only the correct password", async () => {
    const password = "correct horse battery staple";
    const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(password);
    expect(first).not.toBe(second);
    expect(await argon2.verify(first, password)).toBe(true);
    expect(await argon2.verify(first, "wrong password")).toBe(false);
  });
});
