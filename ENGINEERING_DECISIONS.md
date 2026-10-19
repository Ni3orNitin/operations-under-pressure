# Engineering decisions

## 1. PostgreSQL is the source of truth

**Context:** Work items, membership, history, retry keys, and pending jobs must remain consistent. **Options:** Keep state in the browser, use an embedded database, or use a relational server database. **Choice:** PostgreSQL with explicit SQL and foreign keys. **Trade-off:** Compose and SQL require more setup than an in-memory demo, but transactions, constraints, and indexes make correctness visible and support growth.

## 2. Team membership carries a role

**Context:** A person can have different authority in different teams. **Options:** One global role, frontend-only action hiding, or a membership row per team. **Choice:** `memberships(user_id, team_id, role)` and one server-side authorization check at the resource boundary. **Trade-off:** Each operation has a membership lookup, while cross-team access can be denied consistently regardless of UI state.

## 3. Use optimistic versions and conditional claims

**Context:** Two operators may claim or edit the same item. **Options:** Last-write-wins, a long-lived lock, or a version column plus conditional updates. **Choice:** Claim with `assignee_id IS NULL`; edits and transitions match the submitted version and increment it atomically. **Trade-off:** A losing request must refresh after `409`, but there is no lock held while a person is using the interface.

## 4. Store activity in the same transaction

**Context:** The audit trail must agree with item state. **Options:** Reconstruct changes from logs later, write history asynchronously, or append the event in the item transaction. **Choice:** Append an event in the same database transaction for create, assignment, priority, workflow, and comments. A database trigger rejects event updates and deletes. **Trade-off:** A change waits for its event insert, but cannot commit without its history.

## 5. Stable cursor pagination and indexes

**Context:** The seed dataset has 2,000 items and real use may grow much larger. **Options:** Load all records, use large offsets, or keyset paginate. **Choice:** Server-side filters, full-text search, team/status/assignee indexes, and a `(created_at,id)` cursor. **Trade-off:** Cursor pagination does not provide arbitrary page numbers; it avoids scanning increasingly large offsets and keeps ordering stable.

## 6. Transactional outbox, small worker

**Context:** A change may need asynchronous follow-up, and a crash between saving the item and enqueuing work would lose it. **Options:** Notify inline, add a broker, or write an outbox record in the same transaction. **Choice:** A PostgreSQL outbox with `FOR UPDATE SKIP LOCKED`, capped retries, backoff, and an idempotent logging handler. **Trade-off:** Delivery is demonstrated rather than connected to an external service, while the persistence boundary is ready to extend.
