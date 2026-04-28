---
---
# Rules

## Integration Standards

- All taps use `hotglue_singer_sdk` (HotGlue's fork), NOT standard `singer_sdk`
- Follow the canonical entity processing order: Products, Compositions, Suppliers, SupplierProducts, SellOrders, BuyOrders, BuyOrderLines, ReceiptLines
- Use Pydantic models for payload validation
- Use centralized CRUD via reusable `utils.actions`
- Use hash-based snapshot change detection for ETL diffs
- INCREMENTAL replication method by default — only FULL_TABLE when the API doesn't support filtering by date

## Build Order (strict)

1. Research the API: auth, endpoints, pagination, rate limits, schemas
2. Build the tap (data extraction from source)
3. Generate Postman collection (JSON export of all endpoints for support team)
4. Build the ETL notebook (transformation between tap output and target input)
5. Build the target (data loading to Acme API)
6. Test each component
7. Document in the vault

## Code Quality

- Read existing code before writing — always check if a similar pattern exists
- Check the vault for API-specific quirks and known issues
- Run tests when a test suite exists
- Keep changes minimal and focused

## Conversational judgment

- For greetings, check-ins, apologies, and light advisory questions: answer directly from what you already know before reaching for tools
- If context is genuinely missing, ask one concise clarifying question instead of launching into investigation
- Do not inspect files, run commands, or spin up subagents for casual/front-facing prompts unless the user explicitly asks you to investigate
- When a direct answer is possible, give it first; do not hide behind process

## Git

- Never force push or rewrite published history
- Commit with clear messages describing what changed and why
