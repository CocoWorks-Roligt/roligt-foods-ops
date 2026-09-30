# fetchSince probe round 3 (App-ID watermark) — 2026-09-30T07:36:47.590Z

base: dhorj90a2ded0152a4f1d94ae8ce4ece09a5c (scratch)

| check | ok | detail |
|---|---|---|
| cleanup-stray | yes | stray ensured present for delete below |
| stray-deleted | yes | HTTP 200 |
| write-old | yes | LEDAAAA0000PROBE |
| write-new | yes | LEDZZZZ9999PROBE |
| appid-ge-filters | **NO** | HTTP 200; matched []{"code":500,"message":"INTERNAL SERVER ERROR"} |
| appid-ge-inclusive | **NO** | matched []{"code":500,"message":"INTERNAL SERVER ERROR"} |
| bogus-field-is-loud | yes | HTTP 200 {"code":500,"message":"INTERNAL SERVER ERROR"} |
| date-eq-normalized | **NO** | matched [] |
| cleanup-LEDAAAA0 | yes | HTTP 200 |
| cleanup-LEDZZZZ9 | yes | HTTP 200 |

## Raw wire log

```json
[
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22PROBE-SINCE2-1%22%2C%22Qz8axw%22%3A%222026-09-30T07%3A00%3A00.000Z%22%2C%22G1BQmA%22%3A%22PROBE-DOC-A%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22PROBE-SINCE2-1%5C%22%2C%5C%22time%5C%22%3A%5C%222026-09-30T07",
    "status": 200,
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"BDOG_Q\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"wvjocA\":\"PROBE-SINCE2-1\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE2-1\\\",\\\"time\\\":\\\"2026-09-30T07:00:00.000Z\\\"}\"},\"display_data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"wvjocA\":\"PROBE-SINCE2-1\",\"Qz8axw\":\"2026/09/30 07:0"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-SINCE2-1%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"BDOG_Q\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE2-1\\\",\\\"time\\\":\\\"2026-09-30T07:00:00.000Z\\\"}\",\"TyckWw\":\"\",\"oBEz6w\":\"\",\"wvjocA\":"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=BDOG_Q",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"BDOG_Q\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22LEDAAAA0000PROBE%22%2C%22Qz8axw%22%3A%222026-09-30T07%3A00%3A00.000Z%22%2C%22G1BQmA%22%3A%22PROBE-DOC-A%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22LEDAAAA0000PROBE%5C%22%2C%5C%22time%5C%22%3A%5C%222026-09-3",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"czoA6A\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"LEDAAAA0000PROBE\\\",\\\"time\\\":\\\"2026-09-30T07:00:00.000Z\\\"}\",\"TyckWw\":\"\",\"oBEz6w\":\"\",\"wvjocA"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22LEDZZZZ9999PROBE%22%2C%22Qz8axw%22%3A%222026-09-30T09%3A00%3A00.000Z%22%2C%22G1BQmA%22%3A%22PROBE-DOC-A%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22LEDZZZZ9999PROBE%5C%22%2C%5C%22time%5C%22%3A%5C%222026-09-3",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"5da1YA\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 09:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"LEDZZZZ9999PROBE\\\",\\\"time\\\":\\\"2026-09-30T09:00:00.000Z\\\"}\",\"TyckWw\":\"\",\"oBEz6w\":\"\",\"wvjocA"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3E%3D+%22LEDMMMMwatermark%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3E%3D+%22LEDZZZZ9999PROBE%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22QQQQQQ%22+%3E%3D+%22LEDMMMMwatermark%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22Qz8axw%22+%3D+%222026%2F09%2F30+07%3A00%3A00%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"czoA6A\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"LEDAAAA0000PROBE\\\",\\\"time\\\":\\\"2026-09-30T07:00:00.000Z\\\"}\",\"TyckWw\":\"\",\"oBEz6w\":\"\",\"wvjocA"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22LEDAAAA0000PROBE%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"czoA6A\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"LEDAAAA0000PROBE\\\",\\\"time\\\":\\\"2026-09-30T07:00:00.000Z\\\"}\",\"TyckWw\":\"\",\"oBEz6w\":\"\",\"wvjocA"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=czoA6A",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"czoA6A\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22LEDZZZZ9999PROBE%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"5da1YA\",\"data\":{\"G1BQmA\":\"PROBE-DOC-A\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 09:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"LEDZZZZ9999PROBE\\\",\\\"time\\\":\\\"2026-09-30T09:00:00.000Z\\\"}\",\"TyckWw\":\"\",\"oBEz6w\":\"\",\"wvjocA"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=5da1YA",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"5da1YA\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  }
]
```
