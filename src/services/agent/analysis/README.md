# Analysis core — C1/C2/C3 integration contract

Scope: local, injectable business core for INTEGRATION_PLAN §§18–20. No settings,
main service, UI, package change, eager SDK/Node import, automatic OCR or provider.
Mock verification does **not** certify real semantic recall, precision or provider compatibility.

## Stable public entry

Import `src/services/agent/analysis/index.ts`:

- `freezeManifest(scope, reader)`, `manifestPage(manifest, cursor?, size=200)`;
- `makeChunks(manifest, spec, profile)`; `effectiveIdentity(units)`;
- `EXTRACTION_SCHEMA`, `SYNTHESIS_SCHEMA`, `citationInstructions(chunk)`;
- `AnalysisStore`, `ProtectedJsonAnalysisStorage`, `MemoryAnalysisStorage` (fixtures only);
- `AnalysisCoordinator.create/approve/run/pause/cancel/reload/rebind/snapshotReport`;
- `reconcileUsage/reconcileReportEffect` require **observed**, not guessed receipts;
- `publishReport` is a separate authorized, idempotent derived-write effect;
- `createExistingReaderAdapter` is a cache/native-only adapter facade.

### Host reader

Bind `ManifestReader` to the actual permitted project listing, not the top search results.
Enumeration must run all pages; immutable manifest pages are 200 documents max, not a
total-document cap. Only exact `source_file` to an enumerated original in the same project
merges wrappers/caches. Unknown/cross-project relations stay distinct. Exclude internal
JSON by controlled path/type; `lifeos-agent-analysis-report` enters new jobs only through
an explicit user inclusion. Never exclude arbitrary user filenames containing “缓存”.

Reuse existing `recognizedSourcePath`, `readRecognizedPage` and native
DocumentImport reads in your host adapter. Cache service readPdfPage/readDocx can
WRITE/refresh cache even without OCR; a read-only host must instead read existing
Markdown and use native readPdfPageText/extractReadableDocumentText without OCR.
The core deliberately does not instantiate
an Obsidian App or access settings. PDF/native/cache units must carry verified page/section
counts; partially unreadable DOCX image/structure remains partial, `totalUnits=null`
never counts as a completed document. `readCachedOrNative(...,{allowVision:false})`
must not silently fall back to paid vision/OCR.

Artificial or edited recognition Markdown: preserve text verbatim, set
`origin:"manually-edited", originalVerified:false`. `sourceHash` is SHA-256 of original
bytes, whereas `effectiveTextHash` covers the exact current units plus provenance.
Do not restore a cache over a user edit, or pretend it is original-author verbatim evidence.
`currentIdentity` must observe current original/effective identities; it may reuse a
verified host identity cache, but not the frozen manifest as a live identity check.

### Model driver (dedicated analysisCall, not AgentLoop)

`AnalysisModel.extract/synthesize` receive `ModelCall`:

- `profile: ModelIdentity` includes backend/profile/model revisions, destination,
  `contextTokens`, `inputTokens`, `outputTokens`, `overheadTokens`, `maxInputChars`;
- `prompt` is the complete bounded request text; do not append all descendant views
  from the node metadata again. Full views stay in the durable index;
- `maxOutputTokens`, `maxTurns` (SDK tool-round limit defaults to 1), `signal`;
- `allowance:{tokens,cost,currency?}` is **this call's reservation**;
  `remaining` is the rest of the total job AFTER reserving this call;
- `nativeRequestBudget:{limit:1,used:0,signal,maxInputChars,maxOutputTokens}` can be passed
  to the existing API request consumer. It is not an SDK HTTP counter.

The driver must bind the exact approved profile/destination and honor single-turn,
output/amount/total-token limits. `sdkReportedTurnAllowance` separately reserves
terminal reported turns and conservative token ceilings; fallback is sdkTurnLimit
or 1 and any explicit value must be positive integral. CLI maxTurns counts
tool-use round trips, not result num_turns. Host uses 4 reported turns/query,
not a guarantee of at most 4 internal turns; actual excess/unknown pauses.
If the SDK/controller cannot enforce a configured
amount/token ceiling, reject before dispatch; do not pretend estimates are a provider
enforcement mechanism. `costCeiling` uses user-confirmed prices/bounds, or returns null.
No hardcoded price table. Unknown model context raises `capability-test-required` and
does not run a remote capability probe. Missing confirmed tokenizer raises
`token-counter-unavailable`; fallback counting is labelled conservative UTF-8 byte estimate.

Return `{output,finish:"complete"|"length"|"error",usage}`. A length stop or malformed
JSON is not done. Local schema repair is at most one further separately reserved call.
When it still fails, retain failed/partial rather than an empty “no viewpoints” success.

Usage receipt fields are job execution-bound: `receiptId`, `executionId`, `taskId`,
`profile`, `category`, `basis`, `tokens`, `cost`, `currency?`, `sdkHttpRequests`, `sdkTurns`.
`sdkTurns` is **this execution's increment**, even if tokens/cost are session-cumulative;
unknown SDK HTTP stays null, never charged to `api` count. For cumulative tokens/cost,
use a reset/session-specific `counterId`; seed a known prior session baseline in
`job.budget.cumulative[JSON.stringify([profile,category,counterId])]` before dispatching
an existing session. Resuming this job preserves that map and ALL previous consumption.
No reset/clear-budget API. Unknown failed/crashed consumption pauses new requests.

### Citation instructions usable by real models

The core prompt includes `citationInstructions(chunk)`. Each claim has citations:

```json
{"unitId":"u1","start":null,"end":null,"quote":"原文中精确且唯一的短引用","quoteHash":null}
```

The host resolves a **unique, exact** quote in that chunk to absolute UTF-16 `[start,end)`
and computes its SHA-256 (exact UTF-16LE code units). A repeated quote requires explicit
offsets; a supplied non-null hash must match, so a fabricated hash never passes.
The input also provides a trusted full-chunk span/hash, but prefer short necessary
quotes rather than echoing whole chunks for every viewpoint. Do not normalize punctuation,
newlines or whitespace inside a quote. Half-surrogate boundaries reject. Each argument,
condition, counterexample and time claim also needs citations. The reader's author/comment
role constrains attribution. Hash/schema validity is **not** semantic entailment proof.

### Persistence, approval and UI hooks

Provide `ProtectedAnalysisIO` with a stable opaque `hostIdentity`,
`pathFor(jobId,"state.json")` generated by FileSystemService's protected Agent workspace,
`read`, `atomicReplace`, and `withHostLock` shared by ALL windows on that host.
Plain read/write without that mutex + atomic replace is not a valid adapter.
It is not cross-process/cross-device distributed safety; foreign-host jobs are read-only.

`AnalysisCoordinator.create` is local preparation. Host UI records explicit current
approval using `approvalFor(job,now,expiresAt)` and `approve`. It must verify actual
user consent; the helper is not consent acquisition or a signature service.
`run(jobId,{explicitUserContinue:true,owner})` is the only bulk execution entry.
`reload` never invokes reader/model/search/vision/report sink callbacks. Show its
paused/budget-required recovery action; do not auto-call run during startup.

Scope/manifest/profile/destination/permissions/budget changes use `rebind`, increment
authorization identity/revision and invalidate approval. Exact compatible completed
chunks survive; model/extraction/source/effective changes invalidate cache keys.
Progress, lease/cursor saves only change stateRevision and retain approval. Rebind never
recreates the ledger. Paused valid in-flight read results may finish; cancelled late
results only account observed usage, never publish views or start another phase.

Reports have complete viewpoint indexes, a bounded fanout synthesis tree, source/span
maps, omitted units, unknown coverage and structural-only quality marking. `completed`
means the frozen units/structural checks finished, not “all true author views guaranteed”.
`snapshotReport` exposes partial stage data without new model calls. Report storage is
separate: `ReportSink.apply` uses effectId as recipient idempotency key; pending/uncertain
effects after a crash require observed reconciliation, not blind replay. Preserve user
data when rolling back program files.

## Verification

Run from candidate: `node scripts/test-agent-analysis.cjs`.
`--quick` skips ONLY the 100×20 large fixture and is not full acceptance.
Synthetic JSON persistence/reload fixtures use uniquely named OS temporary directories,
never source folders. Supplemental transaction/evidence records live outside the
candidate, in the supporting output directory; do not create source-tree copies.
No real SDK process, model, external network, credential, user document or deployment
is exercised here. Actual Vault/App/UI/SDK integration and approved real small-fixture
quality comparisons are the main agent's separate gates.
