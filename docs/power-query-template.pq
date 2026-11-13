// Power Query (M) template — one-way push: Excel -> Casa Pueblo database.
//
// It READS the three tabs of the workbook and POSTs their rows as JSON to
// /api/sync/excel. It never writes to the workbook. Start with DryRun = true:
// the response then lists what WOULD change without touching the database.
//
// Setup (Excel > Data > Get Data > Launch Power Query Editor > New Source > Blank Query > Advanced Editor):
//   1. Paste this file and set SiteUrl and SyncToken below.
//      SyncToken is the value stored with `npx wrangler secret put SYNC_TOKEN`.
//   2. When asked for credentials for SiteUrl choose "Anonymous" (the token travels in the header).
//   3. Refresh the query to run a sync.
//
// STATUS: template, not yet run from inside Excel. The server side has been verified
// against Mapeo Inicial_CP2.xlsx through scripts/sync-excel.mjs, which is the
// supported way to load the workbook today (`npm run sync:excel`).
// Column headers are matched on the server (src/lib/excel-sync/normalizer.ts),
// so renaming a column only requires adding an alias there.
let
    SiteUrl   = "https://YOUR-WORKER.workers.dev",
    SyncToken = "PASTE-THE-SYNC-TOKEN-HERE",
    DryRun    = true,
    SheetNames = {"Puerto Rico", "América Latina", "Otros"},

    // Rows of one tab as records keyed by the header row. Missing tabs are skipped.
    SheetRows = (sheetName as text) as list =>
        let
            Source   = Excel.CurrentWorkbook(),
            // Excel.CurrentWorkbook() exposes Tables and named ranges. Format each tab as a
            // Table (Ctrl+T) named exactly like the tab, or define a named range with that name.
            Match    = Table.SelectRows(Source, each [Name] = sheetName),
            Content  = if Table.RowCount(Match) = 0 then #table({}, {}) else Match{0}[Content],
            Promoted = if List.Contains(Table.ColumnNames(Content), "Column1")
                       then Table.PromoteHeaders(Content, [PromoteAllScalars = true])
                       else Content,
            AsText   = Table.TransformColumnTypes(Promoted, List.Transform(Table.ColumnNames(Promoted), each {_, type text}), "en-US")
        in
            Table.ToRecords(AsText),

    Payload = [
        dry_run = DryRun,
        sheets  = List.Transform(SheetNames, each [name = _, rows = SheetRows(_)])
    ],

    Response = Web.Contents(
        SiteUrl,
        [
            RelativePath = "api/sync/excel",
            Headers = [#"Content-Type" = "application/json", Authorization = "Bearer " & SyncToken],
            Content = Json.FromValue(Payload),   // supplying Content makes this a POST
            ManualStatusHandling = {400, 401, 403, 500, 502}
        ]
    ),
    Result = Json.Document(Response),

    // One line per workbook row with the server's decision:
    // new_from_excel | unchanged | updated_in_excel | conflict_both_modified
    Rows = if Record.HasFields(Result, "rows")
           then Table.FromRecords(Result[rows])
           else #table({"error"}, {{Record.FieldOrDefault(Result, "error", "Respuesta inesperada")}})
in
    Rows
