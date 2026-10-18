# Ledgerly quickstart

Ledgerly is a small ledger API. Every request is authenticated with your API key.

## 1. Send your API key

Pass your key in the `x-api-key` header on every request:

```sh
curl -H "x-api-key: $LEDGERLY_KEY" https://api.ledgerly.test/v1/entries
```

## 2. Create an entry

```sh
curl -X POST https://api.ledgerly.test/v1/entries \
  -H "x-api-key: $LEDGERLY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"memo":"Coffee","amount_cents":450}'
```

Entries are returned as JSON. Amounts are integers in cents.
