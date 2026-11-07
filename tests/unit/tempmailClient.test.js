import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTempMailClient } from "../../src/api/tempmailClient.js";
import { stripHtml } from "../../src/api/normalizers.js";

describe("TempMail Client and Normalizers (T03)", () => {
  const BASE_URL = "http://localhost:8080";

  it("should generate a single email correctly", async () => {
    let capturedUrl = "";
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          status: "success",
          data: { email: "user1@example.com", type: 1 }
        }),
        { status: 200 }
      );
    };

    const client = createTempMailClient({ baseUrl: BASE_URL, fetchFn: mockFetch });
    const result = await client.generateEmail({ ids: [1] });

    assert.equal(capturedUrl, "http://localhost:8080/api/generate-email");
    assert.deepEqual(capturedBody, { ids: [1] });
    assert.equal(result.email, "user1@example.com");
    assert.equal(result.type, 1);
  });

  it("should generate bulk emails and normalize unique addresses", async () => {
    let capturedUrl = "";
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          status: "success",
          data: ["A@example.com", "b@example.com", "a@example.com"] // duplicate casing
        }),
        { status: 200 }
      );
    };

    const client = createTempMailClient({ baseUrl: BASE_URL, fetchFn: mockFetch });
    const result = await client.generateBulkEmail({ ids: [1, 2], count: 3 });

    assert.equal(capturedUrl, "http://localhost:8080/api/generate-bulk-email");
    assert.deepEqual(capturedBody, { ids: [1, 2], count: 3 });
    // Deduped
    assert.deepEqual(result, ["a@example.com", "b@example.com"]);
  });

  it("should get message list and normalize items safely", async () => {
    let capturedUrl = "";
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          status: "success",
          data: [
            {
              id: "msg_123",
              from: "sender@domain.com",
              subject: "Verification Code",
              created_at: "2026-11-08 10:00:00"
            }
          ]
        }),
        { status: 200 }
      );
    };

    const client = createTempMailClient({ baseUrl: BASE_URL, fetchFn: mockFetch });
    const result = await client.getMessageList({ email: "user@example.com", limit: 10 });

    assert.equal(capturedUrl, "http://localhost:8080/api/message-list");
    assert.deepEqual(capturedBody, { email: "user@example.com", limit: 10 });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "msg_123");
    assert.equal(result[0].sender, "sender@domain.com");
    assert.equal(result[0].subject, "Verification Code");
  });

  it("should get message detail and safely strip HTML without executing or exposing scripts", async () => {
    let capturedUrl = "";

    const mockFetch = async (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            id: "msg_999",
            from: "service@domain.com",
            subject: "Your OTP",
            date: "2026-11-08",
            body_html: "<div><script>alert('xss')</script><p>Kode OTP Anda adalah <b>123456</b></p></div>"
          }
        }),
        { status: 200 }
      );
    };

    const client = createTempMailClient({ baseUrl: BASE_URL, fetchFn: mockFetch });
    const result = await client.getMessage({ id: "msg_999" });

    assert.equal(capturedUrl, "http://localhost:8080/api/message/msg_999");
    assert.equal(result.id, "msg_999");
    assert.equal(result.bodyText, "Kode OTP Anda adalah 123456");
    assert.ok(!result.bodyText.includes("<script>"));
    assert.ok(!result.bodyText.includes("alert"));
  });

  it("should extend email validity successfully", async () => {
    let capturedUrl = "";
    let capturedBody = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          status: "success",
          message: "Email diperpanjang hingga 24 jam",
          expires_at: "2026-11-09T00:00:00Z"
        }),
        { status: 200 }
      );
    };

    const client = createTempMailClient({ baseUrl: BASE_URL, fetchFn: mockFetch });
    const result = await client.extendEmail({ email: "user@example.com" });

    assert.equal(capturedUrl, "http://localhost:8080/api/extend-email");
    assert.deepEqual(capturedBody, { email: "user@example.com" });
    assert.equal(result.success, true);
    assert.equal(result.expiresAt, "2026-11-09T00:00:00Z");
  });

  it("stripHtml utility should sanitize scripts, styles, and tags", () => {
    const raw = "<style>body{color:red;}</style>Hello &nbsp; <b>World</b> &amp; friend!";
    const cleaned = stripHtml(raw);
    assert.equal(cleaned, "Hello World & friend!");
  });
});

