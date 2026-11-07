import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForNewMessage } from "../../src/services/pollingService.js";
import { createBot } from "../../src/bot/createBot.js";
import {
  MessageWaitTimeoutError,
  OperationCancelledError
} from "../../src/utils/errors.js";

describe("Message Polling Service (T13)", () => {
  const EMAIL = "target@example.com";

  it("should ignore baseline messages and detect only newly arrived messages (AC: pesan lama tidak dianggap baru, pesan baru terdeteksi)", async () => {
    let pollCount = 0;

    // Baseline has 2 messages
    const mockApiClient = {
      async getMessageList() {
        pollCount++;
        if (pollCount === 1) {
          // Baseline call
          return [
            { id: "old_1", sender: "sender1", subject: "Old 1" },
            { id: "old_2", sender: "sender2", subject: "Old 2" }
          ];
        }
        if (pollCount === 2) {
          // First poll: same messages (must not be treated as new)
          return [
            { id: "old_1", sender: "sender1", subject: "Old 1" },
            { id: "old_2", sender: "sender2", subject: "Old 2" }
          ];
        }
        // Second poll: new message arrived!
        return [
          { id: "old_1", sender: "sender1", subject: "Old 1" },
          { id: "old_2", sender: "sender2", subject: "Old 2" },
          { id: "new_101", sender: "auth_service", subject: "Your OTP: 987654" }
        ];
      }
    };

    const fastDelay = async () => {}; // Instant delay for unit test

    const result = await waitForNewMessage({
      email: EMAIL,
      apiClient: mockApiClient,
      timeoutMs: 5000,
      intervalMs: 10,
      delayFn: fastDelay
    });

    assert.ok(result);
    assert.equal(result.message.id, "new_101");
    assert.equal(result.message.subject, "Your OTP: 987654");
    assert.equal(pollCount, 3); // 1 baseline + 2 polls
  });

  it("should respect optional predicate filtering for specific message subject", async () => {
    let pollCount = 0;
    const mockApiClient = {
      async getMessageList() {
        pollCount++;
        if (pollCount === 1) return []; // Empty baseline
        if (pollCount === 2) {
          // Newsletter arrives, does not match predicate
          return [{ id: "promo_1", sender: "ads", subject: "Discount 50%" }];
        }
        // OTP arrives
        return [
          { id: "promo_1", sender: "ads", subject: "Discount 50%" },
          { id: "otp_2", sender: "bank", subject: "Verification OTP Code" }
        ];
      }
    };

    const fastDelay = async () => {};

    const result = await waitForNewMessage({
      email: EMAIL,
      apiClient: mockApiClient,
      timeoutMs: 5000,
      intervalMs: 10,
      predicate: (msg) => msg.subject.includes("OTP"),
      delayFn: fastDelay
    });

    assert.equal(result.message.id, "otp_2");
    assert.equal(result.message.subject, "Verification OTP Code");
  });

  it("should throw MessageWaitTimeoutError when deadline expires (AC: timeout typed error)", async () => {
    const mockApiClient = {
      async getMessageList() {
        return [{ id: "baseline_msg", sender: "a", subject: "b" }];
      }
    };

    let tickCount = 0;
    // Delay simulates passing of time beyond timeout
    const fakeTimerDelay = async () => {
      tickCount++;
      // Sleep a bit so Date.now() advances past deadline
      return new Promise((resolve) => setTimeout(resolve, 25));
    };

    await assert.rejects(
      async () => {
        await waitForNewMessage({
          email: EMAIL,
          apiClient: mockApiClient,
          timeoutMs: 30, // 30ms total deadline
          intervalMs: 10,
          delayFn: fakeTimerDelay
        });
      },
      (err) => {
        assert.ok(err instanceof MessageWaitTimeoutError);
        assert.ok(err.message.includes("timed out"));
        return true;
      }
    );

    assert.ok(tickCount >= 1);
  });

  it("should throw OperationCancelledError when aborted via AbortSignal (AC: cancellation typed error)", async () => {
    const controller = new AbortController();

    const mockApiClient = {
      async getMessageList() {
        return [];
      }
    };

    const abortingDelay = async () => {
      controller.abort();
    };

    await assert.rejects(
      async () => {
        await waitForNewMessage({
          email: EMAIL,
          apiClient: mockApiClient,
          timeoutMs: 10000,
          intervalMs: 100,
          signal: controller.signal,
          delayFn: abortingDelay
        });
      },
      (err) => {
        assert.ok(err instanceof OperationCancelledError);
        assert.ok(err.message.includes("cancelled"));
        return true;
      }
    );
  });

  it("should verify bot does NOT register /wait command (AC: tidak menambah command baru)", () => {
    const registeredCommands = new Set();
    const mockBot = {
      context: {},
      use() {},
      on() {},
      command(cmd) {
        registeredCommands.add(cmd);
      }
    };

    createBot({
      botToken: "123456:mock_token",
      allowedIds: new Set([1001]),
      customBotInstance: mockBot
    });

    // MVP commands must be present
    assert.ok(registeredCommands.has("start"));
    assert.ok(registeredCommands.has("get"));
    assert.ok(registeredCommands.has("bulk"));
    assert.ok(registeredCommands.has("inbox"));
    assert.ok(registeredCommands.has("extend"));
    assert.ok(registeredCommands.has("export"));
    assert.ok(registeredCommands.has("done"));
    assert.ok(registeredCommands.has("stop"));

    // /wait MUST NOT be registered on MVP
    assert.equal(registeredCommands.has("wait"), false);
  });
});

