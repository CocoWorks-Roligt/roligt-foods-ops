# Probe results — 2026-09-22T13:27:27.705Z

base: dhorj90a2ded0152a4f1d94ae8ce4ece09a5c (scratch)

| check | ok | detail |
|---|---|---|
| upsert-by-name-criteria | yes | {"records":{"updated":[{"recordID":"XYLQCw","data":{"RsrjJQ":"PROBE VENDOR","IgaF2w":""},"display_data":{"RsrjJQ":"PROBE VENDOR","IgaF2w":""}}]},"stat |
| fetch-by-criteria | yes | {"records":{"fetched":[{"recordID":"XYLQCw","data":{"RsrjJQ":"PROBE VENDOR","IgaF2w":"","cTKTpQ":"","EuI4aQ":"","6Hsqrw":"","r1YVmw":"","LSi-4Q":"","1 |
| fetch-page-shape | yes | table Counters; page1 keys: ["fetched"]; page1 len: 2 |
| cursor-continuation | yes | page2 first: Hq_Ftw |
| large-query-payload | **NO** | HTTP 414 |
| large-query-payload-4k | yes | HTTP 200 |
| large-body-payload-json | **NO** | HTTP 400 {"error":{"code":400,"message":"BAD REQUEST"}} |
| large-body-payload-form | yes | HTTP 200 {"records":{"updated":[{"recordID":"XYLQCw","data":{"LSi-4Q":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |
| large-payload-roundtrip | yes | {"RsrjJQ":"PROBE VENDOR","IgaF2w":"","cTKTpQ":"","EuI4aQ":"","6Hsqrw":"","r1YVmw":"","LSi-4Q":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx |
| criteria-array-shape | **NO** | {"error":{"code":500,"message":"INTERNAL SERVER ERROR"}} |
| criteria-fieldid-string | yes | {"records":{"updated":[{"recordID":"XYLQCw","data":{"RsrjJQ":"PROBE VENDOR"},"display_data":{"RsrjJQ":"PROBE VENDOR"}}]},"status":"success","message": |
| phone-digits-persist | yes | write HTTP 200; read back: "9999900000" |

## Raw wire log (truncated bodies)

```json
[
  {
    "method": "GET",
    "path": "/api/v1/tables",
    "transport": "query",
    "status": 200,
    "body": "{\"tables\":{\"fetched\":[{\"tableID\":\"J8fAew\",\"name\":\"Vendor Types\",\"recordsCount\":2,\"fieldsCount\":5,\"isActiveTable\":true},{\"tableID\":\"S6mCPQ\",\"name\":\"Vendors\",\"recordsCount\":1,\"fieldsCount\":10,\"isActiveTable\":false},{\"tableID\":\"Eyis7A\",\"name\":\"Customers\",\"recordsCount\":0,\"fieldsCount\":11,\"isActiveTable\":false},{\"tableID\":\"wbQrEQ\",\"name\":\"Items\",\"recordsCount\":14,\"fieldsCount\":14,\"isActiveTable\":false"
  },
  {
    "method": "GET",
    "path": "/api/v1/fields",
    "transport": "query",
    "status": 200,
    "body": "{\"fields\":{\"fetched\":[{\"fieldID\":\"RsrjJQ\",\"name\":\"Name\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\":{\"textCase\":1}},{\"fieldID\":\"IgaF2w\",\"name\":\"Phone\",\"type\":\"17\",\"typeComponents\":{\"phoneNumberFormat\":\"xxxxxxxxxx\",\"multipleValueSupport\":0}},{\"fieldID\":\"cTKTpQ\",\"name\":\"Area\",\"type\":\"23\",\"defaultValue\":null,\"typeComponents\":{\"textCase\":1}},{\"fieldID\":\"EuI4aQ\",\"name\":\"Payment Terms\",\"type\":\"23\","
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"XYLQCw\",\"data\":{\"RsrjJQ\":\"PROBE VENDOR\",\"IgaF2w\":\"\"},\"display_data\":{\"RsrjJQ\":\"PROBE VENDOR\",\"IgaF2w\":\"\"}}]},\"status\":\"success\",\"message\":\"Record(s) Updated Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"XYLQCw\",\"data\":{\"RsrjJQ\":\"PROBE VENDOR\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\"},\"display_data\":{\"RsrjJQ\":\"PROBE VENDOR\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"\",\"1HpEPw\":\"\",\"wMDCTA\":\"\",\"lGwzHQ\":\"\"}}]},\"status\":\"success\",\"message\":\"Record(s) Fetched Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"s82v7A\",\"data\":{\"LsDPPA\":\"grn\",\"pRhS8w\":\"RFTC\",\"qP8tHA\":\"{P}{YYYY}{N}\",\"U8SH4g\":\"4\",\"FXa_pg\":\"1\"},\"display_data\":{\"LsDPPA\":\"grn\",\"pRhS8w\":\"RFTC\",\"qP8tHA\":\"{P}{YYYY}{N}\",\"U8SH4g\":\"4\",\"FXa_pg\":\"1\"}},{\"recordID\":\"t8rmkg\",\"data\":{\"LsDPPA\":\"lot\",\"pRhS8w\":\"LOT\",\"qP8tHA\":\"{P}-{YYYYMMDD}-{N}\",\"U8SH4g\":\"3\",\"FXa_pg\":\"1\"},\"display_data\":{\"LsDPPA\":\"lot\",\"pRhS8w\":\"LOT\",\"qP8t"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"Hq_Ftw\",\"data\":{\"LsDPPA\":\"batch\",\"pRhS8w\":\"BAT\",\"qP8tHA\":\"{P}-{YYYY}-{N}\",\"U8SH4g\":\"4\",\"FXa_pg\":\"1\"},\"display_data\":{\"LsDPPA\":\"batch\",\"pRhS8w\":\"BAT\",\"qP8tHA\":\"{P}-{YYYY}-{N}\",\"U8SH4g\":\"4\",\"FXa_pg\":\"1\"}},{\"recordID\":\"4fX8pg\",\"data\":{\"LsDPPA\":\"melangeBatch\",\"pRhS8w\":\"MEL\",\"qP8tHA\":\"{P}-{YYYY}-{N}\",\"U8SH4g\":\"4\",\"FXa_pg\":\"1\"},\"display_data\":{\"LsDPPA\":\"melangeBatch\","
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "query",
    "status": 414,
    "body": "<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n</body>\r\n</html>\r\n"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"XYLQCw\",\"data\":{\"LSi-4Q\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "json",
    "status": 400,
    "body": "{\"error\":{\"code\":400,\"message\":\"BAD REQUEST\"}}"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "form",
    "status": 200,
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"XYLQCw\",\"data\":{\"LSi-4Q\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"XYLQCw\",\"data\":{\"RsrjJQ\":\"PROBE VENDOR\",\"IgaF2w\":\"\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "query",
    "status": 200,
    "body": "{\"error\":{\"code\":500,\"message\":\"INTERNAL SERVER ERROR\"}}"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"XYLQCw\",\"data\":{\"RsrjJQ\":\"PROBE VENDOR\"},\"display_data\":{\"RsrjJQ\":\"PROBE VENDOR\"}}]},\"status\":\"success\",\"message\":\"Record(s) Updated Successfully\"}"
  },
  {
    "method": "PUT",
    "path": "/api/v1/records",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"updated\":[{\"recordID\":\"XYLQCw\",\"data\":{\"IgaF2w\":\"9999900000\"},\"display_data\":{\"IgaF2w\":\"9999900000\"}}]},\"status\":\"success\",\"message\":\"Record(s) Updated Successfully\"}"
  },
  {
    "method": "POST",
    "path": "/api/v1/fetchRecordsWithCriteria",
    "transport": "query",
    "status": 200,
    "body": "{\"records\":{\"fetched\":[{\"recordID\":\"XYLQCw\",\"data\":{\"RsrjJQ\":\"PROBE VENDOR\",\"IgaF2w\":\"9999900000\",\"cTKTpQ\":\"\",\"EuI4aQ\":\"\",\"6Hsqrw\":\"\",\"r1YVmw\":\"\",\"LSi-4Q\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
]
```

## Raw first-record shape (PROBE VENDOR after large-payload roundtrip)

```json
{
  "recordID": "XYLQCw",
  "data": {
    "RsrjJQ": "PROBE VENDOR",
    "IgaF2w": "",
    "cTKTpQ": "",
    "EuI4aQ": "",
    "6Hsqrw": "",
    "r1YVmw": "",
    "LSi-4Q": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
