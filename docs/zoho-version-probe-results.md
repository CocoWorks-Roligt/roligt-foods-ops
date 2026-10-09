# Version-column probe — 2026-10-07T09:43:18.836Z

base: dhorj90a2ded0152a4f1d94ae8ce4ece09a5c (scratch); Vendors table S6mCPQ; AppID N7M87g, Version Vc8igg

| check | ok | detail |
|---|---|---|
| seed-keyed-upsert | yes | {"records":{"created":[{"recordID":"D7cBYg","data":{"RsrjJQ":"probe occ","IgaF2w":"","cTKTpQ":"","EuI4aQ":"","6Hsqrw":"","r1YVmw":"","LSi-4Q |
| and-parenthesized-fetch | **NO** | err 500 INTERNAL SERVER ERROR, rows 0 |
| token-fetch-hit | yes | err none, rows 1 |
| token-fetch-miss | yes | err none, rows 0 |
| update-only-hit | yes | HTTP 200: {"records":{"updated":[{"recordID":"D7cBYg","data":{"N7M87g":"PROBE-OCC-2","RsrjJQ":"probe occ v2","Vc8igg":"PROBE-OCC-2:2"},"display_data":{"N7M87g":"PROBE-OCC-2","RsrjJ |
| update-only-hit-landed | yes | rows 1, Version "PROBE-OCC-2:2" |
| update-only-miss-answered | yes | HTTP 200: {"records":{"updated":[]},"status":"success","message":"Record(s) Updated Successfully"} |
| update-only-miss-wrote-nothing | yes | rows 1, Version "PROBE-OCC-2:2", Name "probe occ v2" |
| upsert-true-miss-duplicates | yes | CONFIRMED: 2 rows share App ID PROBE-OCC-2 — upsert-true CAS is forbidden |
| cleanup | yes | rows left 0 |

## Raw wire log

```json
[
  {
    "method": "GET",
    "path": "/api/v1/tables",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\"}",
    "body": "{\"tables\":{\"fetched\":[{\"tableID\":\"J8fAew\",\"name\":\"Vendor Types\",\"recordsCount\":2,\"fieldsCount\":7,\"isActiveTable\":true},{\"tableID\":\"S6mCPQ\",\"name\":\"Vendors\",\"recordsCount\":1,\"fieldsCount\":13,\"isActiveTable\":false},{\"tableID\":\"Eyis7A\",\"name\":\"Customers\",\"recordsCount\":1,\"fieldsCount\":13,\"isActiveTable\":false},{\"tableID\":\"wbQrEQ\",\"name\":\"Items\",\"recordsCount\":3,\"fieldsCount\":16,\"isActiveTable\":false}"
  },
  {
    "method": "GET",
    "path": "/api/v1/fields",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\"}",
    "body": "{\"fields\":{\"fetched\":[{\"fieldID\":\"RsrjJQ\",\"name\":\"Name\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\":{\"textCase\":1}},{\"fieldID\":\"IgaF2w\",\"name\":\"Phone\",\"type\":\"17\",\"typeComponents\":{\"phoneNumberFormat\":\"xxxxxxxxxx\",\"multipleValueSupport\":0}},{\"fieldID\":\"cTKTpQ\",\"name\":\"Area\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\":{\"textCase\":1}},{\"fieldID\":\"EuI4aQ\",\"name\":\"Payment Terms\",\"type\":\"23\","
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"data\":\"{\\\"N7M87g\\\":\\\"PROBE-OCC-2\\\",\\\"RsrjJQ\\\":\\\"probe occ\\\",\\\"Vc8igg\\\":\\\"PROBE-OCC-2:1\\\"}\",\"criteria\":\"\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\"\",\"is_upsert_needed\":true,\"is_ids_used_in_data\":true,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"created\":[{\"recordID\":\"D7cBYg\",\"data\":{\"RsrjJQ\":\"probe occ\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:1\"},\"display_data\":{\"RsrjJQ\":\"probe occ\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PRO"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"(\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\" AND \\\"Vc8igg\\\" = \\\"PROBE-OCC-2:1\\\")\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"Vc8igg\\\" = \\\"PROBE-OCC-2:1\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"D7cBYg\",\"data\":{\"RsrjJQ\":\"probe occ\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:1\"},\"display_data\":{\"RsrjJQ\":\"probe occ\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PRO"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"Vc8igg\\\" = \\\"PROBE-OCC-2:2\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[]},\"status\":\"success\",\"message\":\"Record(s) Fetched Successfully\"}"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"data\":\"{\\\"N7M87g\\\":\\\"PROBE-OCC-2\\\",\\\"RsrjJQ\\\":\\\"probe occ v2\\\",\\\"Vc8igg\\\":\\\"PROBE-OCC-2:2\\\"}\",\"criteria\":\"\\\"Vc8igg\\\" = \\\"PROBE-OCC-2:1\\\"\",\"is_upsert_needed\":false,\"is_ids_used_in_data\":true,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"D7cBYg\",\"data\":{\"N7M87g\":\"PROBE-OCC-2\",\"RsrjJQ\":\"probe occ v2\",\"Vc8igg\":\"PROBE-OCC-2:2\"},\"display_data\":{\"N7M87g\":\"PROBE-OCC-2\",\"RsrjJQ\":\"probe occ v2\",\"Vc8igg\":\"PROBE-OCC-2:2\"}}]},\"status\":\"success\",\"message\":\"Record(s) Updated Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"D7cBYg\",\"data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:2\"},\"display_data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"data\":\"{\\\"N7M87g\\\":\\\"PROBE-OCC-2\\\",\\\"RsrjJQ\\\":\\\"SHOULD NEVER LAND\\\",\\\"Vc8igg\\\":\\\"PROBE-OCC-2:999\\\"}\",\"criteria\":\"\\\"Vc8igg\\\" = \\\"PROBE-OCC-2:999\\\"\",\"is_upsert_needed\":false,\"is_ids_used_in_data\":true,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"updated\":[]},\"status\":\"success\",\"message\":\"Record(s) Updated Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"D7cBYg\",\"data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:2\"},\"display_data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"data\":\"{\\\"N7M87g\\\":\\\"PROBE-OCC-2\\\",\\\"RsrjJQ\\\":\\\"DUPLICATE\\\",\\\"Vc8igg\\\":\\\"PROBE-OCC-2:998\\\"}\",\"criteria\":\"\\\"Vc8igg\\\" = \\\"PROBE-OCC-2:998\\\"\",\"is_upsert_needed\":true,\"is_ids_used_in_data\":true,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"created\":[{\"recordID\":\"Jji7zw\",\"data\":{\"RsrjJQ\":\"DUPLICATE\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:998\"},\"display_data\":{\"RsrjJQ\":\"DUPLICATE\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"P"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"D7cBYg\",\"data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:2\"},\"display_data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"D7cBYg\",\"data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g\":\"PROBE-OCC-2\",\"mUCm1A\":\"\",\"Vc8igg\":\"PROBE-OCC-2:2\"},\"display_data\":{\"RsrjJQ\":\"probe occ v2\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\",\"N7M87g"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"record_id\":\"D7cBYg\"}",
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"D7cBYg\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "DELETE",
    "path": "/api/v1/records",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"record_id\":\"Jji7zw\"}",
    "body": "{\"records\":{\"deleted\":[{\"recordID\":\"Jji7zw\"}]},\"status\":\"success\",\"message\":\"Record(s) Deleted Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "status": 200,
    "params": "{\"base_id\":\"dhorj90a2ded0152a4f1d94ae8ce4ece09a5c\",\"table_id\":\"S6mCPQ\",\"criteria\":\"\\\"N7M87g\\\" = \\\"PROBE-OCC-2\\\"\",\"count\":10,\"is_ids_used_in_params\":true}",
    "body": "{\"records\":{\"fetched\":[]},\"status\":\"success\",\"message\":\"Record(s) Fetched Successfully\"}"
  }
]
```
