# fetchSince probe results — 2026-09-30T07:21:52.171Z

base: dhorj90a2ded0152a4f1d94ae8ce4ece09a5c (scratch); table Ledger (r17sKQ); Time field Qz8axw

Time column: wrote `2026-09-30T07:00:00.000Z`, read back `"2026/09/30 07:00:00"`

| check | ok | detail |
|---|---|---|
| ledger-time-field | yes | field Time (Qz8axw), type "7" |
| write-probe-row-PROBE-SINCE-1 | yes | HTTP 200 {"records":{"created":[{"recordID":"Izrh0Q","data":{"G1BQmA":"","zCwGbA":"","oMdXSQ":"","f8llFQ":"","aCdjfg":"","29Flrg" |
| write-probe-row-PROBE-SINCE-2 | yes | HTTP 200 {"records":{"created":[{"recordID":"IQbxdA","data":{"G1BQmA":"","zCwGbA":"","oMdXSQ":"","f8llFQ":"","aCdjfg":"","29Flrg" |
| time-roundtrip-shape | yes | read-back: "2026/09/30 07:00:00" |
| since-fieldid-ge-filters | **NO** | HTTP 200; probe rows matched: []; body head: {"error":{"code":500,"message":"INTERNAL SERVER ERROR"}} |
| since-inclusive-at-watermark | **NO** | matched: [] |
| since-fieldname-ge | **NO** | HTTP 200; matched: [] |
| since-normalized-watermark | **NO** | watermark "2026/09/30 07:00:00"; matched: [] |
| cleanup-PROBE-SINCE-1 | yes | HTTP 200 |
| cleanup-PROBE-SINCE-2 | yes | HTTP 200 |

## Raw wire log

```json
[
  {
    "method": "GET",
    "path": "/api/v1/tables?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c",
    "status": 200,
    "body": "{\"tables\":{\"fetched\":[{\"tableID\":\"J8fAew\",\"name\":\"Vendor Types\",\"recordsCount\":0,\"fieldsCount\":7,\"isActiveTable\":true},{\"tableID\":\"S6mCPQ\",\"name\":\"Vendors\",\"recordsCount\":0,\"fieldsCount\":12,\"isActiveTable\":false},{\"tableID\":\"Eyis7A\",\"name\":\"Customers\",\"recordsCount\":0,\"fieldsCount\":13,\"isActiveTable"
  },
  {
    "method": "GET",
    "path": "/api/v1/fields?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ",
    "status": 200,
    "body": "{\"fields\":{\"fetched\":[{\"fieldID\":\"G1BQmA\",\"name\":\"Doc\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\":{\"textCase\":1}},{\"fieldID\":\"zCwGbA\",\"name\":\"Type\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\":{\"textCase\":1}},{\"fieldID\":\"oMdXSQ\",\"name\":\"Lot\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\""
  },
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22PROBE-SINCE-1%22%2C%22Qz8axw%22%3A%222026-09-30T07%3A00%3A00.000Z%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22PROBE-SINCE-2026-09-30T07%3A00%3A00.000Z%5C%22%2C%5C%22type%5C%22%3A%5C%22PROBE%5C%22%2C%5C%22doc",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"Izrh0Q\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE-2026-09-30T07:00:00.000Z\\\",\\\"type\\\":\\\"PROBE\\\",\\\"doc\\\":\\\"PROBE-SINCE-1\\\",\\\"time\\\":\\\"2026-0"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22PROBE-SINCE-2%22%2C%22Qz8axw%22%3A%222026-09-30T08%3A00%3A00.000Z%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22PROBE-SINCE-2026-09-30T08%3A00%3A00.000Z%5C%22%2C%5C%22type%5C%22%3A%5C%22PROBE%5C%22%2C%5C%22doc",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"IQbxdA\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 08:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE-2026-09-30T08:00:00.000Z\\\",\\\"type\\\":\\\"PROBE\\\",\\\"doc\\\":\\\"PROBE-SINCE-1\\\",\\\"time\\\":\\\"2026-0"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-SINCE-1%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"Izrh0Q\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE-2026-09-30T07:00:00.000Z\\\",\\\"type\\\":\\\"PROBE\\\",\\\"doc\\\":\\\"PROBE-SINCE-1\\\",\\\"time\\\":\\\"2026-0"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22Qz8axw%22+%3E%3D+%222026-09-30T07%3A30%3A00.000Z%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22Qz8axw%22+%3E%3D+%222026-09-30T08%3A00%3A00.000Z%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22Time%22+%3E%3D+%222026-09-30T07%3A30%3A00.000Z%22&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22Qz8axw%22+%3E%3D+%222026%2F09%2F30+07%3A00%3A00%22&is_ids_used_in_params=true&count=200",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-SINCE-1%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"Izrh0Q\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE-2026-09-30T07:00:00.000Z\\\",\\\"type\\\":\\\"PROBE\\\",\\\"doc\\\":\\\"PROBE-SINCE-1\\\",\\\"time\\\":\\\"2026-0"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=Izrh0Q",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"Izrh0Q\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-SINCE-2%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"IQbxdA\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 08:00:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-SINCE-2026-09-30T08:00:00.000Z\\\",\\\"type\\\":\\\"PROBE\\\",\\\"doc\\\":\\\"PROBE-SINCE-1\\\",\\\"time\\\":\\\"2026-0"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=IQbxdA",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"IQbxdA\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  }
]
```
