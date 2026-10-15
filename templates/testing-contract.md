# Test Contract Docstring

> Every test file MUST begin with a structured contract docstring. This answers four questions: who cares, what breaks, why this test exists, and where it goes when architecture changes.

Keep the field names, but answer them in plain language tied to the actual
assertions; a short, specific answer is enough. Apply the core skill's
`references/implementation-discipline.md` comment guidance. This contract is
useful test documentation, not an invitation to narrate every assertion or
claim coverage the test does not provide. Use the host language's comment or
docstring syntax.

## Format

```
"""
Contract:
- Perspective: <stakeholder>
- Invariant: <what must always be true>
- Goal: <what regression this prevents>
- Migration: <ai_service | game_rule | disposable>
"""
```

## Fields

### Perspective

The stakeholder whose requirements this test guards. Determines what the test focuses on.

| Perspective | Tests for | Example invariant |
|---|---|---|
| system integrity | Multi-component state consistency | "breakthrough writes 10+ attributes atomically" |
| game designer | Balance rules, progression constraints | "time budget deducts correctly, clamps to zero" |
| frontend developer | API/protocol contracts, response shapes | "WebSocket routes JSON envelopes, returns correct structure" |
| content author | Data-driven config loading, template rendering | "YAML skill definitions produce valid skill instances" |
| engine developer | Internal module correctness, performance | "LRU cache evicts oldest chunk when capacity exceeded" |
| deployment | Build, startup, environment compatibility | "server starts without Redis" |

### Invariant

The property that must hold regardless of implementation changes. Write it as a behavioral constraint, not a code description.

```
# Good — behavioral constraint
Invariant: successful breakthrough sets realm_index +1, refills qi/hp, and boosts four stats

# Bad — code description
Invariant: test_breakthrough calls breakthrough_tool and asserts return value
```

### Goal

The specific regression this test prevents. Reference the failure scenario, not the happy path.

```
# Good — failure scenario
Goal: prevent actions from exceeding daily time budget or producing negative time remaining

# Bad — restates the code
Goal: test that the time budget law works correctly
```

### Migration

Where this test lives in the project's lifecycle. Signals whether the test stays in Python/backend, moves to engine rules, or should be deleted after migration.

| Label | Meaning |
|---|---|
| `ai_service` | Migrates to AI service layer (stays in Python/backend) |
| `game_rule` | Reimplemented in game engine (Godot/Unity/etc.) — Python test becomes disposable |
| `disposable` | Temporary test for current architecture, delete when migration completes |

## Real Examples

### Unit test (pure game logic)

```python
"""
Contract:
- Perspective: game designer
- Invariant: CompanionLaw must enforce no-duplicate companions,
    support multiple relationship types, and compute correct aggregate benefits
- Goal: prevent companion registration or benefit calculation regressions
    when relationship types or bonuses change
- Migration: game_rule
"""
```

### Integration test (protocol contract)

```python
"""
Contract:
- Perspective: frontend developer (WebSocket protocol contract between client and server)
- Invariant: server accepts WebSocket connections, routes JSON envelopes by method,
    returns correct response structure
- Goal: prevent WebSocket protocol regression when handlers are modified
- Migration: disposable
"""
```

### System integrity test (multi-attribute state transition)

```python
"""
Contract: Breakthrough Tool — Full Lifecycle with Storage

Perspective: System Integrity
  — breakthrough involves 10+ attribute read/writes, any omission corrupts character data

Invariant:
  - Insufficient cultivation rejects breakthrough with hint text
  - Success: realm_index +1, realm updated, qi/hp refilled, four stats boosted
  - Failure: cultivation reduced 10%, realm unchanged
  - Rejects breakthrough at max realm

Goal: verify full state transition correctness under real storage

Migration: ai_service — breakthrough as Tool stays in Python
"""
```

## Conftest Fixture Philosophy

Test infrastructure follows two rules:

1. **Real storage, not mocks.** Use the real storage adapter (in-memory/temp-dir mode) so tests exercise actual read/write paths. Mock storage hides bugs that surface only in production.

2. **Stub only external services.** LLM, third-party APIs, payment gateways — stub these with configurable response objects that record calls for assertion. The stub exists because the external service is non-deterministic or costly, not because "mocking is easier."

```python
"""
Test infrastructure — shared fixtures.

All fixtures use real LocalStorageAdapter, zero mock storage.
LLM is replaced by StubLLM for deterministic CI tests.
"""

@pytest.fixture
def storage(tmp_path):
    """Real storage — fresh instance per test."""
    return LocalStorageAdapter(str(tmp_path))


class StubLLM:
    """Configurable LLM stub — records calls for prompt assertions."""

    def __init__(self):
        self.response = ""
        self.calls = []

    async def generate(self, messages, **kwargs):
        self.calls.append(messages)

        class Response:
            content = self.response

        return Response()
```
