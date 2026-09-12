# Retained publication comparison measurements

11 September 2026. Derived from [summary.json](summary.json) and the raw reports/logs listed in [README.md](README.md). `single` is the current public format; `grouped` is the isolated alternative. U is the full→unchanged history; C is the independent full→changed history. Every row retains the original 1,001 Products and 4,006 public records. MB is decimal. These are emulator measurements, not production performance or billing.

## Phase time

Seconds. Candidate includes collection, candidate construction, native callbacks and inspection. Private and public are disjoint callback intervals. Switch/orchestration is the remaining publication driver time, including its status/control work; it is **not** isolated atomic SQL commit latency. Backup is inclusive of its detailed phases below. Consumer includes the original assertions plus the extra complete catalogue pass. Other is the residual measured journey time. The inclusive publication+backup interval is in the JSON and must not be added to these columns.

| Run                 | Candidate | Private | Public | Switch/orchestration | Backup incl. | Consumer | Other | Total   |
| ------------------- | --------- | ------- | ------ | -------------------- | ------------ | -------- | ----- | ------- |
| single U/full       | 8.486     | 24.801  | 13.475 | 0.149                | 16.649       | 11.492   | 0.213 | 75.265  |
| single U/unchanged  | 49.103    | 29.850  | 0.000  | 0.130                | 39.057       | 12.367   | 0.235 | 130.742 |
| single C/full       | 9.986     | 28.421  | 20.167 | 0.311                | 25.786       | 12.088   | 0.211 | 96.970  |
| single C/changed    | 47.116    | 23.473  | 11.197 | 0.194                | 39.268       | 12.479   | 0.210 | 133.937 |
| grouped U/full      | 8.351     | 29.357  | 17.191 | 0.179                | 15.290       | 3.647    | 0.140 | 74.155  |
| grouped U/unchanged | 44.280    | 21.881  | 0.000  | 0.087                | 39.211       | 4.061    | 0.161 | 109.681 |
| grouped C/full      | 9.687     | 27.894  | 17.901 | 0.209                | 16.078       | 3.889    | 0.144 | 75.802  |
| grouped C/changed   | 46.418    | 24.083  | 16.837 | 0.197                | 41.341       | 4.248    | 0.156 | 133.280 |

## Storage requests, database work and bytes read

Totals cover the measured journey, including verification and its intentionally repeated consumer passes. D1 calls count binding entries; a batch call can contain many statements. SQL statements count every submitted statement within a batch. Rows are returned emulator metadata, not independently audited index operations. The separate host restore database is reported below. Object census/migrations are outside this interval. Zero application LIST/DELETE requests were observed; inventory LIST requests are excluded. PUT outcomes are a subdivision of PUT attempts and must not be added to them.

| Run                 | GET    | HEAD   | PUT attempts | PUT acknowledged | Conditional reuse | D1 calls | D1 statements | Rows read  | Rows written |
| ------------------- | ------ | ------ | ------------ | ---------------- | ----------------- | -------- | ------------- | ---------- | ------------ |
| single U/full       | 51,451 | 754    | 17,712       | 17,712           | 0                 | 87,166   | 196,769       | 61,087,834 | 450,728      |
| single U/unchanged  | 60,619 | 11,603 | 2,268        | 2,268            | 0                 | 194,471  | 384,587       | 52,245,437 | 354,722      |
| single C/full       | 51,451 | 754    | 17,712       | 17,712           | 0                 | 87,166   | 196,769       | 61,087,834 | 450,728      |
| single C/changed    | 51,451 | 11,667 | 4,538        | 4,473            | 65                | 211,421  | 410,622       | 76,568,697 | 406,180      |
| grouped U/full      | 35,338 | 754    | 14,915       | 14,915           | 0                 | 70,769   | 159,339       | 38,962,363 | 407,393      |
| grouped U/unchanged | 47,303 | 11,603 | 2,268        | 2,268            | 0                 | 178,626  | 349,675       | 25,529,841 | 354,722      |
| grouped C/full      | 35,338 | 754    | 14,915       | 14,915           | 0                 | 70,769   | 159,339       | 38,962,363 | 407,393      |
| grouped C/changed   | 35,338 | 11,645 | 3,058        | 3,015            | 43                | 194,090  | 371,822       | 54,399,128 | 378,715      |

| Run                 | GET object-body sizes MB | HEAD declared sizes MB | One full consumer GETs | One full consumer SQL statements | Full compressed MB | Changed-object download MB |
| ------------------- | ------------------------ | ---------------------- | ---------------------- | -------------------------------- | ------------------ | -------------------------- |
| single U/full       | 278.439                  | 162.476                | 5,008                  | 21,034                           | 8.854              | 8.854                      |
| single U/unchanged  | 539.024                  | 431.590                | 5,008                  | 21,034                           | 8.854              | 0.000                      |
| single C/full       | 278.439                  | 162.476                | 5,008                  | 21,034                           | 8.854              | 8.854                      |
| single C/changed    | 534.683                  | 439.699                | 5,008                  | 21,034                           | 8.931              | 4.588                      |
| grouped U/full      | 266.739                  | 158.445                | 1,723                  | 7,237                            | 8.226              | 8.226                      |
| grouped U/unchanged | 529.749                  | 427.558                | 1,723                  | 7,237                            | 8.226              | 0.000                      |
| grouped C/full      | 266.739                  | 158.445                | 1,723                  | 7,237                            | 8.226              | 8.226                      |
| grouped C/changed   | 519.645                  | 432.313                | 1,723                  | 7,237                            | 8.253              | 4.123                      |

GET object sizes are returned body-object sizes, not a wire capture or proof every returned stream was consumed. HEAD values describe existing objects and are not transferred bodies. Consumer bytes are actually read/hashed/decompressed. Changed-object bytes assume a consumer retains predecessor component bodies; manifests/metadata and HTTP overhead are not included. All HTTP paths and provider calls are retained in the JSON; the export/import API control plane is simulated while its SQL content/export/import is real.

## Files and retained state

New/reused component counts are relative to the immediate predecessor, not a claim that every absent digest has never existed historically. Physical storage is separately counted by successful PUTs and retained inventory. Private objects below are the full `publication-artifacts` class, including composition/export nodes. Backups include SQL plus small backup metadata. Retention is a snapshot after each journey, not byte-months. No cleanup/expiry is simulated.

| Run                 | Current files | New   | Reused | Retained public files | Public MB | Private-class files | Private MB | Evidence MB | D1 MB   | Backup MB |
| ------------------- | ------------- | ----- | ------ | --------------------- | --------- | ------------------- | ---------- | ----------- | ------- | --------- |
| single U/full       | 4,006         | 4,006 | 0      | 4,006                 | 8.854     | 13,701              | 26.448     | 8.710       | 211.280 | 162.498   |
| single U/unchanged  | 4,006         | 0     | 4,006  | 4,006                 | 8.854     | 15,965              | 29.517     | 17.419      | 509.714 | 573.471   |
| single C/full       | 4,006         | 4,006 | 0      | 4,006                 | 8.854     | 13,701              | 26.448     | 8.710       | 211.288 | 162.498   |
| single C/changed    | 4,006         | 2,002 | 2,004  | 6,008                 | 13.442    | 16,167              | 31.569     | 17.419      | 520.987 | 580.891   |
| grouped U/full      | 1,378         | 1,378 | 0      | 1,378                 | 8.226     | 13,532              | 24.651     | 8.710       | 203.522 | 158.467   |
| grouped U/unchanged | 1,378         | 0     | 1,378  | 1,378                 | 8.226     | 15,796              | 27.719     | 17.419      | 501.932 | 565.408   |
| grouped C/full      | 1,378         | 1,378 | 0      | 1,378                 | 8.226     | 13,532              | 24.651     | 8.710       | 203.391 | 158.467   |
| grouped C/changed   | 1,378         | 691   | 687    | 2,069                 | 12.349    | 15,851              | 28.220     | 17.419      | 507.752 | 569.720   |

All source observations/snapshots, manifest bytes and per-table row inventories are available in the JSON. The first full singleton/grouped publication has 13,701/13,532 private-class objects. Every no-change acceptance adds 2,264 more despite creating zero public component objects. D1 per-table byte attribution was not available; row counts alone cannot assign the database growth to individual tables.

## Backup, actual SQL import and restored verification

| Run                 | Snapshot s | Artifacts s | SQL export s | Target s | SQL import phase s | Restored verify s | Other backup s | SQL MB  | Dump statements | Host import s | Restored DB MB |
| ------------------- | ---------- | ----------- | ------------ | -------- | ------------------ | ----------------- | -------------- | ------- | --------------- | ------------- | -------------- |
| single U/full       | 4.368      | 3.621       | 2.039        | 0.004    | 0.985              | 3.692             | 1.940          | 162.476 | 102,902         | 0.675         | 205.558        |
| single U/unchanged  | 8.261      | 6.656       | 6.525        | 0.055    | 2.676              | 9.724             | 5.160          | 410.951 | 192,638         | 1.558         | 499.339        |
| single C/full       | 11.236     | 4.714       | 2.465        | 0.168    | 0.957              | 4.364             | 1.882          | 162.476 | 102,902         | 0.649         | 205.500        |
| single C/changed    | 8.928      | 4.788       | 7.022        | 0.063    | 2.907              | 9.735             | 5.825          | 418.371 | 203,916         | 1.759         | 510.276        |
| grouped U/full      | 3.885      | 2.938       | 2.079        | 0.002    | 0.949              | 3.578             | 1.859          | 158.444 | 94,927          | 0.611         | 198.345        |
| grouped U/unchanged | 8.667      | 6.620       | 6.662        | 0.072    | 2.803              | 9.400             | 4.987          | 406.920 | 184,663         | 1.630         | 492.143        |
| grouped C/full      | 3.166      | 3.897       | 2.427        | 0.139    | 0.892              | 3.609             | 1.948          | 158.444 | 94,927          | 0.569         | 198.357        |
| grouped C/changed   | 8.760      | 4.093       | 6.598        | 0.051    | 2.904              | 13.671            | 5.264          | 411.231 | 190,622         | 1.768         | 497.971        |

The SQL import phase includes upload/provider coordination; host import is nested inside it, not additional time. Every import above had zero foreign-key errors and passed the production restored-content proof. Across four checkpoints, singleton restored verification issued 5,707 real SQLite query calls returning 571,924 rows; grouped issued 5,415 returning 534,705 rows. Those host queries and SQL dump statements are separate from wrapped application D1 totals. Raw query logs allow attribution by checkpoint.

## Callback and interruption work

| Run                 | Native candidate callbacks | Private callbacks | Public callbacks |
| ------------------- | -------------------------- | ----------------- | ---------------- |
| single U/full       | 986                        | 2,007             | 1,265            |
| single U/unchanged  | 9,571                      | 2,304             | 0                |
| single C/full       | 986                        | 2,007             | 1,265            |
| single C/changed    | 9,571                      | 2,304             | 1,265            |
| grouped U/full      | 986                        | 2,007             | 1,473            |
| grouped U/unchanged | 9,571                      | 2,304             | 0                |
| grouped C/full      | 986                        | 2,007             | 1,473            |
| grouped C/changed   | 9,571                      | 2,304             | 1,473            |

Callbacks are controlled driver executions of production functions, not billed Workflow steps or CPU. The repeated native candidate scenario uses predecessor/history work; it is distinct from the original fresh-candidate 15-second assertion. Callback `max_calls` in the raw report excludes nested backup phase counters and cannot certify the entire backup callback guard.

| Layout  | Unit             | ms  | SQL statements | Rows read | Rows written | PUT | PUT success | Conditional reuse | GET | HEAD |
| ------- | ---------------- | --- | -------------- | --------- | ------------ | --- | ----------- | ----------------- | --- | ---- |
| single  | failed-unit      | 17  | 16             | 3171      | 47           | 4   | 4           | 0                 | 0   | 0    |
| single  | retried-unit     | 9   | 27             | 3212      | 64           | 4   | 0           | 4                 | 4   | 4    |
| single  | committed-replay | 0   | 3              | 11        | 2            | 0   | 0           | 0                 | 0   | 0    |
| grouped | failed-unit      | 7   | 10             | 1576      | 11           | 1   | 1           | 0                 | 0   | 0    |
| grouped | retried-unit     | 5   | 16             | 1602      | 25           | 1   | 0           | 1                 | 1   | 1    |
| grouped | committed-replay | 1   | 3              | 11        | 2            | 0   | 0           | 0                 | 0   | 0    |

The 64-Product probe loses a successful public PUT response before the unit receipt/cursor commits, retries that same unit, then repeats its committed result. Both completed with exact semantic replay, full consumer verification and real backup/restore. The grouped fixture has groups of up to three records overall, but its first interrupted group is not a maximum-size-group proof. No claim of platform termination, all-phase recovery, or reduced worst-case retry work follows from this one fault point.

## Host memory and measurement limits

| Layout process | Whole process elapsed s | Peak process-tree RSS GiB | Peak workerd-process RSS GiB | 1-second samples |
| -------------- | ----------------------- | ------------------------- | ---------------------------- | ---------------- |
| single         | 448.814                 | 4.704                     | 3.906                        | 436              |
| grouped        | 404.565                 | 4.514                     | 4.321                        | 392              |

Whole process time includes two independent histories, setup, census and cleanup. Sampled RSS is a sum across descendant processes and may share pages; it includes retained local storage, SQL transport and complete-catalogue test buffers. It cannot measure production isolate peak working set, active CPU, platform network latency, retained Workflow state pricing or a bill. There are no production measurements in this experiment.
