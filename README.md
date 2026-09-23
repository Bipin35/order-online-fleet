# order-online-fleet

Reads Google Maps' "Order online" picker for a list of place ids, one shard per
runner, and uploads the JSONL as a build artifact. No credentials, no database.
Dispatch: Actions -> order-online -> Run workflow. Download: `gh run download <run-id>`.
