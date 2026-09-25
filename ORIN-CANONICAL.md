# Canonical Orin Router migration

The production Router contract now lives in
[`januththedev/orin-router-service`](https://github.com/januththedev/orin-router-service).

| Capability | Canonical owner | Status |
|---|---|---|
| Public aliases and failover | `orin-router-service` | Released |
| Core service authentication | `Orin-AI` + `orin-router-service` | Released |
| Encrypted provider keys and management API | `orin-router-service` | Released |
| Durable catalog/health/usage state | `orin-router-service` | Released |
| MCP, Chat, and Code clients | `Orin-AI`, `orin-mcp`, `Orin-Code` | Released |

This repository remains a historical, feature-rich upstream fork. Its provider
pool, password-login, and dashboard code is not silently treated as the current
Orin product surface. Any migration must preserve the canonical four aliases,
reject raw provider keys from public clients, use Core service assertions, and
run the canonical repository's contract/security/preview gates.
