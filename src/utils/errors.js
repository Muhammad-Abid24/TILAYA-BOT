export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthorizationError extends Error {
  constructor(message = "Unauthorized access") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class SessionExpiredError extends Error {
  constructor(message = "Session expired or invalid") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class InvalidCallbackError extends Error {
  constructor(message = "Invalid callback query") {
    super(message);
    this.name = "InvalidCallbackError";
  }
}

export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} [statusText]
   * @param {any} [responseBody]
   * @param {boolean} [isTransient=false]
   */
  constructor(message, status, statusText = "", responseBody = null, isTransient = false) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.isTransient = isTransient;
  }
}

export class UpstreamApiError extends Error {
  /**
   * @param {string} message
   * @param {any} [details]
   */
  constructor(message, details = null) {
    super(message);
    this.name = "UpstreamApiError";
    this.details = details;
  }
}

export class RequestTimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

export class OperationCancelledError extends Error {
  constructor(message = "Operation was cancelled") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export class MessageWaitTimeoutError extends Error {
  constructor(message = "Waiting for new message timed out") {
    super(message);
    this.name = "MessageWaitTimeoutError";
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}
