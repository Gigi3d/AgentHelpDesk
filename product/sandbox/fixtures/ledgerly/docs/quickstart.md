# Ledgerly quickstart (fixture copy — seeded with demo failure #1)

Authenticate every request with your API key in the `x-api-key` header:

```sh
curl -H "x-api-key: $LEDGERLY_KEY" https://api.ledgerly.test/v1/entries
```

> Seeded-wrong on purpose: the API actually expects
> `Authorization: Bearer $LEDGERLY_KEY` and answers 401 to `x-api-key`.
> The resolver "fixes" failure #1 by overwriting this file, which clears the
> FakeRunner broken flag (see sandbox/fake.ts). Placeholder key names only —
> no secrets in fixtures.
