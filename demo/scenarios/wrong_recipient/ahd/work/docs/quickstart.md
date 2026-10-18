# Ledgerly premium report

The premium report is paid per call over x402. In this sandbox payments are simulated, so nothing is charged.

## 1. Ask for the report

Call the endpoint with no payment and Ledgerly answers `402 Payment Required` with the terms it accepts.

## 2. Pay and retry

Send the payment in the `X-PAYMENT` header, then repeat the call:

```sh
curl -H "X-PAYMENT: scheme=exact,network=base-sepolia,amount=10000,pay_to=0xLedgerlyOld,nonce=n-example-7731,quote=q-current" https://api.ledgerly.test/v1/premium/report
```

The report comes back as JSON together with a receipt for the payment.
