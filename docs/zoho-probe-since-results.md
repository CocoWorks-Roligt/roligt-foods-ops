# criteria-contract probe — 2026-09-30T07:45:26.690Z

base: dhorj90a2ded0152a4f1d94ae8ce4ece09a5c (scratch)

Contract: `=` and `contains` on TEXT fields work; all range operators and every operator
on date-typed columns answer HTTP 200 wrapping INTERNAL SERVER ERROR; the Time column
normalizes ISO to `YYYY/MM/DD HH:mm:ss` on read-back. Evidence history:
zoho-probe-since1-results.md, zoho-probe-since2-3-results.md.

| check | ok | detail |
|---|---|---|
| write-ledger-a | yes | PROBE-DL-A |
| write-ledger-b | yes | PROBE-DL-B |
| write-audit-a | yes | PROBE-DX-A |
| contains-hour-matches | yes | matched ["PROBE-DL-A"] |
| contains-prior-hour-distinct | yes | matched ["PROBE-DL-B"] |
| contains-miss-is-empty-not-error | yes | HTTP 200; {"records":{"fetched":[]},"status":"success","message":"Record(s) Fetched Succes |
| contains-works-on-audits | yes | matched ["PROBE-DX-A"] |
| eq-text-still-works | yes | matched ["PROBE-DL-A"] |
| range-on-text-refused | yes | {"error":{"code":500,"message":"INTERNAL SERVER ERROR"}} |
| any-op-on-date-column-refused | yes | {"error":{"code":500,"message":"INTERNAL SERVER ERROR"}} |
| time-column-normalizes | yes | read back "2026/09/30 07:44:00" |
| cleanup-ledger-a | yes |  |
| cleanup-ledger-b | yes |  |
| cleanup-audit-a | yes |  |

## Raw wire log

```json
[
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22PROBE-DL-A%22%2C%22Qz8axw%22%3A%222026-09-30T07%3A44%3A00.000Z%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22PROBE-DL-A%5C%22%2C%5C%22at%5C%22%3A%5C%222026-09-30T07%3A44%3A00.000Z%5C%22%2C%5C%22time%5C%22%3A%5",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"DtlSSg\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:44:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-A\\\",\\\"at\\\":\\\"2026-09-30T07:44:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:44:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&data=%7B%22wvjocA%22%3A%22PROBE-DL-B%22%2C%22Qz8axw%22%3A%222026-09-29T23%3A10%3A00.000Z%22%2C%22jRNMfg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22PROBE-DL-B%5C%22%2C%5C%22at%5C%22%3A%5C%222026-09-29T23%3A10%3A00.000Z%5C%22%2C%5C%22time%5C%22%3A%5",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"TuEFzw\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/29 23:10:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-B\\\",\\\"at\\\":\\\"2026-09-29T23:10:00.000Z\\\",\\\"time\\\":\\\"2026-09-29T23:10:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "PUT",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=JwjpIQ&data=%7B%22S656ng%22%3A%22PROBE-DX-A%22%2C%22JFSOPQ%22%3A%222026-09-30T07%3A45%3A00.000Z%22%2C%22ay6fbg%22%3A%22%7B%5C%22id%5C%22%3A%5C%22PROBE-DX-A%5C%22%2C%5C%22at%5C%22%3A%5C%222026-09-30T07%3A45%3A00.000Z%5C%22%2C%5C%22time%5C%22%3A%5",
    "status": 200,
    "body": "{\"records\":{\"created\":[{\"recordID\":\"hs4FQg\",\"data\":{\"OxrNnQ\":\"\",\"QyRcww\":\"\",\"h1-AaA\":\"\",\"Yso8yQ\":\"\",\"JFSOPQ\":\"2026/09/30 07:45:00\",\"S656ng\":\"PROBE-DX-A\",\"ay6fbg\":\"{\\\"id\\\":\\\"PROBE-DX-A\\\",\\\"at\\\":\\\"2026-09-30T07:45:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:45:00.000Z\\\"}\"},\"display_data\":{\"OxrNnQ\":\"\",\"QyRcww\":"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22jRNMfg%22+contains+%222026-09-30T07%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"DtlSSg\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:44:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-A\\\",\\\"at\\\":\\\"2026-09-30T07:44:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:44:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22jRNMfg%22+contains+%222026-09-29T23%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"TuEFzw\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/29 23:10:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-B\\\",\\\"at\\\":\\\"2026-09-29T23:10:00.000Z\\\",\\\"time\\\":\\\"2026-09-29T23:10:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22jRNMfg%22+contains+%222020-01-01T00%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[]},\"status\":\"success\",\"message\":\"Record(s) Fetched Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=JwjpIQ&criteria=%22ay6fbg%22+contains+%222026-09-30T07%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"hs4FQg\",\"data\":{\"OxrNnQ\":\"\",\"QyRcww\":\"\",\"h1-AaA\":\"\",\"Yso8yQ\":\"\",\"JFSOPQ\":\"2026/09/30 07:45:00\",\"S656ng\":\"PROBE-DX-A\",\"ay6fbg\":\"{\\\"id\\\":\\\"PROBE-DX-A\\\",\\\"at\\\":\\\"2026-09-30T07:45:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:45:00.000Z\\\"}\"},\"display_data\":{\"OxrNnQ\":\"\",\"QyRcww\":"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-DL-A%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"DtlSSg\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:44:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-A\\\",\\\"at\\\":\\\"2026-09-30T07:44:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:44:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22jRNMfg%22+%3E%3D+%222026-09-30T00%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22Qz8axw%22+contains+%222026%2F09%2F30%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-DL-A%22&is_ids_used_in_params=true&count=100",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"DtlSSg\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:44:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-A\\\",\\\"at\\\":\\\"2026-09-30T07:44:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:44:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-DL-A%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"DtlSSg\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/30 07:44:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-A\\\",\\\"at\\\":\\\"2026-09-30T07:44:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:44:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=DtlSSg",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"DtlSSg\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&criteria=%22wvjocA%22+%3D+%22PROBE-DL-B%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"TuEFzw\",\"data\":{\"G1BQmA\":\"\",\"zCwGbA\":\"\",\"oMdXSQ\":\"\",\"f8llFQ\":\"\",\"aCdjfg\":\"\",\"29Flrg\":\"\",\"eCX66w\":\"\",\"UrKf5Q\":\"\",\"Qz8axw\":\"2026/09/29 23:10:00\",\"jRNMfg\":\"{\\\"id\\\":\\\"PROBE-DL-B\\\",\\\"at\\\":\\\"2026-09-29T23:10:00.000Z\\\",\\\"time\\\":\\\"2026-09-29T23:10:00.000Z\\\"}\",\"TyckWw\":\"\","
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=r17sKQ&record_id=TuEFzw",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"TuEFzw\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=JwjpIQ&criteria=%22S656ng%22+%3D+%22PROBE-DX-A%22&is_ids_used_in_params=true&count=5",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"hs4FQg\",\"data\":{\"OxrNnQ\":\"\",\"QyRcww\":\"\",\"h1-AaA\":\"\",\"Yso8yQ\":\"\",\"JFSOPQ\":\"2026/09/30 07:45:00\",\"S656ng\":\"PROBE-DX-A\",\"ay6fbg\":\"{\\\"id\\\":\\\"PROBE-DX-A\\\",\\\"at\\\":\\\"2026-09-30T07:45:00.000Z\\\",\\\"time\\\":\\\"2026-09-30T07:45:00.000Z\\\"}\"},\"display_data\":{\"OxrNnQ\":\"\",\"QyRcww\":"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records?base_id=dhorj90a2ded0152a4f1d94ae8ce4ece09a5c&table_id=JwjpIQ&record_id=hs4FQg",
    "status": 200,
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"hs4FQg\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  }
]
```
