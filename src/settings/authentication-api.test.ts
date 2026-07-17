import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => ({ request: requestMock }));

import {
  fetchAuthenticationSettings,
  saveAuthenticationSettings,
  sendAuthenticationTestEmail,
} from "./settings-api";

describe("authentication settings API", () => {
  beforeEach(() => requestMock.mockReset());

  it("reads the admin SMTP settings", async () => {
    const settings = {
      host: "smtp.example.com",
      port: 587,
      username: "mailer@example.com",
      from_address: "Octos <mailer@example.com>",
      password_configured: true,
      allow_self_registration: true,
    };
    requestMock.mockResolvedValue(settings);

    await expect(fetchAuthenticationSettings()).resolves.toEqual(settings);
    expect(requestMock).toHaveBeenCalledWith("/api/admin/smtp");
  });

  it("saves the SMTP and registration policy payload", async () => {
    requestMock.mockResolvedValue(undefined);
    const body = {
      host: "smtp.example.com",
      port: 587,
      username: "mailer@example.com",
      from_address: "Octos <mailer@example.com>",
      allow_self_registration: true,
    };

    await saveAuthenticationSettings(body);

    expect(requestMock).toHaveBeenCalledWith("/api/admin/smtp", {
      method: "POST",
      body: JSON.stringify(body),
    });
  });

  it("sends a diagnostic email through the admin SMTP endpoint", async () => {
    requestMock.mockResolvedValue({ ok: true, message: "sent" });

    await expect(
      sendAuthenticationTestEmail("new-user@example.com"),
    ).resolves.toEqual({ ok: true, message: "sent" });
    expect(requestMock).toHaveBeenCalledWith("/api/admin/smtp/test", {
      method: "POST",
      body: JSON.stringify({ to: "new-user@example.com" }),
    });
  });
});
