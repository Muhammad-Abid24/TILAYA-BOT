import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Deployment Unit File & Configuration Integrity (T15)", () => {
  it("should have telegram-tempmail.service file with correct systemd directives", () => {
    const serviceContent = fs.readFileSync("deploy/telegram-tempmail.service", "utf-8");

    // Non-root user
    assert.ok(serviceContent.includes("User=tilaya"));
    assert.ok(serviceContent.includes("Group=tilaya"));

    // Working directory and binary
    assert.ok(serviceContent.includes("WorkingDirectory=/opt/tilaya-bot"));
    assert.ok(serviceContent.includes("ExecStart=/usr/bin/node /opt/tilaya-bot/src/index.js"));

    // Environment file
    assert.ok(serviceContent.includes("EnvironmentFile=/etc/tilaya-bot/.env"));

    // Hardening directives
    assert.ok(serviceContent.includes("NoNewPrivileges=true"));
    assert.ok(serviceContent.includes("ProtectSystem=strict"));
    assert.ok(serviceContent.includes("ProtectHome=true"));
    assert.ok(serviceContent.includes("PrivateTmp=true"));
    assert.ok(serviceContent.includes("StateDirectory=tilaya-bot"));
    assert.ok(serviceContent.includes("Restart=on-failure"));
  });

  it("should have clean deployment documentation in deploy/README.md", () => {
    const doc = fs.readFileSync("deploy/README.md", "utf-8");

    assert.ok(doc.includes("Prasyarat Sistem"));
    assert.ok(doc.includes("Single-Instance Long Polling"));
    assert.ok(doc.includes("0600"));
    assert.ok(doc.includes("sqlite3 .backup"));
    assert.ok(doc.includes("systemctl start telegram-tempmail.service"));
  });
});

