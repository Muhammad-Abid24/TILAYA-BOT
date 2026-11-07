import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendHttpRequest, isTransient } from "../../src/api/httpClient.js";
import {
  HttpError,
  RequestTimeoutError,
  OperationCancelledError
} from "../../src/utils/errors.js";

describe("HTTP Client & Adapter (T03)", () => {
  it("should handle 200 OK with valid JSON", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ status: "success", data: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });

    const result = await sendHttpRequest("http://localhost/test", {
      fetchFn: mockFetch
    });

    assert.deepEqual(result, { status: "success", data: "ok" });
  });

  it("should throw HttpError on 400 Bad Request and NOT retry", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        statusText: "Bad Request"
      });
    };

    await assert.rejects(
      async () => {
        await sendHttpRequest("http://localhost/test", {
          fetchFn: mockFetch,
          maxRetries: 3
        });
      },
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 400);
        assert.equal(err.isTransient, false);
        return true;
      }
    );

    assert.equal(callCount, 1, "400 error should not trigger retries");
  });

  it("should throw HttpError on 401 Unauthorized and NOT retry", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        statusText: "Unauthorized"
      });
    };

    await assert.rejects(
      async () => {
        await sendHttpRequest("http://localhost/test", {
          fetchFn: mockFetch,
          maxRetries: 3
        });
      },
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 401);
        assert.equal(err.isTransient, false);
        return true;
      }
    );

    assert.equal(callCount, 1, "401 error should not trigger retries");
  });

  it("should retry transient 429 Too Many Requests with Retry-After header", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "0" } // 0 seconds for instant test
        });
      }
      return new Response(JSON.stringify({ status: "success" }), {
        status: 200
      });
    };

    const res = await sendHttpRequest("http://localhost/test", {
      fetchFn: mockFetch,
      maxRetries: 2,
      retryDelayMs: 10
    });

    assert.equal(callCount, 2);
    assert.deepEqual(res, { status: "success" });
  });

  it("should retry transient 500 error up to maxRetries and succeed", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount < 3) {
        return new Response("server error", { status: 500, statusText: "Internal Error" });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const res = await sendHttpRequest("http://localhost/test", {
      fetchFn: mockFetch,
      maxRetries: 3,
      retryDelayMs: 5
    });

    assert.equal(callCount, 3);
    assert.deepEqual(res, { success: true });
  });

  it("should throw HttpError when 500 retries are exhausted", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("server error", { status: 500 });
    };

    await assert.rejects(
      async () => {
        await sendHttpRequest("http://localhost/test", {
          fetchFn: mockFetch,
          maxRetries: 2,
          retryDelayMs: 5
        });
      },
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 500);
        return true;
      }
    );

    assert.equal(callCount, 3); // initial + 2 retries
  });

  it("should handle non-JSON responses safely without crashing", async () => {
    const mockFetch = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200 // Even if server mistakenly returned 200 with HTML
      });

    await assert.rejects(
      async () => {
        await sendHttpRequest("http://localhost/test", {
          fetchFn: mockFetch,
          maxRetries: 0
        });
      },
      (err) => {
        assert.ok(err instanceof HttpError);
        assert.ok(err.message.includes("Invalid response format"));
        return true;
      }
    );
  });

  it("should handle request timeout and throw RequestTimeoutError", async () => {
    const mockFetch = async (_, { signal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify({ ok: true })));
        }, 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    };

    await assert.rejects(
      async () => {
        await sendHttpRequest("http://localhost/test", {
          fetchFn: mockFetch,
          timeoutMs: 30, // 30ms timeout
          maxRetries: 0
        });
      },
      (err) => {
        assert.ok(err instanceof RequestTimeoutError);
        return true;
      }
    );
  });

  it("should immediately abort when external AbortSignal is triggered", async () => {
    const controller = new AbortController();
    const mockFetch = async (_, { signal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify({ ok: true })));
        }, 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    };

    setTimeout(() => {
      controller.abort();
    }, 20);

    await assert.rejects(
      async () => {
        await sendHttpRequest("http://localhost/test", {
          fetchFn: mockFetch,
          signal: controller.signal,
          timeoutMs: 1000
        });
      },
      (err) => {
        assert.ok(err instanceof OperationCancelledError);
        return true;
      }
    );
  });

  it("isTransient helper should correctly classify statuses and errors", () => {
    assert.equal(isTransient(400), false);
    assert.equal(isTransient(401), false);
    assert.equal(isTransient(403), false);
    assert.equal(isTransient(404), false);
    assert.equal(isTransient(429), true);
    assert.equal(isTransient(500), true);
    assert.equal(isTransient(503), true);
    assert.equal(isTransient(new RequestTimeoutError()), true);
  });
});

